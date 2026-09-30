// Viewer for Claude Code's NATIVE task list.
//
// The CLI's own TaskCreate/TaskUpdate tools write one JSON file per task to
// `~/.claude/tasks/<session-id>/<n>.json`, and read those same files back to render
// the ctrl+t panel in the terminal. This module reads them. It never writes them.
//
// That read-only stance is the whole design. The alternatives were both worse:
//   - parsing TaskCreate/TaskUpdate out of the stream: they are DELTAS, so you have
//     to replay them in order, and a subagent's calls look identical to the lead's
//   - mirroring into a DB column: a second copy of the truth is a second thing to
//     desync (from a resumed session, a terminal running alongside, a subagent)
// Reading the files means whatever the CLI thinks is true is what we show.
//
// Liveness: mtime POLLING over the task files of sessions whose chat is running,
// debounced per session. NOT fs.watch. See startNativeTaskWatcher for why.
// If polling can't run, /state hydration still serves the panel; it just stops
// updating mid-turn rather than breaking.
//
// The poller used to scan with synchronous disk calls every 600 ms,
// across every chat that had ever had a session, and /state then read every chat's task
// files from disk AGAIN, synchronously, on each app load. Both held up every chat's live
// output. Now the poller reads asynchronously, only for chats that are actually running
// (plus a slow sweep of the rest), and keeps what it read in memory, which is what /state
// serves.
import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import fsp from 'fs/promises'
import { join } from 'path'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { claudeDir } from './claude-paths.js'
import { isValidSessionId } from './session-id.js'
import type { NativeTask } from '@orcstrator/shared'

const TASKS_ROOT = join(claudeDir(), 'tasks')
const DEBOUNCE_MS = 120
const POLL_INTERVAL_MS = 600
/**
 * Every this many ticks (about 30 s) the sessions of idle chats are checked too. Nothing in
 * this app writes their task files while the chat is idle, but a terminal resuming the same
 * session can, and this bounds how stale such a list can get.
 */
const SWEEP_EVERY_TICKS = 50
/**
 * A chat is still polled this long after it stops running, so the last TaskUpdate of a turn
 * (written moments before the turn ends) is not missed by a tick that lands just after.
 */
const RUNNING_GRACE_MS = 10_000

const VALID_STATUS = new Set(['pending', 'in_progress', 'completed'])
// Numeric names only: skips the CLI's `.lock` file and anything else in there.
const TASK_FILE = /^\d+\.json$/

/** Turn one parsed task file into the shape the panel shows, or null to skip it. */
function toTask(raw: Record<string, unknown>, name: string, updatedAt: number | undefined): NativeTask | null {
  const status = raw.status as string
  if (!VALID_STATUS.has(status)) return null // e.g. a status we don't know yet
  return {
    id: String(raw.id ?? name.replace('.json', '')),
    subject: String(raw.subject ?? ''),
    activeForm: raw.activeForm ? String(raw.activeForm) : undefined,
    status: status as NativeTask['status'],
    blockedBy: Array.isArray(raw.blockedBy) ? (raw.blockedBy as unknown[]).map(String) : [],
    updatedAt,
  }
}

// id doubles as creation order.
const byId = (a: NativeTask, b: NativeTask) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0)

/**
 * Read one session's native task list straight from disk, synchronously. Returns [] for an
 * unknown/absent session: an absent directory is the normal case (it only appears on the
 * first TaskCreate). Kept for the one-off summary path; hot paths use {@link getNativeTasks}.
 */
export function readNativeTasks(sessionId: string | null | undefined): NativeTask[] {
  if (!sessionId || !isValidSessionId(sessionId)) return []
  const dir = join(TASKS_ROOT, sessionId)
  if (!existsSync(dir)) return []

  let names: string[]
  try {
    names = readdirSync(dir).filter(n => TASK_FILE.test(n))
  } catch {
    return []
  }

  const tasks: NativeTask[] = []
  for (const name of names) {
    try {
      const path = join(dir, name)
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      let updatedAt: number | undefined
      try { updatedAt = statSync(path).mtimeMs } catch { /* vanished: treated as current */ }
      const task = toTask(raw, name, updatedAt)
      if (task) tasks.push(task)
    } catch {
      // A write may be in flight (the CLI writes under a lock, we read without one).
    }
  }
  return tasks.sort(byId)
}

/** The same read as {@link readNativeTasks}, without blocking the event loop. */
async function loadNativeTasks(sessionId: string): Promise<NativeTask[]> {
  if (!isValidSessionId(sessionId)) return []
  const dir = join(TASKS_ROOT, sessionId)
  let names: string[]
  try {
    names = (await fsp.readdir(dir)).filter(n => TASK_FILE.test(n))
  } catch {
    return [] // absent directory is the normal case before the first TaskCreate
  }
  const read = await Promise.all(names.map(async (name): Promise<NativeTask | null> => {
    const path = join(dir, name)
    try {
      const raw = JSON.parse(await fsp.readFile(path, 'utf8')) as Record<string, unknown>
      // The CLI writes no timestamp, but it rewrites the whole file on every TaskUpdate,
      // so the file's mtime is exactly when this task last changed status. That is what
      // lets the panel keep the current work on screen and let an hour-old finished task
      // scroll up out of the way, instead of showing a session's entire history at once.
      let updatedAt: number | undefined
      try {
        updatedAt = (await fsp.stat(path)).mtimeMs
      } catch {
        // Vanished between readdir and stat: leave it undefined, the client treats a task
        // with no timestamp as current rather than hiding it.
      }
      return toTask(raw, name, updatedAt)
    } catch {
      // A write may be in flight (the CLI writes under a lock, we read without one).
      // Skipping the half-written file is correct: the poller fires again on completion.
      return null
    }
  }))
  return read.filter((t): t is NativeTask => t !== null).sort(byId)
}

/** sessionId -> the task list last read for it. What /state serves. */
const tasksCache = new Map<string, NativeTask[]>()
const loading = new Map<string, Promise<NativeTask[]>>()

/** Read a session's list from disk (asynchronously) and remember it. Concurrent callers share one read. */
function refreshTasks(sessionId: string): Promise<NativeTask[]> {
  const pending = loading.get(sessionId)
  if (pending) return pending
  const p = loadNativeTasks(sessionId)
    .then(tasks => { tasksCache.set(sessionId, tasks); return tasks })
    .finally(() => loading.delete(sessionId))
  loading.set(sessionId, p)
  return p
}

/**
 * One session's native task list, from memory. Only a session not seen before is read
 * from disk, once, asynchronously; after that the poller keeps the copy current.
 */
export async function getNativeTasks(sessionId: string | null | undefined): Promise<NativeTask[]> {
  if (!sessionId || !isValidSessionId(sessionId)) return []
  const hit = tasksCache.get(sessionId)
  if (hit) return hit
  return refreshTasks(sessionId)
}

/** Push a session's list to every instance bound to that session id. */
async function pushForSession(sessionId: string): Promise<void> {
  let rows: Array<{ id: string }>
  try {
    rows = db.prepare('SELECT id FROM instances WHERE session_id = ?').all(sessionId) as Array<{ id: string }>
  } catch {
    return
  }
  if (rows.length === 0) return // a terminal session with no OrcStrator instance
  const nativeTasks = await refreshTasks(sessionId)
  for (const row of rows) {
    broadcastEvent({ type: 'instance:updated', payload: { id: row.id, nativeTasks } })
  }
}

let pollTimer: NodeJS.Timeout | null = null
const debounces = new Map<string, NodeJS.Timeout>()

/** sessionId -> "name:mtime|name:mtime|..." for that session's task files. */
const signatures = new Map<string, string>()
/** sessionId -> when its chat was last seen running, for {@link RUNNING_GRACE_MS}. */
const lastRunning = new Map<string, number>()

type SessionRow = { session_id: string; running: number }
let boundStmt: { all: () => SessionRow[] } | null = null

/**
 * Session ids that at least one instance is bound to, and whether any of those chats is
 * running. Polling is scoped to these on purpose: `~/.claude/tasks` accumulates a directory
 * per session forever (hundreds of files on a busy install, and it only grows), while the
 * instances table is bounded by what the user actually has open. A session with no instance
 * has nowhere to push to anyway.
 */
function boundSessions(): SessionRow[] {
  try {
    if (!boundStmt) {
      boundStmt = db.prepare(
        `SELECT session_id,
                MAX(CASE WHEN state = 'running' OR process_state IN ('spawning', 'running') THEN 1 ELSE 0 END) AS running
           FROM instances
          WHERE session_id IS NOT NULL AND session_id != ''
          GROUP BY session_id`,
      ) as unknown as { all: () => SessionRow[] }
    }
    return boundStmt.all().filter(r => isValidSessionId(r.session_id))
  } catch {
    return []
  }
}

/**
 * Cheap fingerprint of one session's task files.
 *
 * Deliberately per FILE, not the cheaper single stat of the session directory. Measured
 * against the real CLI, a TaskUpdate moves the directory's mtime too, because the CLI replaces
 * the file rather than rewriting it in place (the directory's new mtime came back exactly
 * equal to the rewritten task file's). But that is a property of how the CLI happens to
 * write today, not a contract: switch it to an in-place rewrite and the directory mtime
 * stops moving, and every status flip becomes invisible. Per-file costs one extra stat
 * per task and does not depend on the writer's strategy.
 */
async function signatureFor(sessionId: string): Promise<string> {
  const dir = join(TASKS_ROOT, sessionId)
  let names: string[]
  try {
    names = (await fsp.readdir(dir)).filter(n => TASK_FILE.test(n))
  } catch {
    return '' // absent directory is the normal case before the first TaskCreate
  }
  names.sort()
  const parts = await Promise.all(names.map(async n => {
    try {
      return `${n}:${(await fsp.stat(join(dir, n))).mtimeMs}|`
    } catch {
      return '' // vanished mid-scan; the next tick sees the settled state
    }
  }))
  return parts.join('')
}

function schedulePush(sessionId: string): void {
  const pending = debounces.get(sessionId)
  if (pending) clearTimeout(pending)
  debounces.set(
    sessionId,
    setTimeout(() => {
      debounces.delete(sessionId)
      pushForSession(sessionId).catch(err => console.warn('[native-tasks] push failed:', err))
    }, DEBOUNCE_MS),
  )
}

let tickFailures = 0
let tickCount = 0
let ticking = false

async function tick(): Promise<void> {
  // A slow disk can make one pass outlast the interval; never stack a second on top of it.
  if (ticking) return
  ticking = true
  try {
    const rows = boundSessions()
    const now = Date.now()
    const sweep = ++tickCount % SWEEP_EVERY_TICKS === 0
    const live = new Set<string>()
    const toPoll: string[] = []
    for (const r of rows) {
      live.add(r.session_id)
      if (r.running) lastRunning.set(r.session_id, now)
      const recent = now - (lastRunning.get(r.session_id) ?? -Infinity) < RUNNING_GRACE_MS
      if (sweep || recent) toPoll.push(r.session_id)
    }
    const sigs = await Promise.all(toPoll.map(id => signatureFor(id)))
    toPoll.forEach((sessionId, i) => {
      const sig = sigs[i]
      const prev = signatures.get(sessionId)
      signatures.set(sessionId, sig)
      if (prev === undefined) {
        // A first sighting is not a change: the client already got this list from /state.
        // But a copy already in memory may predate these files, so read it again next time.
        if (sig) tasksCache.delete(sessionId)
        return
      }
      if (prev === sig) return
      console.log(`[native-tasks] change in ${sessionId.slice(0, 8)}`)
      schedulePush(sessionId)
    })
    // Drop sessions no instance points at any more, so the maps cannot grow forever.
    for (const known of signatures.keys()) if (!live.has(known)) signatures.delete(known)
    for (const known of lastRunning.keys()) if (!live.has(known)) lastRunning.delete(known)
    for (const known of tasksCache.keys()) if (!live.has(known)) tasksCache.delete(known)
    tickFailures = 0
  } catch (err) {
    // Never let a throw escape into the interval and silently end live updates.
    if (tickFailures++ % 50 === 0) {
      console.warn(`[native-tasks] poll failed (${tickFailures}x), live updates degraded:`, err)
    }
  } finally {
    ticking = false
  }
}

/**
 * Start watching the native tasks root. Idempotent. Safe to call before the directory
 * exists (we create it empty) and safe to call when the CLI never writes tasks at all.
 *
 * This POLLS mtimes rather than using fs.watch. `dev-watch.mjs` had to make the same
 * swap: on Windows, recursive fs.watch silently drops events, and it
 * did so for an entire 9h session, leaving the server running stale code. The failure is
 * invisible from the outside, which is the worst property a watcher can have, and this
 * module had inherited exactly that pattern. Polling is boring and it always fires.
 *
 * Cost: one asynchronous readdir plus one stat per task file, over running chats only.
 */
export function startNativeTaskWatcher(): void {
  if (pollTimer) return
  fsp.mkdir(TASKS_ROOT, { recursive: true }).catch(() => {
    // Can't create it: signatureFor() returns '' for every session until it appears.
  })

  // Seed the signatures so the first tick does not push a "change" for every session, and
  // warm the cache so the first /state after boot is served from memory too.
  const seed = boundSessions().map(r => r.session_id)
  void Promise.all(seed.map(async sessionId => {
    signatures.set(sessionId, await signatureFor(sessionId))
    await refreshTasks(sessionId)
  })).catch(() => {})

  pollTimer = setInterval(() => { void tick() }, POLL_INTERVAL_MS)
  pollTimer.unref?.()
  console.log(
    `[native-tasks] polling ${TASKS_ROOT} every ${POLL_INTERVAL_MS}ms for running chats ` +
      `(${seed.length} bound session(s))`,
  )
}

/** Stop watching (test teardown / shutdown). */
export function stopNativeTaskWatcher(): void {
  for (const t of debounces.values()) clearTimeout(t)
  debounces.clear()
  signatures.clear()
  lastRunning.clear()
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
