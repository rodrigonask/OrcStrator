import fs from 'fs/promises'
import { createReadStream, createWriteStream } from 'fs'
import readline from 'readline'
import path from 'path'
import os from 'os'

// Map a working directory to the Claude CLI's session-storage folder name. The CLI replaces
// EVERY non-alphanumeric char with '-' (no run-collapsing, no leading strip), so
// D:\Work\orcstrator-v2 → "D--Work-orcstrator-v2". The previous slug collapsed
// '-+' → '-' and stripped leading dashes, so it computed a folder that never existed —
// which silently turned sanitizeSession into a no-op. Keep this EXACTLY matching the CLI.
export function cwdToSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function resolveSessionFile(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', cwdToSlug(cwd), `${sessionId}.jsonl`)
}

export type SessionHealResult = 'present' | 'relocated' | 'absent'

/**
 * Ensure the session JSONL for (cwd, sessionId) is where the Claude CLI will look before we
 * `--resume`. A session created inside a git worktree is stored under the worktree's
 * path-slug; once the worktree is removed and the instance's cwd reverts to the main
 * checkout, `--resume <id>` looks under the MAIN slug, doesn't find it, and the CLI exits
 * code 1 ("No conversation found") — a permanently dead tab.
 *
 *   'present'   → already at the main-cwd slug; nothing to do.
 *   'relocated' → found under another slug (a removed worktree) and COPIED into the main
 *                 slug (additive — original left intact), so resume works with full context.
 *   'absent'    → exists nowhere; caller should start a FRESH session (drop --resume)
 *                 rather than die on a resume that can never succeed.
 */
export async function healSessionLocation(
  cwd: string,
  sessionId: string,
  projectsRoot: string = path.join(os.homedir(), '.claude', 'projects'),
): Promise<SessionHealResult> {
  const mainSlug = cwdToSlug(cwd)
  const mainDir = path.join(projectsRoot, mainSlug)
  const mainFile = path.join(mainDir, `${sessionId}.jsonl`)

  try { await fs.access(mainFile); return 'present' } catch { /* not at main slug — search below */ }

  let slugs: string[]
  try { slugs = await fs.readdir(projectsRoot) } catch { return 'absent' }

  // Session IDs are globally-unique UUIDs, so any <id>.jsonl under ANY slug is THE session.
  // Check worktree siblings of this cwd first, then any other slug.
  const ordered = [
    ...slugs.filter(s => s !== mainSlug && s.startsWith(mainSlug + '-')),
    ...slugs.filter(s => s !== mainSlug && !s.startsWith(mainSlug + '-')),
  ]
  for (const slug of ordered) {
    const candidate = path.join(projectsRoot, slug, `${sessionId}.jsonl`)
    try { await fs.access(candidate) } catch { continue }
    try {
      await fs.mkdir(mainDir, { recursive: true })
      await fs.copyFile(candidate, mainFile)
      return 'relocated'
    } catch { return 'absent' }
  }
  return 'absent'
}

// ---------------------------------------------------------------------------
// Dead-worktree state
// ---------------------------------------------------------------------------

/**
 * A session that ran inside an isolation worktree carries a `worktree-state` record pinning
 * it to that worktree's path. If the worktree is later removed but its DIRECTORY survives
 * (routine on Windows: `git worktree remove` deletes the files, then can't rmdir because a
 * watcher or editor still holds the handle), every subsequent `--resume` re-enters the empty
 * husk, git discovery walks UP to the parent checkout, and the CLI refuses with
 * "cannot resume into worktree ... Refusing to use ... as an isolation worktree" and exit 1.
 *
 * That is fatal and permanent: the tab dies on EVERY message, forever, because nothing in the
 * normal flow ever rewrites the pin. Sibling of healSessionLocation above, which handles the
 * case where the session FILE went missing rather than the worktree it points at.
 */
export type WorktreeStateRecord = {
  worktreePath: string
  worktreeName?: string
  worktreeBranch?: string
}

export type DeadWorktreeState = {
  sessionId: string
  worktreePath: string
  worktreeName?: string
  worktreeBranch?: string
  files: string[]
}

export type WorktreeRepairResult = {
  ok: boolean
  error?: string
  /** true when the session was already healthy — nothing needed doing. */
  alreadyClear?: boolean
  worktreePath?: string
  worktreeName?: string
  repairedFiles?: string[]
  backups?: string[]
}

// worktree-state records are tiny and the CLI writes one on every enter/exit plus at session
// end, so the last one is almost always within the final few KB. Session files reach tens of
// MB (see the 90 MB note below), so read the tail first and only fall back to a full stream
// scan when the tail genuinely has none.
const TAIL_SCAN_BYTES = 1 << 20 // 1 MB

async function readTail(file: string, bytes: number): Promise<{ text: string; wholeFile: boolean }> {
  const handle = await fs.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - bytes)
    const length = size - start
    if (length <= 0) return { text: '', wholeFile: true }
    const buf = Buffer.alloc(Number(length))
    await handle.read(buf, 0, Number(length), start)
    let text = buf.toString('utf-8')
    if (start > 0) {
      // Drop the leading partial line so we never JSON.parse a truncated record.
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    return { text, wholeFile: start === 0 }
  } finally {
    await handle.close()
  }
}

function lastWorktreeStateIn(text: string): { found: boolean; state: WorktreeStateRecord | null } {
  let found = false
  let state: WorktreeStateRecord | null = null
  for (const line of text.split('\n')) {
    if (!line.includes('"worktree-state"')) continue
    try {
      const entry = JSON.parse(line) as { type?: string; worktreeSession?: WorktreeStateRecord | null }
      if (entry.type !== 'worktree-state') continue
      found = true
      // worktreeSession: null is the CLI's own "not in a worktree" marker.
      state = entry.worktreeSession ?? null
    } catch { /* partial or malformed line — ignore */ }
  }
  return { found, state }
}

async function fullScanLastWorktreeState(file: string): Promise<WorktreeStateRecord | null> {
  return new Promise((resolve) => {
    const stream = createReadStream(file, { encoding: 'utf-8', highWaterMark: 1 << 20 })
    let carry = ''
    let state: WorktreeStateRecord | null = null
    stream.on('data', (chunk: string | Buffer) => {
      const buf = carry + chunk
      const lines = buf.split('\n')
      carry = lines.pop() ?? ''
      const hit = lastWorktreeStateIn(lines.join('\n'))
      if (hit.found) state = hit.state
    })
    stream.on('end', () => {
      const hit = lastWorktreeStateIn(carry)
      if (hit.found) state = hit.state
      resolve(state)
    })
    stream.on('error', () => resolve(state))
  })
}

/** The session's effective worktree pin, or null if it is not pinned to one. */
async function readWorktreePin(file: string): Promise<WorktreeStateRecord | null> {
  const { text, wholeFile } = await readTail(file, TAIL_SCAN_BYTES)
  const hit = lastWorktreeStateIn(text)
  if (hit.found || wholeFile) return hit.state
  return fullScanLastWorktreeState(file)
}

/** Is the final byte a newline? Decides whether an append needs its own leading one. */
async function endsWithNewline(file: string): Promise<boolean> {
  const handle = await fs.open(file, 'r')
  try {
    const { size } = await handle.stat()
    if (size === 0) return true // empty file: append directly, no blank line needed
    const buf = Buffer.alloc(1)
    await handle.read(buf, 0, 1, Number(size) - 1)
    return buf[0] === 0x0a
  } finally {
    await handle.close()
  }
}

/** Every <sessionId>.jsonl on disk — the CLI keeps one copy per cwd-slug the session visited. */
async function findSessionFiles(sessionId: string, projectsRoot: string): Promise<string[]> {
  let slugs: string[]
  try { slugs = await fs.readdir(projectsRoot) } catch { return [] }
  const found: string[] = []
  for (const slug of slugs) {
    const candidate = path.join(projectsRoot, slug, `${sessionId}.jsonl`)
    try { await fs.access(candidate); found.push(candidate) } catch { /* not here */ }
  }
  return found
}

/**
 * A live worktree has a `.git` FILE pointing at its admin dir. When that is gone, git
 * discovery from inside resolves to the parent checkout — exactly the condition the CLI
 * guard refuses on. We deliberately do NOT try to judge subtler breakage (core.worktree
 * redirects): if `.git` is present we leave the session alone rather than guess.
 */
async function worktreeIsLive(worktreePath: string): Promise<boolean> {
  try { await fs.access(path.join(worktreePath, '.git')); return true } catch { return false }
}

/** Report the dead-worktree pin blocking this session, or null if there is nothing wrong. */
export async function detectDeadWorktreeState(
  cwd: string,
  sessionId: string,
  projectsRoot: string = path.join(os.homedir(), '.claude', 'projects'),
): Promise<DeadWorktreeState | null> {
  const files = await findSessionFiles(sessionId, projectsRoot)
  if (files.length === 0) return null

  // Prefer the copy under the instance's own cwd-slug: that is the one --resume reads.
  const mainFile = path.join(projectsRoot, cwdToSlug(cwd), `${sessionId}.jsonl`)
  const primary = files.includes(mainFile) ? mainFile : files[0]

  const pin = await readWorktreePin(primary)
  if (!pin?.worktreePath) return null
  if (await worktreeIsLive(pin.worktreePath)) return null

  return {
    sessionId,
    worktreePath: pin.worktreePath,
    worktreeName: pin.worktreeName,
    worktreeBranch: pin.worktreeBranch,
    files,
  }
}

/**
 * Unpin a session from a worktree that no longer exists, so `--resume` falls back to the
 * instance's normal cwd instead of aborting. Appends the CLI's OWN cleared-state record
 * rather than rewriting history — append-only, and byte-identical to what the CLI writes on
 * a clean ExitWorktree, so nothing downstream has to special-case it.
 */
export async function clearDeadWorktreeState(
  cwd: string,
  sessionId: string,
  projectsRoot: string = path.join(os.homedir(), '.claude', 'projects'),
): Promise<WorktreeRepairResult> {
  let dead: DeadWorktreeState | null
  try {
    dead = await detectDeadWorktreeState(cwd, sessionId, projectsRoot)
  } catch (err) {
    return { ok: false, error: `Could not read the session: ${(err as Error).message}` }
  }
  if (!dead) return { ok: true, alreadyClear: true }

  const record = JSON.stringify({ type: 'worktree-state', worktreeSession: null, sessionId }) + '\n'
  const repairedFiles: string[] = []
  const backups: string[] = []

  for (const file of dead.files) {
    // Only touch copies that actually carry the dead pin — a sibling slug may legitimately
    // be pinned elsewhere, and appending there would clear a worktree that is still alive.
    let pin: WorktreeStateRecord | null
    try { pin = await readWorktreePin(file) } catch { continue }
    if (pin?.worktreePath !== dead.worktreePath) continue

    try {
      const backup = `${file}.pre-worktree-repair-${Date.now()}.bak`
      await fs.copyFile(file, backup)
      const prefix = (await endsWithNewline(file)) ? '' : '\n'
      await fs.appendFile(file, prefix + record, 'utf-8')
      repairedFiles.push(file)
      backups.push(backup)
    } catch (err) {
      return { ok: false, error: `Failed writing ${path.basename(file)}: ${(err as Error).message}`, repairedFiles, backups }
    }
  }

  if (repairedFiles.length === 0) {
    return { ok: false, error: 'Found a dead worktree pin but no session file could be updated.' }
  }

  return {
    ok: true,
    worktreePath: dead.worktreePath,
    worktreeName: dead.worktreeName,
    repairedFiles,
    backups,
  }
}

export type SurrogateSanitizeResult = {
  ok: boolean
  error?: string
  removedChars?: number
  backupPath?: string
  affectedLines?: number
}

// Strips unpaired UTF-16 surrogate escape sequences (\uD8XX without matching \uDCXX, etc.)
// from session JSONL. These break Anthropic's strict JSON parser with 400 errors.
// Caused by truncated paste of an emoji or similar mid-codepoint cut.
export async function sanitizeSurrogates(cwd: string, sessionId: string): Promise<SurrogateSanitizeResult> {
  const sessionFile = resolveSessionFile(cwd, sessionId)

  try { await fs.access(sessionFile) }
  catch { return { ok: false, error: 'Session file not found' } }

  const original = await fs.readFile(sessionFile, 'utf-8')

  const HIGH_NOT_FOLLOWED = /\\u[dD][89aAbB][0-9a-fA-F]{2}(?!\\u[dD][cCdDeEfF][0-9a-fA-F]{2})/g
  const LOW_NOT_PRECEDED = /(?<!\\u[dD][89aAbB][0-9a-fA-F]{2})\\u[dD][cCdDeEfF][0-9a-fA-F]{2}/g

  const highCount = (original.match(HIGH_NOT_FOLLOWED) || []).length
  const lowCount = (original.match(LOW_NOT_PRECEDED) || []).length
  const totalBad = highCount + lowCount

  if (totalBad === 0) {
    return { ok: true, removedChars: 0, affectedLines: 0 }
  }

  const cleaned = original.replace(HIGH_NOT_FOLLOWED, '').replace(LOW_NOT_PRECEDED, '')

  const lines = cleaned.split('\n')
  let affectedLines = 0
  const origLines = original.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (origLines[i] !== lines[i]) affectedLines++
    if (lines[i].length === 0) continue
    try { JSON.parse(lines[i]) }
    catch (e) {
      return { ok: false, error: `Sanitized line ${i + 1} no longer parses as JSON: ${(e as Error).message}` }
    }
  }

  const backupPath = sessionFile + '.bak-' + Date.now()
  await fs.writeFile(backupPath, original, 'utf-8')
  await fs.writeFile(sessionFile, cleaned, 'utf-8')

  return {
    ok: true,
    removedChars: original.length - cleaned.length,
    backupPath,
    affectedLines,
  }
}

// Every form we strip below leaves the literal substring "base64" in the raw file:
// an image block carries "source":{"type":"base64",...} and a text-embedded data URI
// carries ";base64,". So if the file contains no "base64" anywhere, there is provably
// nothing to strip — and we can skip the multi-MB read + per-line JSON.parse + full
// rewrite entirely. This runs on the CRITICAL PATH of every send (pre-resume) and again
// after every turn; against a 90 MB session that parse+rewrite was seconds of fully
// event-loop-blocking work per turn, growing with the conversation. The stream scan below
// holds one ~1 MB chunk at a time and early-exits on the first hit, so the common case
// (no images this session, or images already stripped) costs a bounded read and no parse.
// Both markers are the RAW text the two strippable forms leave in the file: an image block
// serialises as "source":{"type":"base64",...} and an inline data URI as ";base64,". The
// scan used to look for the bare word "base64", which any transcript that merely TALKS
// about base64 contains — 26 of 27 live sessions here matched, so the fast path never
// fired and every turn paid for a full parse+rewrite of a file up to 86 MB.
const MARKERS = ['"type":"base64"', ';base64,']
const MARKER_OVERLAP = Math.max(...MARKERS.map(m => m.length)) - 1
// Per-line test used during the rewrite. Adds the empty text block the strip pass also
// removes, so line-level skipping drops nothing the old whole-file parse would have caught.
const LINE_MARKERS = [...MARKERS, '"text":""']

/**
 * How far into each file we have already scanned and found nothing to strip.
 *
 * A transcript only ever grows, so re-reading the whole thing every turn re-reads bytes
 * we cleared on the previous turn. Keyed by file, reset when the file shrinks (a /compact
 * or an external rewrite). In-memory only: worst case after a restart is one full scan.
 */
const scanned = new Map<string, number>()

/** Scan bytes [from, EOF) for a strippable-data marker. Holds one chunk at a time. */
function scanForMarkers(sessionFile: string, from: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const start = Math.max(0, from - MARKER_OVERLAP) // a marker straddling the old EOF still counts
    const stream = createReadStream(sessionFile, { encoding: 'utf-8', highWaterMark: 1 << 20, start })
    let carry = '' // last few chars, so a marker split across a chunk boundary is still caught
    let settled = false
    const done = (val: boolean) => { if (settled) return; settled = true; stream.destroy(); resolve(val) }
    stream.on('data', (chunk: string | Buffer) => {
      const buf = carry + chunk
      if (MARKERS.some(m => buf.includes(m))) return done(true)
      carry = buf.slice(-MARKER_OVERLAP)
    })
    stream.on('end', () => done(false))
    stream.on('error', () => done(false)) // best-effort: on read error, assume nothing to do
  })
}

export async function fileHasStrippableData(sessionFile: string): Promise<boolean> {
  let size: number
  try { size = (await fs.stat(sessionFile)).size } catch { return false }

  const from = scanned.get(sessionFile) ?? 0
  // File shrank → it was rewritten under us; nothing we scanned before still applies.
  const start = from > size ? 0 : from
  if (start >= size) return false

  const hit = await scanForMarkers(sessionFile, start)
  if (!hit) scanned.set(sessionFile, size)
  return hit
}

/**
 * Strip base64 image data from session JSONL files after process exit.
 * This reduces disk usage from accumulated session files.
 * Best-effort: failures are silently ignored.
 */
export async function sanitizeSession(cwd: string, sessionId: string): Promise<void> {
  try {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects', cwdToSlug(cwd))
    const sessionFile = path.join(claudeDir, `${sessionId}.jsonl`)

    // Check if file exists
    try {
      await fs.access(sessionFile)
    } catch {
      return // File doesn't exist, nothing to sanitize
    }

    // Fast path: skip the whole read/parse/rewrite when there is provably no image data.
    if (!(await fileHasStrippableData(sessionFile))) return

    // Streamed line by line into a sibling temp file, then renamed over the original.
    // The old version read the entire transcript into one string, split it into an array
    // of every line, and held a second array of rewritten lines — three copies of a file
    // that reaches hundreds of MB, allocated on the critical path of every send.
    const tmpFile = `${sessionFile}.sanitize-${process.pid}-${Date.now()}`
    let modified = false

    try {
      const input = createReadStream(sessionFile, { encoding: 'utf-8', highWaterMark: 1 << 20 })
      const output = createWriteStream(tmpFile, { encoding: 'utf-8' })
      const rl = readline.createInterface({ input, crlfDelay: Infinity })

      for await (const line of rl) {
        let out = line
        // Only lines that could actually change are worth parsing: the two image forms,
        // plus the empty text block the strip pass also drops. Everything else is copied
        // through as bytes, which is most of a transcript.
        if (line.trim() && LINE_MARKERS.some(m => line.includes(m))) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>
            const sanitized = stripBase64FromEntry(entry)
            if (sanitized.changed) {
              modified = true
              out = JSON.stringify(sanitized.entry)
            }
          } catch {
            // Unparseable line — copy it through untouched rather than lose it.
          }
        }
        if (!output.write(out + '\n')) {
          await new Promise<void>(resolve => output.once('drain', () => resolve()))
        }
      }

      await new Promise<void>((resolve, reject) => {
        output.end(() => resolve())
        output.once('error', reject)
      })

      if (modified) {
        await fs.rename(tmpFile, sessionFile)
      } else {
        await fs.unlink(tmpFile).catch(() => {})
      }

      // Either way the whole file has now been examined, so the next turn only has to
      // scan the bytes appended after this point.
      const { size } = await fs.stat(sessionFile)
      scanned.set(sessionFile, size)
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {}) // never leave a half-written temp file behind
      throw err
    }
  } catch {
    // Best-effort: silently ignore all errors
  }
}

function stripBase64FromEntry(entry: Record<string, unknown>): { entry: Record<string, unknown>; changed: boolean } {
  let changed = false

  // Claude CLI session files nest content under entry.message.content, not entry.content directly
  const message = entry.message as Record<string, unknown> | undefined
  const contentArray = Array.isArray(message?.content) ? message!.content as unknown[] : Array.isArray(entry.content) ? entry.content as unknown[] : null

  if (contentArray) {
    const newContent = contentArray
      .map((block: unknown) => {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>
          // Strip base64 image source data — replace with text placeholder so session stays valid on resume
          if (b.type === 'image' && typeof b.source === 'object' && b.source) {
            const source = b.source as Record<string, unknown>
            if (source.type === 'base64' && typeof source.data === 'string' && (source.data as string).length > 1000) {
              changed = true
              return { type: 'text', text: '[Image was sent here]' }
            }
          }
          // Also check for base64 in text blocks (sometimes embedded). The replacement must
          // NOT contain the literal "base64", or the fast-path marker scan would re-trigger a
          // full parse on this session every turn even though there is nothing left to strip.
          if (b.type === 'text' && typeof b.text === 'string') {
            const text = b.text as string
            const base64Pattern = /data:[^;]+;base64,[A-Za-z0-9+/=]{1000,}/g
            if (base64Pattern.test(text)) {
              changed = true
              return { ...b, text: text.replace(base64Pattern, '[inline image data stripped]') }
            }
          }
        }
        return block
      })
      // Remove empty text blocks — the API rejects content arrays with { type: 'text', text: '' }
      .filter((block: unknown) => {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>
          if (b.type === 'text' && (b.text as string) === '') {
            changed = true
            return false
          }
        }
        return true
      })

    if (changed) {
      if (message) {
        return { entry: { ...entry, message: { ...message, content: newContent } }, changed: true }
      }
      return { entry: { ...entry, content: newContent }, changed: true }
    }
  }

  return { entry, changed: false }
}
