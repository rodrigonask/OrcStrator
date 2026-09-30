import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { CLAUDE_PROJECTS_DIR } from './claude-paths.js'

/**
 * One cached index of every Claude Code transcript on disk.
 *
 * There are 6,500+ of these files here (20+ GB), and before this module every route that
 * needed ONE of them re-walked the whole tree and re-stat'ed all of them: listing the
 * Sessions page did it once, then each "Stats" click did it again, and so did each
 * summary request. The walk also fired all 6,500 stats through a single Promise.all,
 * which queues every one of them on libuv's 4-thread pool at once.
 *
 * The index is shared, TTL'd, and stats in bounded batches instead.
 *
 * The directory walk itself used to be synchronous, so opening the Sessions page
 * froze every chat's live output for about a tenth of a second (more as transcripts pile
 * up). It is asynchronous now. And a lookup for a session that is not there used to force a
 * full rebuild every single time; a miss is now remembered for the same 10 seconds.
 */

// Re-exported so the routes that already import it from here keep working.
export { CLAUDE_PROJECTS_DIR }

export interface SessionEntry {
  sessionId: string
  filePath: string
  mtime: number
  size: number
  /** Top-level ~/.claude/projects slug the file lives under. */
  projectSlug: string
  /** Sub-agent transcripts live at <slug>/<parentSessionId>/subagents/agent-*.jsonl. */
  isSubagent: boolean
  parentSessionId?: string
}

/**
 * Where a transcript sits in the tree. A normal session is <slug>/<sessionId>.jsonl;
 * a sub-agent run is <slug>/<parentSessionId>/subagents/agent-<id>.jsonl (roughly one
 * file in nine, mostly noise), and not something you would ever scroll past on purpose.
 */
function classify(filePath: string): Pick<SessionEntry, 'projectSlug' | 'isSubagent' | 'parentSessionId'> {
  const parts = path.relative(CLAUDE_PROJECTS_DIR, filePath).split(path.sep)
  const projectSlug = parts[0] ?? ''
  if (parts.length >= 4 && parts[parts.length - 2] === 'subagents') {
    return { projectSlug, isSubagent: true, parentSessionId: parts[1] }
  }
  return { projectSlug, isSubagent: false }
}

const TTL_MS = 10_000
/** How long "that session is not on disk" is believed before a lookup may force a rebuild again. */
const MISS_TTL_MS = 10_000
const MAX_DEPTH = 3
const STAT_BATCH = 64

let cache: { at: number; entries: SessionEntry[] } | null = null
let inFlight: Promise<SessionEntry[]> | null = null
/** sessionId -> when a forced rebuild last failed to find it. */
const misses = new Map<string, number>()

async function collectJsonlFiles(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await collectJsonlFiles(full, depth + 1, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
  }
}

async function build(): Promise<SessionEntry[]> {
  const files: string[] = []
  // A missing folder is just an empty list: readdir fails and the walk returns nothing.
  await collectJsonlFiles(CLAUDE_PROJECTS_DIR, 0, files)

  const entries: SessionEntry[] = []
  for (let i = 0; i < files.length; i += STAT_BATCH) {
    const batch = files.slice(i, i + STAT_BATCH)
    const stats = await Promise.all(
      batch.map(async (filePath) => {
        try {
          const stat = await fsp.stat(filePath)
          return {
            sessionId: path.basename(filePath, '.jsonl'),
            filePath,
            mtime: stat.mtimeMs,
            size: stat.size,
            ...classify(filePath),
          }
        } catch {
          return null
        }
      })
    )
    for (const s of stats) if (s) entries.push(s)
  }

  entries.sort((a, b) => b.mtime - a.mtime)
  return entries
}

/** Newest-first list of every transcript. Cached for {@link TTL_MS}; concurrent callers share one walk. */
export async function getSessionIndex(force = false): Promise<SessionEntry[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.entries
  if (inFlight) return inFlight
  inFlight = build()
    .then((entries) => {
      cache = { at: Date.now(), entries }
      return entries
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

export async function findSessionEntry(sessionId: string): Promise<SessionEntry | null> {
  const entries = await getSessionIndex()
  const hit = entries.find((e) => e.sessionId === sessionId)
  if (hit) {
    misses.delete(sessionId)
    return hit
  }
  // Looked for and not found moments ago: the whole tree was just walked for it, so a second
  // walk would only find the same nothing. The normal TTL rebuild above still picks it up.
  const missedAt = misses.get(sessionId)
  if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return null
  // A session created seconds ago is not in a cached index yet: one forced rebuild, then give up.
  const fresh = await getSessionIndex(true)
  const found = fresh.find((e) => e.sessionId === sessionId) ?? null
  if (found) {
    misses.delete(sessionId)
  } else {
    // Keep the map from growing without bound on a stream of junk ids.
    if (misses.size > 1000) {
      const now = Date.now()
      for (const [id, at] of misses) if (now - at >= MISS_TTL_MS) misses.delete(id)
      if (misses.size > 1000) misses.clear()
    }
    misses.set(sessionId, Date.now())
  }
  return found
}

/**
 * The cwd a transcript belongs to, read from the file's own entries rather than guessed
 * from the directory slug (the slug is lossy: it flattens both separators and case).
 * Reads a bounded head of the file, since these run to hundreds of MB.
 */
export async function readSessionCwd(filePath: string): Promise<string | null> {
  let handle: fsp.FileHandle | null = null
  try {
    handle = await fsp.open(filePath, 'r')
    const buf = Buffer.alloc(256 * 1024)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const text = buf.toString('utf-8', 0, bytesRead)
    for (const line of text.split('\n')) {
      if (!line.trim() || !line.includes('"cwd"')) continue
      try {
        const entry = JSON.parse(line) as { cwd?: unknown }
        if (typeof entry.cwd === 'string' && entry.cwd) return entry.cwd
      } catch {
        // Last line of a bounded read is usually truncated: expected, keep going.
      }
    }
    return null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}
