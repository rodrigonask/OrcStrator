import { execFile } from 'child_process'
import path from 'path'
import crypto from 'crypto'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'

// ─────────────────────────────────────────────────────────────────────────────
// File-lock safety layer (deterministic — zero model tokens).
//
// A file is "locked" by the instance that has uncommitted edits to it. Locks come
// from two *per-instance* signals only:
//   1. Live Edit/Write tool_use blocks in the stream (authoritative — it's the
//      instance's own tool call).
//   2. A narrow git-diff around each Bash tool call (before vs. after that single
//      command), to catch Bash-side writes that bypass the Edit/Write tools.
// Locks are released when git reports the path clean again (e.g. committed).
//
// Why not a whole-turn `git status` diff? Instances share one working tree, so a
// turn-long window attributes *siblings'* writes (and untracked scratch/plan docs)
// to whoever's turn ends first — the dominant source of false-positive conflicts.
// We therefore (a) ignore untracked files entirely and (b) scope Bash attribution
// to the single command, and never steal a lock another live instance holds.
//
// When a *different* instance in the same working tree touches a locked file,
// its run is paused (process killed, resumable) and the chat gets a marker — but
// only after re-confirming the held file is still dirty (stale locks self-heal).
// "Ignore restrictions for 30 minutes" lifts enforcement globally.
// ─────────────────────────────────────────────────────────────────────────────

const IGNORE_WINDOW_MS = 30 * 60 * 1000
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

let ignoreUntil = 0
// Bash tool_use id → dirty snapshot taken just before that command ran, so its
// completion can attribute only the files *that* command changed.
const preBashDirty = new Map<string, { instanceId: string; cwd: string; before: Set<string> }>()

interface LockRow { id: string; instance_id: string; cwd: string; path: string; created_at: number }

function norm(p: string): string {
  return path.normalize(p).toLowerCase()
}

/**
 * Tracked-but-dirty absolute paths in `cwd`. Untracked (`??`) files are
 * deliberately excluded: they're plan docs / scratch / build output that any
 * instance may create, never return to "clean" on their own, and were the main
 * source of cross-instance false-positive locks. The conflict we guard against is
 * clobbering another instance's uncommitted edits to a *tracked* file.
 */
/**
 * Every git call this layer makes, in one place:
 *   - `--no-optional-locks` and GIT_OPTIONAL_LOCKS=0: a plain `git status` takes
 *     index.lock to refresh the index, and doing that in the background at the moment an
 *     agent runs `git add`/`git commit` made the agent's own command fail with
 *     "index.lock exists".
 *   - async: a synchronous git call on this path froze every chat's streaming.
 *   - a large maxBuffer: the default 1 MB overflowed on a big working tree and read as an error.
 * Resolves with stdout, or null when git failed or timed out.
 */
function git(cwd: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise(resolve => {
    execFile('git', ['--no-optional-locks', ...args], {
      cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

/**
 * Parse `git status --porcelain -z`. Without -z, git quotes and octal-escapes any
 * path with a non-ASCII character (`ação.ts` prints as `"a\303\247\303\243o.ts"`), which never
 * matched the real path, so a Portuguese-named file's lock was dropped as "clean". With -z
 * paths are raw and NUL-separated; a rename is `R  new\0old\0`.
 */
export function parsePorcelainZ(stdout: string): Array<{ xy: string; rel: string }> {
  const out: Array<{ xy: string; rel: string }> = []
  const parts = stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    out.push({ xy, rel: entry.slice(3) })
    if (xy.includes('R') || xy.includes('C')) i++ // skip the original path
  }
  return out
}

/** Tracked-dirty absolute paths, or null when git failed (callers must not read null as "clean"). */
function parseTracked(cwd: string, stdout: string): Set<string> {
  const files = new Set<string>()
  for (const { xy, rel } of parsePorcelainZ(stdout)) {
    if (xy === '??') continue // untracked — not lockable
    if (rel) files.add(norm(path.resolve(cwd, rel)))
  }
  return files
}

async function gitPorcelain(cwd: string): Promise<Set<string> | null> {
  const out = await git(cwd, ['status', '--porcelain', '-z'])
  return out === null ? null : parseTracked(cwd, out)
}

/** Is a single path still dirty (tracked-modified) right now? Used to re-validate a
 *  conflict before disrupting a sibling. On error, assume dirty (fail toward protection). */
async function isPathDirty(cwd: string, absolutePath: string): Promise<boolean> {
  const rel = path.relative(cwd, absolutePath) || absolutePath
  const out = await git(cwd, ['status', '--porcelain', '-z', '--', rel], 5_000)
  if (out === null) return true
  // untracked doesn't count as a real conflict
  return parsePorcelainZ(out).some(e => e.xy !== '??')
}

/**
 * All uncommitted paths in `cwd`, INCLUDING untracked (`??`) files. Returns null if
 * `cwd` is not a git repo (or git errored) so callers can distinguish "clean" from
 * "no repo". Unlike gitPorcelain (the lock layer), this DELIBERATELY counts untracked
 * files — for a *close* warning, a brand-new uncommitted file is real work you'd orphan.
 * Each entry keeps the original-case relative path (for display) plus its normalized
 * absolute form (for matching against the lock table).
 */
async function gitPorcelainAll(cwd: string): Promise<Array<{ rel: string; absNorm: string }> | null> {
  const stdout = await git(cwd, ['status', '--porcelain', '-z'])
  if (stdout === null) return null
  return parsePorcelainZ(stdout).filter(e => e.rel).map(e => ({ rel: e.rel, absNorm: norm(path.resolve(cwd, e.rel)) }))
}

export interface CloseGitStatus {
  /** false when cwd isn't a git repo — callers should treat this as "no warning". */
  isRepo: boolean
  total: number
  /** Files attributed to THIS instance via the lock table (it edited them this/last turn). */
  mine: string[]
  /** Other uncommitted files in the shared working tree (siblings, or pre-existing). */
  others: string[]
}

/**
 * Authoritative close-time git scan for an instance. Splits the working tree's
 * uncommitted files into those attributed to this instance (held locks) vs the rest.
 * The split matters because instances SHARE one working tree — "you have uncommitted
 * work" shouldn't blame this session for a sibling's edits.
 */
export async function getCloseGitStatus(cwd: string, instanceId: string): Promise<CloseGitStatus> {
  if (!cwd) return { isRepo: false, total: 0, mine: [], others: [] }
  const all = await gitPorcelainAll(cwd)
  if (all === null) return { isRepo: false, total: 0, mine: [], others: [] }
  const mineLocks = new Set(
    (db.prepare('SELECT path FROM file_locks WHERE instance_id = ?').all(instanceId) as Array<{ path: string }>).map(r => r.path)
  )
  const mine: string[] = []
  const others: string[] = []
  for (const f of all) {
    if (mineLocks.has(f.absNorm)) mine.push(f.rel)
    else others.push(f.rel)
  }
  return { isRepo: true, total: all.length, mine, others }
}

/**
 * Cheap per-instance uncommitted count straight from the lock table — zero git calls,
 * since the lock layer already maintains per-instance attribution. Tracked-modified
 * only (untracked files are never locked), which is fine for the always-on badge; the
 * close-time check (getCloseGitStatus) does the fuller untracked-inclusive scan.
 */
export function getInstanceDirtyCount(instanceId: string): number {
  try {
    const row = db.prepare('SELECT COUNT(*) c FROM file_locks WHERE instance_id = ?').get(instanceId) as { c: number }
    return row?.c ?? 0
  } catch {
    return 0
  }
}

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName)
}

export function extractFilePath(toolName: string, input: Record<string, unknown>): string | null {
  const p = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined
  return typeof p === 'string' && p.trim() ? p : null
}

export function setIgnoreWindow(): number {
  ignoreUntil = Date.now() + IGNORE_WINDOW_MS
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('conflictIgnoreUntil', ?)").run(JSON.stringify(ignoreUntil))
  } catch { /* non-critical */ }
  broadcastEvent({ type: 'conflict:ignore-updated', payload: { ignoreUntil } })
  return ignoreUntil
}

export function getIgnoreUntil(): number {
  return ignoreUntil
}

function addLock(instanceId: string, cwd: string, filePath: string): void {
  const absolute = norm(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath))
  const existing = db.prepare('SELECT id, instance_id FROM file_locks WHERE path = ?').get(absolute) as { id: string; instance_id: string } | undefined
  if (existing) {
    if (existing.instance_id !== instanceId) {
      // Ownership follows the most recent writer — the conflict (if enforced) was raised before this
      db.prepare('UPDATE file_locks SET instance_id = ?, created_at = ? WHERE id = ?').run(instanceId, Date.now(), existing.id)
    }
    return
  }
  db.prepare('INSERT INTO file_locks (id, instance_id, cwd, path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), instanceId, norm(cwd), absolute, Date.now())
}

/**
 * Claim a *git-discovered* dirty path (Bash window / boot) for this instance — but
 * unlike addLock, NEVER steal a lock another existing instance already holds: that's
 * their uncommitted work, and git can't prove this instance is the one that wrote it.
 * Only unlocked paths, or stale locks from deleted instances, are taken over.
 */
function claimDirty(instanceId: string, cwd: string, absolutePath: string): void {
  const existing = db.prepare('SELECT id, instance_id FROM file_locks WHERE path = ?').get(absolutePath) as { id: string; instance_id: string } | undefined
  if (existing) {
    if (existing.instance_id === instanceId) return
    const holderAlive = db.prepare('SELECT 1 FROM instances WHERE id = ?').get(existing.instance_id)
    if (holderAlive) return // sibling holds it — leave it be
    // Stale lock from a deleted instance — take it over.
    db.prepare('UPDATE file_locks SET instance_id = ?, cwd = ?, created_at = ? WHERE id = ?')
      .run(instanceId, norm(cwd), Date.now(), existing.id)
    return
  }
  db.prepare('INSERT INTO file_locks (id, instance_id, cwd, path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), instanceId, norm(cwd), absolutePath, Date.now())
}

export interface Conflict { holderInstanceId: string; holderName: string; path: string }

/** Record a live Edit/Write. Resolves with a conflict if another instance holds the file.
 *  Async only when a sibling holds a lock: the git re-check no longer blocks the server. */
export async function noteEdit(instanceId: string, cwd: string, filePath: string): Promise<Conflict | null> {
  const absolute = norm(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath))
  const lock = db.prepare('SELECT * FROM file_locks WHERE path = ?').get(absolute) as LockRow | undefined

  if (lock && lock.instance_id !== instanceId && Date.now() >= ignoreUntil) {
    const holder = db.prepare('SELECT name FROM instances WHERE id = ?').get(lock.instance_id) as { name: string } | undefined
    if (holder) {
      // Re-validate before disrupting a sibling: the lock is only real if the file is
      // STILL dirty. A stale lock (holder committed/reverted, or it was an attribution
      // artifact) is silently reclaimed rather than paused on.
      if (await isPathDirty(lock.cwd || cwd, absolute)) {
        return { holderInstanceId: lock.instance_id, holderName: holder.name, path: absolute }
      }
    }
    // Holder gone, or file no longer dirty — stale lock, drop it and take over.
    db.prepare('DELETE FROM file_locks WHERE id = ?').run(lock.id)
  }
  addLock(instanceId, cwd, filePath)
  return null
}

/** A Bash tool_use is about to run — snapshot tracked-dirty state so its completion
 *  can attribute only the files *this* command changed (a sub-second window, not the
 *  whole turn). Keyed by tool_use id so concurrent siblings never share a baseline. */
export async function snapshotPreBash(instanceId: string, toolUseId: string, cwd: string): Promise<void> {
  if (!cwd || !toolUseId) return
  try {
    const before = await gitPorcelain(cwd)
    // No baseline (git failed): claim nothing for this command rather than everything.
    if (before) preBashDirty.set(toolUseId, { instanceId, cwd, before })
  } catch { /* non-critical */ }
}

/** A Bash tool call completed — lock the files it newly dirtied to the instance that
 *  ran it. No-ops for non-Bash tools (their ids were never snapshotted). */
export async function onBashComplete(toolUseId: string): Promise<void> {
  const snap = preBashDirty.get(toolUseId)
  if (!snap) return
  preBashDirty.delete(toolUseId)
  try {
    const after = await gitPorcelain(snap.cwd)
    if (!after) return
    for (const p of after) {
      if (!snap.before.has(p)) claimDirty(snap.instanceId, snap.cwd, p)
    }
  } catch { /* non-critical */ }
}

/** Turn finished: release locks whose files are clean again (e.g. committed), and
 *  drop any pre-Bash snapshots left dangling by a killed/aborted turn. Crucially this
 *  no longer *creates* locks — attribution is per-edit and per-Bash-call only, so a
 *  sibling's writes can never be swept onto this instance at turn boundary. */
export async function onTurnEnd(instanceId: string, cwd: string): Promise<void> {
  for (const [tid, snap] of preBashDirty) {
    if (snap.instanceId === instanceId) preBashDirty.delete(tid)
  }
  if (!cwd) return
  try {
    releaseCleanLocks(norm(cwd), await gitPorcelain(cwd))
  } catch { /* non-critical */ }
}

/**
 * Release the locks in `cwdNorm` whose files git no longer reports dirty. `null` means git
 * failed or timed out, and then NOTHING is released: an empty set used to stand in
 * for an error, which read as "every file is clean" and dropped every lock without a word.
 */
function releaseCleanLocks(cwdNorm: string, dirtyNow: Set<string> | null): void {
  if (!dirtyNow) {
    console.warn(`[file-locks] git status failed in ${cwdNorm}; keeping its locks`)
    return
  }
  const locks = db.prepare('SELECT * FROM file_locks WHERE cwd = ?').all(cwdNorm) as LockRow[]
  for (const lock of locks) {
    if (!dirtyNow.has(lock.path)) {
      db.prepare('DELETE FROM file_locks WHERE id = ?').run(lock.id)
    }
  }
}

/** Sibling activity note for a fresh turn — commits + locked files since the instance last ran. */
export async function buildUpdateNote(instanceId: string, cwd: string, sinceTs: number | null): Promise<string | null> {
  if (!cwd) return null
  const lines: string[] = []
  const siblings = db.prepare(
    'SELECT fl.path, i.name FROM file_locks fl JOIN instances i ON i.id = fl.instance_id WHERE fl.cwd = ? AND fl.instance_id != ?'
  ).all(norm(cwd), instanceId) as Array<{ path: string; name: string }>
  if (siblings.length > 0) {
    const byName = new Map<string, string[]>()
    for (const s of siblings) {
      const rel = path.relative(cwd, s.path) || s.path
      const arr = byName.get(s.name) ?? []
      arr.push(rel)
      byName.set(s.name, arr)
    }
    for (const [name, files] of byName) {
      lines.push(`- Instance "${name}" has uncommitted edits to: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ` (+${files.length - 8} more)` : ''}`)
    }
  }
  if (sinceTs) {
    const out = await git(cwd, ['rev-list', '--count', `--since=${Math.floor(sinceTs / 1000)}`, 'HEAD'], 5_000)
    const n = out === null ? 0 : parseInt(out.trim(), 10) // null: no git or no HEAD
    if (n > 0) lines.push(`- This repo received ${n} new commit(s) since your last turn`)
  }
  if (lines.length === 0) return null
  return `[OrcStrator] Updates in this repo since your last turn:\n${lines.slice(0, 10).join('\n')}\nThis is FYI only — never wait for, defer to, or pause because of another instance. The ONLY constraint: do not edit the specific files listed as another instance's uncommitted edits. Every other file is yours to work on freely, in parallel; different files never conflict. If your task genuinely requires one of those exact files, tell the user instead of waiting.`
}

export function releaseLocksForInstance(instanceId: string): void {
  db.prepare('DELETE FROM file_locks WHERE instance_id = ?').run(instanceId)
  for (const [tid, snap] of preBashDirty) {
    if (snap.instanceId === instanceId) preBashDirty.delete(tid)
  }
}

/** Boot: restore the ignore window and drop locks whose files are now clean or whose instance is gone. */
export async function initFileLocks(): Promise<void> {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'conflictIgnoreUntil'").get() as { value: string } | undefined
    if (row) ignoreUntil = JSON.parse(row.value) as number
  } catch { /* default 0 */ }

  db.prepare('DELETE FROM file_locks WHERE instance_id NOT IN (SELECT id FROM instances)').run()
  const cwds = (db.prepare('SELECT DISTINCT cwd FROM file_locks').all() as Array<{ cwd: string }>).map(r => r.cwd)
  for (const cwd of cwds) {
    try { releaseCleanLocks(cwd, await gitPorcelain(cwd)) } catch { /* keep locks */ }
  }
  const remaining = (db.prepare('SELECT COUNT(*) c FROM file_locks').get() as { c: number }).c
  console.log(`[file-locks] Initialized — ${remaining} lock(s) survive boot`)
}
