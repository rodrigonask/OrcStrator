import fs from 'fs/promises'
import path from 'path'
import os from 'os'

function resolveSessionFile(cwd: string, sessionId: string): string {
  const encodedCwd = cwd
    .replace(/[:\\\/]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+/g, '-')
  return path.join(os.homedir(), '.claude', 'projects', encodedCwd, `${sessionId}.jsonl`)
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

/**
 * Strip base64 image data from session JSONL files after process exit.
 * This reduces disk usage from accumulated session files.
 * Best-effort: failures are silently ignored.
 */
export async function sanitizeSession(cwd: string, sessionId: string): Promise<void> {
  try {
    const encodedCwd = cwd
      .replace(/[:\\\/]/g, '-')
      .replace(/^-+/, '')
      .replace(/-+/g, '-')

    const claudeDir = path.join(os.homedir(), '.claude', 'projects', encodedCwd)
    const sessionFile = path.join(claudeDir, `${sessionId}.jsonl`)

    // Check if file exists
    try {
      await fs.access(sessionFile)
    } catch {
      return // File doesn't exist, nothing to sanitize
    }

    const content = await fs.readFile(sessionFile, 'utf-8')
    const lines = content.trim().split('\n')
    let modified = false
    const sanitizedLines: string[] = []

    for (const line of lines) {
      if (!line.trim()) {
        sanitizedLines.push(line)
        continue
      }

      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        const sanitized = stripBase64FromEntry(entry)
        if (sanitized.changed) {
          modified = true
          sanitizedLines.push(JSON.stringify(sanitized.entry))
        } else {
          sanitizedLines.push(line)
        }
      } catch {
        sanitizedLines.push(line)
      }
    }

    if (modified) {
      await fs.writeFile(sessionFile, sanitizedLines.join('\n') + '\n', 'utf-8')
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
          // Also check for base64 in text blocks (sometimes embedded)
          if (b.type === 'text' && typeof b.text === 'string') {
            const text = b.text as string
            const base64Pattern = /data:[^;]+;base64,[A-Za-z0-9+/=]{1000,}/g
            if (base64Pattern.test(text)) {
              changed = true
              return { ...b, text: text.replace(base64Pattern, 'data:image/png;base64,[STRIPPED]') }
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
