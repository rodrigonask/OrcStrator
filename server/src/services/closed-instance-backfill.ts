// Recovering the names of chats closed BEFORE the close tombstone existed.
//
// Every chat closed before db.ts migration040 took its name with it: the `instances` row
// was hard-deleted and its cost history was left joining against nothing, so ~9k turns
// rendered as the literal "chat". Those names are gone from SQLite for good.
//
// What survives is the Claude transcript on disk, keyed by session id. The first real
// prompt of a session is a decent approximation of what the chat was about, so this
// derives a name from it and writes it into the tombstone as name_source='derived' —
// flagged, never passed off as the original.
//
// Runs once, in the background, after the server is up. It is self-guarding: every
// orphan it looks at gets a tombstone row, including the ones whose transcript is gone
// (name NULL), so the disk sweep never repeats.
import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { db } from '../db.js'

const MAX_NAME_CHARS = 40
const MAX_LINES_SCANNED = 40   // the real prompt is at the top or it isn't there at all

// Injected preambles that are not the user talking. A session whose first `user` entry is
// one of these gets skipped over, not named after it.
const NOT_A_PROMPT = [
  /^\[OrcStrator\]/i,
  /^<command-(name|message|args)>/i,
  /^<local-command/i,
  /^<system-reminder>/i,
  /^Caveat: The messages below/i,
  /^This session is being continued from/i,
]

interface Orphan {
  id: string
  folder_id: string | null
  session_ids: string[]
  last_at: number
}

/** session_id -> transcript path, across every project slug under ~/.claude/projects. */
function indexTranscripts(): Map<string, string> {
  const root = path.join(os.homedir(), '.claude', 'projects')
  const index = new Map<string, string>()
  let slugs: string[] = []
  try { slugs = fs.readdirSync(root) } catch { return index }
  for (const slug of slugs) {
    const dir = path.join(root, slug)
    let files: string[] = []
    try { files = fs.readdirSync(dir) } catch { continue }
    for (const f of files) {
      if (f.endsWith('.jsonl')) index.set(f.slice(0, -6), path.join(dir, f))
    }
  }
  return index
}

/** Chats that have cost history but no `instances` row and no tombstone yet. */
function findOrphans(): Orphan[] {
  const rows = db.prepare(`
    SELECT tc.instance_id                                   AS id,
           MAX(NULLIF(tc.folder_id, ''))                    AS folder_id,
           MAX(tc.created_at)                               AS last_at,
           GROUP_CONCAT(DISTINCT tc.session_id)             AS session_ids
    FROM turn_costs tc
    LEFT JOIN instances i        ON i.id = tc.instance_id
    LEFT JOIN closed_instances c ON c.id = tc.instance_id
    WHERE i.id IS NULL AND c.id IS NULL AND tc.instance_id IS NOT NULL
    GROUP BY tc.instance_id
  `).all() as Array<{ id: string; folder_id: string | null; last_at: number; session_ids: string | null }>

  return rows.map(r => ({
    id: r.id,
    folder_id: r.folder_id,
    last_at: r.last_at,
    session_ids: (r.session_ids || '').split(',').filter(Boolean),
  }))
}

/** First line of the first thing the user actually said, clamped to a chat-name length. */
function toName(prompt: string): string | null {
  let s = prompt.trim().split('\n').find(l => l.trim().length > 0) ?? ''
  s = s.trim()
    .replace(/^[#>*\-\s]+/, '')          // markdown lead-in
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
  if (s.length < 3) return null
  if (s.length > MAX_NAME_CHARS) s = s.slice(0, MAX_NAME_CHARS - 1).trimEnd() + '…'
  return s
}

/** Read down a transcript for the first user turn that is a real prompt. */
async function firstPrompt(file: string): Promise<string | null> {
  let stream: fs.ReadStream
  try { stream = fs.createReadStream(file) } catch { return null }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let scanned = 0
  try {
    for await (const line of rl) {
      if (++scanned > MAX_LINES_SCANNED) break
      if (!line.trim()) continue
      let entry: Record<string, unknown>
      try { entry = JSON.parse(line) } catch { continue }
      if (entry.type !== 'user' || entry.isMeta) continue

      const content = (entry.message as { content?: unknown } | undefined)?.content
      let text = ''
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        // Skip tool_result turns entirely — those are the harness talking, not the user.
        if (content.some(b => (b as { type?: string }).type === 'tool_result')) continue
        text = content
          .filter(b => (b as { type?: string }).type === 'text')
          .map(b => (b as { text?: string }).text ?? '')
          .join('\n')
      }
      text = text.trim()
      if (!text) continue
      if (NOT_A_PROMPT.some(re => re.test(text))) continue
      return text
    }
  } catch { /* unreadable/truncated transcript: treat as no prompt */ } finally {
    rl.close()
    stream.destroy()
  }
  return null
}

/**
 * One-shot recovery of names for chats closed before tombstones existed.
 * Returns how many orphans were seen and how many got a usable name.
 */
export async function backfillClosedInstanceNames(): Promise<{ scanned: number; named: number }> {
  const orphans = findOrphans()
  if (orphans.length === 0) return { scanned: 0, named: 0 }

  const transcripts = indexTranscripts()
  const insert = db.prepare(`
    INSERT OR IGNORE INTO closed_instances
      (id, name, folder_id, cwd, session_id, name_source, closed_at)
    VALUES (?, ?, ?, NULL, ?, 'derived', ?)
  `)

  let named = 0
  for (const orphan of orphans) {
    let name: string | null = null
    let usedSession: string | null = null
    for (const sid of orphan.session_ids) {
      const file = transcripts.get(sid)
      if (!file) continue
      const prompt = await firstPrompt(file)
      const candidate = prompt ? toName(prompt) : null
      if (candidate) { name = candidate; usedSession = sid; break }
    }
    // Written even when name is null: the row is what stops the next boot from
    // re-walking a transcript that is not there.
    insert.run(orphan.id, name, orphan.folder_id, usedSession ?? orphan.session_ids[0] ?? null, orphan.last_at)
    if (name) named++
  }

  console.log(`[backfill] closed-chat names: ${named}/${orphans.length} recovered from transcripts`)
  return { scanned: orphans.length, named }
}
