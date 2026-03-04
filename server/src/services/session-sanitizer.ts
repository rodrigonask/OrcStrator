import fs from 'fs/promises'
import path from 'path'
import os from 'os'

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

  if (Array.isArray(entry.content)) {
    const newContent = entry.content.map((block: unknown) => {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>
        // Strip base64 image source data
        if (b.type === 'image' && typeof b.source === 'object' && b.source) {
          const source = b.source as Record<string, unknown>
          if (source.type === 'base64' && typeof source.data === 'string' && (source.data as string).length > 1000) {
            changed = true
            return { ...b, source: { ...source, data: '[STRIPPED]' } }
          }
        }
        // Also check for base64 in text blocks (sometimes embedded)
        if (b.type === 'text' && typeof b.text === 'string') {
          const text = b.text as string
          // Match data URIs with base64 content
          const base64Pattern = /data:[^;]+;base64,[A-Za-z0-9+/=]{1000,}/g
          if (base64Pattern.test(text)) {
            changed = true
            return { ...b, text: text.replace(base64Pattern, 'data:image/png;base64,[STRIPPED]') }
          }
        }
      }
      return block
    })
    if (changed) {
      return { entry: { ...entry, content: newContent }, changed: true }
    }
  }

  return { entry, changed: false }
}
