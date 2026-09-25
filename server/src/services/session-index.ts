import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

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
 */

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

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
const MAX_DEPTH = 3
const STAT_BATCH = 64

let cache: { at: number; entries: SessionEntry[] } | null = null
let inFlight: Promise<SessionEntry[]> | null = null

function collectJsonlFiles(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectJsonlFiles(full, depth + 1, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
  }
}

async function build(): Promise<SessionEntry[]> {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return []

  const files: string[] = []
  collectJsonlFiles(CLAUDE_PROJECTS_DIR, 0, files)

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
  if (hit) return hit
  // A session created seconds ago is not in a cached index yet — one forced rebuild, then give up.
  const fresh = await getSessionIndex(true)
  return fresh.find((e) => e.sessionId === sessionId) ?? null
}

/**
 * The cwd a transcript belongs to, read from the file's own entries rather than guessed
 * from the directory slug (the slug is lossy: it flattens both separators and case).
 * Reads a bounded head of the file — these run to hundreds of MB.
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
        // Last line of a bounded read is usually truncated — expected, keep going.
      }
    }
    return null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}
