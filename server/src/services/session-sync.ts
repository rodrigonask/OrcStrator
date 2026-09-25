import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { cwdToSlug } from './session-sanitizer.js'

/**
 * Read Claude Code session JSONL files from ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * Returns the last assistant message content from the session.
 *
 * Two long-lived bugs fixed here (this function silently returned null for everyone):
 *   1. The cwd slug was computed with a home-grown encoder that collapsed dash runs and
 *      stripped leading dashes ("D-Work-…"), while the CLI writes "D--Work-…".
 *      Now shares cwdToSlug() from session-sanitizer.ts — the one verified against the CLI.
 *   2. Session JSONL lines nest the message under entry.message ({type:'assistant',
 *      message:{role,content}}); the old code looked for entry.role at the top level,
 *      which never matches.
 */
export function getLastAssistantMessage(cwd: string, sessionId: string): string | null {
  const sessionFile = path.join(homedir(), '.claude', 'projects', cwdToSlug(cwd), `${sessionId}.jsonl`)

  if (!fs.existsSync(sessionFile)) {
    return null
  }

  // Read backwards in windows instead of slurping the file. The last assistant message is
  // by definition at the end, and these transcripts reach hundreds of MB — readFileSync on
  // one of those allocates the whole file as a string (plus a second copy per split) on the
  // main thread, which is a multi-hundred-MB spike for the last few KB of text.
  for (const window of TAIL_WINDOWS) {
    const tail = readTail(sessionFile, window)
    if (!tail) return null
    const found = lastAssistantTextIn(tail.text, tail.fromStart)
    if (found !== null) return found
    if (tail.fromStart) return null // already saw the whole file
  }
  return null
}

/** Windows tried, smallest first, before giving up rather than reading a 300 MB file. */
const TAIL_WINDOWS = [512 * 1024, 8 * 1024 * 1024]

function readTail(file: string, bytes: number): { text: string; fromStart: boolean } | null {
  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - bytes)
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      const read = fs.readSync(fd, buf, 0, buf.length, start)
      return { text: buf.toString('utf-8', 0, read), fromStart: start === 0 }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

function lastAssistantTextIn(chunk: string, fromStart: boolean): string | null {
  try {
    const lines = chunk.split('\n').filter(Boolean)
    // A window that does not start at byte 0 begins mid-line; that fragment is not JSON.
    if (!fromStart) lines.shift()

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as Record<string, unknown>
        if (entry.type !== 'assistant') continue
        const message = entry.message as Record<string, unknown> | undefined
        if (!message || message.role !== 'assistant') continue

        const msgContent = message.content
        if (typeof msgContent === 'string') {
          return msgContent
        }
        if (Array.isArray(msgContent)) {
          const textParts: string[] = []
          for (const block of msgContent) {
            if (typeof block === 'string') {
              textParts.push(block)
            } else if (block && typeof block === 'object' && (block as { type?: string }).type === 'text' && 'text' in block) {
              textParts.push((block as { text: string }).text)
            }
          }
          const text = textParts.join('\n').trim()
          if (text) return text
          continue // tool-use-only step — keep walking back to the last real text
        }
      } catch {
        continue
      }
    }

    return null
  } catch {
    return null
  }
}
