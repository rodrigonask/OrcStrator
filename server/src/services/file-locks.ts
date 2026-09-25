import { execFile, execFileSync } from 'child_process'
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
function parsePorcelain(cwd: string, stdout: string): Set<string> {
  const files = new Set<string>()
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const xy = line.slice(0, 2)
    if (xy === '??') continue // untracked — not lockable
    let rel = line.slice(3).trim().replace(/^"|"$/g, '')
    // Renames render as `old -> new`; the on-disk path is the new name.
    if (xy.includes('R') && rel.includes(' -> ')) {
      rel = rel.split(' -> ').pop()!.trim().replace(/^"|"$/g, '')
    }
    if (rel) files.add(norm(path.resolve(cwd, rel)))
  }
  return files
}

function gitPorcelain(cwd: string): Promise<Set<string>> {
  return new Promise(resolve => {
    execFile('git', ['status', '--porcelain'], { cwd, timeout: 10_000 }, (err, stdout) => {
      if (err) { resolve(new Set()); return }
      resolve(parsePorcelain(cwd, stdout))
    })
  })
}

/** Is a single path still dirty (tracked-modified) right now? Used to re-validate a
 *  conflict before disrupting a sibling. On error, assume dirty (fail toward protection). */
function isPathDirty(cwd: string, absolutePath: string): boolean {
  try {
    const rel = path.relative(cwd, absolutePath) || absolutePath
    const out = execFileSync('git', ['status', '--porcelain', '--', rel], { cwd, timeout: 5_000 }).toString()
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      if (line.slice(0, 2) === '??') continue // untracked doesn't count as a real conflict
      return true
    }
    return false
  } catch {
    return true
  }
}

/**
 * All uncommitted paths in `cwd`, INCLUDING untracked (`??`) files. Returns null if
 * `cwd` is not a git repo (or git errored) so callers can distinguish "clean" from
 * "no repo". Unlike gitPorcelain (the lock layer), this DELIBERATELY counts untracked
 * files — for a *close* warning, a brand-new uncommitted file is real work you'd orphan.
 * Each entry keeps the original-case relative path (for display) plus its normalized
 * absolute form (for matching against the lock table).
 */
function gitPorcelainAll(cwd: string): Promise<Array<{ rel: string; absNorm: string }> | null> {
  return new Promise(resolve => {
    execFile('git', ['status', '--porcelain'], { cwd, timeout: 10_000 }, (err, stdout) => {
      if (err) { resolve(null); return }
      const out: Array<{ rel: string; absNorm: string }> = []
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const xy = line.slice(0, 2)
        let rel = line.slice(3).trim().replace(/^"|"$/g, '')
        if (xy.includes('R') && rel.includes(' -> ')) {
          rel = rel.split(' -> ').pop()!.trim().replace(/^"|"$/g, '')
        }
        if (rel) out.push({ rel, absNorm: norm(path.resolve(cwd, rel)) })
      }
      resolve(out)
    })
  })
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

/** Record a live Edit/Write. Returns a conflict if another instance holds the file. */
export function noteEdit(instanceId: string, cwd: string, filePath: string): Conflict | null {
  const absolute = norm(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath))
  const lock = db.prepare('SELECT * FROM file_locks WHERE path = ?').get(absolute) as LockRow | undefined

  if (lock && lock.instance_id !== instanceId && Date.now() >= ignoreUntil) {
    const holder = db.prepare('SELECT name FROM instances WHERE id = ?').get(lock.instance_id) as { name: string } | undefined
    if (holder) {
      // Re-validate before disrupting a sibling: the lock is only real if the file is
      // STILL dirty. A stale lock (holder committed/reverted, or it was an attribution
      // artifact) is silently reclaimed rather than paused on.
      if (isPathDirty(lock.cwd || cwd, absolute)) {
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
  try { preBashDirty.set(toolUseId, { instanceId, cwd, before: await gitPorcelain(cwd) }) } catch { /* non-critical */ }
}

/** A Bash tool call completed — lock the files it newly dirtied to the instance that
 *  ran it. No-ops for non-Bash tools (their ids were never snapshotted). */
export async function onBashComplete(toolUseId: string): Promise<void> {
  const snap = preBashDirty.get(toolUseId)
  if (!snap) return
  preBashDirty.delete(toolUseId)
  try {
    const after = await gitPorcelain(snap.cwd)
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

function releaseCleanLocks(cwdNorm: string, dirtyNow: Set<string>): void {
  const locks = db.prepare('SELECT * FROM file_locks WHERE cwd = ?').all(cwdNorm) as LockRow[]
  for (const lock of locks) {
    if (!dirtyNow.has(lock.path)) {
      db.prepare('DELETE FROM file_locks WHERE id = ?').run(lock.id)
    }
  }
}

/** Sibling activity note for a fresh turn — commits + locked files since the instance last ran. */
export function buildUpdateNote(instanceId: string, cwd: string, sinceTs: number | null): string | null {
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
    try {
      const out = execFileSync('git', ['rev-list', '--count', `--since=${Math.floor(sinceTs / 1000)}`, 'HEAD'], { cwd, timeout: 5_000 }).toString().trim()
      const n = parseInt(out, 10)
      if (n > 0) lines.push(`- This repo received ${n} new commit(s) since your last turn`)
    } catch { /* no git or no HEAD */ }
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
