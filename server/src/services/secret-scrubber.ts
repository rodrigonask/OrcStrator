// Permanently strips API keys / passwords from everything Claude keeps on disk for a session.
//
// Runs on "Secure close": the OrcStrator DB row is deleted anyway, but the on-disk
// transcript Claude resumes from would otherwise keep every secret the user pasted. Each
// JSONL line is rewritten in place and stays valid JSON, deep-walking every string value so
// a key is caught wherever it sits (user text, tool input, tool output).
//
// It used to scrub ONE file, found by a folder name computed differently
// from the CLI's (D-Work-x instead of D--Work-x), so it usually fell back to the
// first <id>.jsonl anywhere, possibly a stale worktree copy. Now it scrubs every copy of the
// session under every project folder, the session's own folder (subagent transcripts, saved
// tool results), and deletes the sanitizer's backup copies, which would re-leak what was
// just removed. The caller stops the agent first, so nothing is written after the scrub.

import fs from 'fs/promises'
import path from 'path'
import { redactSecrets, SECRET_MARKER, type SecretCategory } from '@orcstrator/shared'
import { isValidSessionId } from './session-id.js'
import { claudeProjectsDir } from './claude-paths.js'

/**
 * Where Claude keeps transcripts: CLAUDE_CONFIG_DIR (the CLI's own override) or ~/.claude.
 * From the one shared place, read on every call like it always was here.
 */
function defaultClaudeDir(): string {
  return claudeProjectsDir()
}

type Tally = Record<SecretCategory, number>

// Recursively redact every string value in a parsed JSONL entry.
function redactDeep(value: unknown, tally: Tally): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const r = redactSecrets(value)
    if (r.matches.length === 0) return { value, changed: false }
    tally.apiKey += r.apiKeys
    tally.password += r.passwords
    return { value: r.redacted, changed: true }
  }
  if (Array.isArray(value)) {
    let changed = false
    const arr = value.map(item => {
      const r = redactDeep(item, tally)
      if (r.changed) changed = true
      return r.value
    })
    return { value: changed ? arr : value, changed }
  }
  if (value && typeof value === 'object') {
    let changed = false
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = redactDeep(v, tally)
      if (r.changed) changed = true
      obj[k] = r.value
    }
    return { value: changed ? obj : value, changed }
  }
  return { value, changed: false }
}

export interface ScrubResult {
  ok: boolean
  /** False when no transcript file exists for this instance (nothing to scrub). */
  sessionFound: boolean
  apiKeys: number
  passwords: number
  removed: number
  affectedLines: number
  /** Every file that was checked (transcript copies, subagent transcripts, saved tool results). */
  filesScanned?: number
  /** Backup copies of the transcript that were deleted, because they held the same secrets. */
  backupsDeleted?: number
  error?: string
}

const EMPTY: ScrubResult = { ok: true, sessionFound: false, apiKeys: 0, passwords: 0, removed: 0, affectedLines: 0, filesScanned: 0, backupsDeleted: 0 }

/** A copy the sanitizer or the worktree repair made of a transcript before rewriting it. */
function isBackupName(name: string): boolean {
  return /\.bak(-\d+)?$/.test(name) || /\.pre-worktree-repair-\d+\.bak$/.test(name) || /\.bak-\d+$/.test(name)
}


async function walk(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 6) return
  let entries: import('fs').Dirent[]
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await walk(full, out, depth + 1)
    else if (e.isFile()) out.push(full)
  }
}

/** Every file Claude keeps for this session, under every project folder, plus its backups. */
export async function findSessionArtifacts(sessionId: string, claudeDir = defaultClaudeDir()): Promise<{ files: string[]; backups: string[] }> {
  const files: string[] = []
  const backups: string[] = []
  if (!isValidSessionId(sessionId)) return { files, backups }
  let projects: import('fs').Dirent[]
  try { projects = await fs.readdir(claudeDir, { withFileTypes: true }) } catch { return { files, backups } }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const dir = path.join(claudeDir, p.name)
    let entries: import('fs').Dirent[]
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.name.startsWith(sessionId)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        // <slug>/<sessionId>/: subagent transcripts and saved tool results.
        if (e.name === sessionId) await walk(full, files)
        continue
      }
      if (!e.isFile()) continue
      if (isBackupName(e.name)) backups.push(full)
      else files.push(full)
    }
  }
  // Claude's other per-session folders next to projects/:
  // the debug log, the session's environment snapshot, file edit history, its task list and
  // uploads (binary files such as cached images are left alone by scrubFile).
  const base = path.dirname(claudeDir)
  for (const sub of ['debug', 'session-env', 'file-history', 'todos', 'tasks', 'uploads', 'image-cache']) {
    let entries: import('fs').Dirent[]
    try { entries = await fs.readdir(path.join(base, sub), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.name.startsWith(sessionId)) continue
      const full = path.join(base, sub, e.name)
      if (e.isDirectory()) await walk(full, files)
      else if (e.isFile()) files.push(full)
    }
  }
  return { files, backups }
}

/**
 * How a non-JSONL session file is text, or null for binary.
 * - UTF-16 with a BOM (what Windows PowerShell 5.1 `>` writes).
 * - Valid UTF-8: decoding and re-encoding it is byte for byte, NUL bytes included.
 * - Otherwise a single-byte legacy file (Latin-1, Windows-1252) when it has no control bytes;
 *   with control bytes it is binary (a cached image, a PDF stream) and is left alone.
 */
function textEncoding(buf: Buffer): 'utf-16le' | 'utf-8' | 'latin1' | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le'
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return 'utf-8' } catch { /* not UTF-8 */ }
  for (const b of buf) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d && b !== 0x1b) return null
  return 'latin1'
}

async function writeAtomic(file: string, data: Buffer): Promise<void> {
  // Atomic replace (temp + rename) so a crash mid-write can't truncate the file.
  const tmp = file + '.scrub-tmp'
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}

async function scrubOtherFile(file: string, buf: Buffer, tally: Tally): Promise<number> {
  const enc = textEncoding(buf)
  if (!enc) return 0
  const text = enc === 'utf-16le' ? buf.subarray(2).toString('utf16le') : buf.toString(enc)
  const r = redactSecrets(text)
  if (!r.matches.length) return 0
  tally.apiKey += r.apiKeys
  tally.password += r.passwords
  let out: Buffer
  // An odd trailing byte (a truncated file) is not part of any UTF-16 unit: keep it as it was.
  if (enc === 'utf-16le') out = Buffer.concat([buf.subarray(0, 2), Buffer.from(r.redacted, 'utf16le'), buf.length % 2 ? buf.subarray(buf.length - 1) : Buffer.alloc(0)])
  else if (enc === 'utf-8') out = Buffer.from(r.redacted, 'utf-8')
  else {
    // Latin-1 string offsets are byte offsets: splice the marker (UTF-8) into the original bytes.
    const parts: Buffer[] = []
    let at = 0
    for (const m of r.matches) { parts.push(buf.subarray(at, m.start), Buffer.from(SECRET_MARKER, 'utf-8')); at = m.end }
    parts.push(buf.subarray(at))
    out = Buffer.concat(parts)
  }
  await writeAtomic(file, out)
  return 1
}

/** Redact one file in place. JSONL line by line (each line stays valid JSON); other text whole. */
async function scrubFile(file: string, tally: Tally): Promise<number> {
  const buf = await fs.readFile(file)
  // Every file of the session is scrubbed if it is text, whatever its name: file-history keeps
  // edited files as <hash>@v2, session-env keeps hook scripts as .sh. Each is rewritten in its
  // own encoding so nothing but the secret changes.
  if (!/\.jsonl\b/i.test(file)) return scrubOtherFile(file, buf, tally)
  const original = buf.toString('utf-8')
  let affectedLines = 0
  let next = original
  {
    const out: string[] = []
    for (const line of original.split('\n')) {
      if (!line.trim()) { out.push(line); continue }
      let entry: unknown
      try { entry = JSON.parse(line) } catch {
        // Not JSON: still text that can hold a key.
        const r = redactSecrets(line)
        if (r.matches.length) { tally.apiKey += r.apiKeys; tally.password += r.passwords; affectedLines++ }
        out.push(r.redacted)
        continue
      }
      const before = tally.apiKey + tally.password
      const r = redactDeep(entry, tally)
      if (r.changed && tally.apiKey + tally.password > before) {
        const serialized = JSON.stringify(r.value)
        // Safety: the rewrite must still parse, or the transcript Claude resumes from breaks.
        try { JSON.parse(serialized) } catch { out.push(line); continue }
        out.push(serialized)
        affectedLines++
      } else {
        out.push(line)
      }
    }
    next = out.join('\n')
  }
  if (affectedLines === 0) return 0
  await writeAtomic(file, Buffer.from(next, 'utf-8'))
  return affectedLines
}

/**
 * Scan and permanently redact secrets from every file of a session, and delete its backup
 * copies. Best-effort: never throws; returns ok:false with an error so the close proceeds.
 * `cwd` is kept for the call sites; every project folder is searched regardless.
 */
export async function scrubSessionSecrets(
  _cwd: string,
  sessionId: string | null | undefined,
  claudeDir = defaultClaudeDir(),
): Promise<ScrubResult> {
  if (!sessionId || !isValidSessionId(sessionId)) return EMPTY
  const { files, backups } = await findSessionArtifacts(sessionId, claudeDir)
  if (files.length === 0 && backups.length === 0) return EMPTY

  const tally: Tally = { apiKey: 0, password: 0 }
  let affectedLines = 0
  const errors: string[] = []
  for (const file of files) {
    try { affectedLines += await scrubFile(file, tally) } catch (e) { errors.push(`${path.basename(file)}: ${(e as Error).message}`) }
  }
  let backupsDeleted = 0
  for (const b of backups) {
    try { await fs.unlink(b); backupsDeleted++ } catch (e) { errors.push(`${path.basename(b)}: ${(e as Error).message}`) }
  }

  const removed = tally.apiKey + tally.password
  return {
    ok: errors.length === 0,
    sessionFound: true,
    apiKeys: tally.apiKey,
    passwords: tally.password,
    removed,
    affectedLines,
    filesScanned: files.length,
    backupsDeleted,
    ...(errors.length ? { error: errors.slice(0, 3).join('; ') } : {}),
  }
}
