import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { db } from '../db.js'
import { canonicalizeCwd } from './canonical-path.js'
import type { MessageContentBlock } from '@orcstrator/shared'

/**
 * Adopting a transcript back into a chat.
 *
 * A session file on disk is the whole conversation; OrcStrator resumes one by spawning
 * `claude --resume <sessionId>` in the session's cwd, which is what every normal turn
 * already does. So "resume this session file" is really "give this session id a chat to
 * live in": bind it to an instance, put the last stretch of the transcript in the chat
 * pane so the tab is not blank, and let the next message the user sends continue it.
 */

/** How much of the file's tail we read to rebuild the visible chat. */
const TAIL_BYTES = 4 * 1024 * 1024
/** Messages restored into the chat pane. The full conversation still lives in the JSONL. */
const MAX_IMPORTED = 60
/** Per-message cap. The history route rejects anything over 50 KB; stay well under it. */
const MAX_TEXT_CHARS = 8_000

export interface AdoptFolder {
  id: string
  path: string
}

/**
 * The project a cwd belongs to: exact match first, then the longest project path that
 * contains it — a worktree under `<repo>/.claude/worktrees/x` belongs to `<repo>`.
 */
export function findFolderForCwd(cwd: string): AdoptFolder | null {
  const target = canonicalizeCwd(cwd)
  const folders = db.prepare('SELECT id, path FROM folders WHERE path IS NOT NULL').all() as AdoptFolder[]

  let best: AdoptFolder | null = null
  let bestLen = -1
  for (const folder of folders) {
    if (!folder.path) continue
    const fp = canonicalizeCwd(folder.path)
    if (fp.toLowerCase() === target.toLowerCase()) return folder
    const prefix = fp.endsWith(path.sep) ? fp : fp + path.sep
    if (target.toLowerCase().startsWith(prefix.toLowerCase()) && fp.length > bestLen) {
      best = folder
      bestLen = fp.length
    }
  }
  return best
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue }
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

/** Read the tail of a (possibly very large) transcript as whole lines. */
async function readTailLines(filePath: string): Promise<string[]> {
  const handle = await fsp.open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(Math.max(0, size - start))
    if (buf.length === 0) return []
    const { bytesRead } = await handle.read(buf, 0, buf.length, start)
    const lines = buf.toString('utf-8', 0, bytesRead).split('\n')
    // A non-zero start almost certainly lands mid-line; that fragment is not JSON.
    if (start > 0) lines.shift()
    return lines
  } finally {
    await handle.close().catch(() => {})
  }
}

export interface AdoptedPreview {
  /** Title-ish label for the chat, from the transcript's own summary or first user turn. */
  title: string | null
  imported: number
}

/**
 * Rebuild the visible chat from a transcript's tail and write it into `messages`.
 * Only ever called for a chat that has no messages of its own, so it cannot duplicate.
 */
export async function importSessionTail(filePath: string, instanceId: string): Promise<AdoptedPreview> {
  let lines: string[]
  try {
    lines = await readTailLines(filePath)
  } catch {
    return { title: null, imported: 0 }
  }

  const collected: Array<{ role: 'user' | 'assistant'; text: string; at: number }> = []
  let title: string | null = null

  for (const line of lines) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }

    // The CLI writes its own chat title into the transcript (repeatedly, as it revises
    // it) — the freshest one is a far better chat name than anything we could derive.
    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
      title = entry.aiTitle.trim().slice(0, 60)
      continue
    }
    if (entry.type === 'summary' && typeof entry.summary === 'string' && !title) {
      title = entry.summary.slice(0, 80)
      continue
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    // Sidechain entries are subagent chatter, not the conversation the user had.
    if (entry.isSidechain === true) continue

    const message = entry.message as { content?: unknown } | undefined
    const text = textFromContent(message?.content)
    if (!text) continue // tool-only step — nothing to show
    // The harness injects these into the user turn; they are not something the user typed.
    if (entry.type === 'user' && text.startsWith('<system-reminder>')) continue

    const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    collected.push({
      role: entry.type as 'user' | 'assistant',
      text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + '\n\n[truncated on import]' : text,
      at: Number.isFinite(ts) ? ts : Date.now(),
    })
  }

  const kept = collected.slice(-MAX_IMPORTED)
  if (kept.length === 0) return { title, imported: 0 }

  if (!title) {
    // Skip harness-injected user turns (<task-notification>, <command-message>, …) —
    // naming a chat after one of those reads as gibberish in the sidebar.
    const firstUser = kept.find((m) => m.role === 'user' && !m.text.startsWith('<'))
    if (firstUser) title = firstUser.text.replace(/\s+/g, ' ').slice(0, 60)
  }

  const insert = db.prepare(
    'INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  const marker: MessageContentBlock[] = [{
    type: 'text',
    text: `_Resumed from session file. The ${kept.length} most recent messages are shown; the full history is still in the session and Claude keeps all of it._`,
  }]
  const writeAll = db.transaction(() => {
    insert.run(crypto.randomUUID(), instanceId, 'system', JSON.stringify(marker), kept[0].at - 1)
    for (const m of kept) {
      const content: MessageContentBlock[] = [{ type: 'text', text: m.text }]
      insert.run(crypto.randomUUID(), instanceId, m.role, JSON.stringify(content), m.at)
    }
  })
  writeAll()

  return { title, imported: kept.length }
}
