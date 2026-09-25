// Permanently strips API keys / passwords from a Claude transcript .jsonl.
//
// Runs on "Close Session": the OrcStrator DB row is deleted anyway, but the
// on-disk transcript Claude resumes from would otherwise keep every secret the
// user pasted. This rewrites that file in place — no backup, by design (a backup
// would just re-leak the secret). It mirrors session-sanitizer.ts: rewrite each
// JSONL line while keeping it valid JSON, deep-walking every string value so a
// key is caught wherever it sits (user text, tool input, tool output).

import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { redactSecrets, type SecretCategory } from '@orcstrator/shared'

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects')

function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[:\\/]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+/g, '-')
}

// The encoded-cwd guess is usually right; if not, fall back to searching the
// project dirs for `${sessionId}.jsonl` (same approach as routes/sessions.ts).
async function resolveExistingSessionFile(cwd: string, sessionId: string): Promise<string | null> {
  const direct = path.join(CLAUDE_DIR, encodeCwd(cwd), `${sessionId}.jsonl`)
  try { await fs.access(direct); return direct } catch { /* fall through to search */ }
  try {
    const dirs = await fs.readdir(CLAUDE_DIR, { withFileTypes: true })
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const candidate = path.join(CLAUDE_DIR, d.name, `${sessionId}.jsonl`)
      try { await fs.access(candidate); return candidate } catch { /* keep looking */ }
    }
  } catch { /* CLAUDE_DIR unreadable */ }
  return null
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
  error?: string
}

const EMPTY: ScrubResult = { ok: true, sessionFound: false, apiKeys: 0, passwords: 0, removed: 0, affectedLines: 0 }

/**
 * Scan and permanently redact secrets from an instance's transcript file.
 * Best-effort and self-contained: never throws — returns ok:false with an error
 * string so the close flow can proceed regardless.
 */
export async function scrubSessionSecrets(cwd: string, sessionId: string | null | undefined): Promise<ScrubResult> {
  if (!cwd || !sessionId) return EMPTY
  const file = await resolveExistingSessionFile(cwd, sessionId)
  if (!file) return EMPTY

  try {
    const original = await fs.readFile(file, 'utf-8')
    const lines = original.split('\n')
    const tally: Tally = { apiKey: 0, password: 0 }
    let affectedLines = 0
    const out: string[] = []

    for (const line of lines) {
      if (!line.trim()) { out.push(line); continue }
      let entry: unknown
      try { entry = JSON.parse(line) } catch { out.push(line); continue } // leave unparseable lines untouched

      const before = tally.apiKey + tally.password
      const r = redactDeep(entry, tally)
      if (r.changed && tally.apiKey + tally.password > before) {
        const serialized = JSON.stringify(r.value)
        // Safety: the rewrite must still parse. If it somehow doesn't, keep the
        // original line rather than corrupt the transcript Claude resumes from.
        try { JSON.parse(serialized) } catch { out.push(line); continue }
        out.push(serialized)
        affectedLines++
      } else {
        out.push(line)
      }
    }

    const removed = tally.apiKey + tally.password
    if (removed === 0) {
      return { ok: true, sessionFound: true, apiKeys: 0, passwords: 0, removed: 0, affectedLines: 0 }
    }

    // Atomic replace (temp + rename) so a crash mid-write can't truncate the file.
    const tmp = file + '.scrub-tmp'
    await fs.writeFile(tmp, out.join('\n'), 'utf-8')
    await fs.rename(tmp, file)

    return { ok: true, sessionFound: true, apiKeys: tally.apiKey, passwords: tally.password, removed, affectedLines }
  } catch (e) {
    return { ok: false, sessionFound: true, apiKeys: 0, passwords: 0, removed: 0, affectedLines: 0, error: (e as Error).message }
  }
}
