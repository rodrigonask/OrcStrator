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
// Liveness: mtime POLLING over the task files of sessions we actually have instances
// for, debounced per session. NOT fs.watch. See startNativeTaskWatcher for why.
// If polling can't run, /state hydration still serves the panel; it just stops
// updating mid-turn rather than breaking.
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import type { NativeTask } from '@orcstrator/shared'

const TASKS_ROOT = join(homedir(), '.claude', 'tasks')
const DEBOUNCE_MS = 120
const POLL_INTERVAL_MS = 600

const VALID_STATUS = new Set(['pending', 'in_progress', 'completed'])

/**
 * Read one session's native task list. Returns [] for an unknown/absent session —
 * an absent directory is the normal case (it only appears on the first TaskCreate).
 */
export function readNativeTasks(sessionId: string | null | undefined): NativeTask[] {
  if (!sessionId) return []
  const dir = join(TASKS_ROOT, sessionId)
  if (!existsSync(dir)) return []

  let names: string[]
  try {
    // Numeric names only: skips the CLI's `.lock` file and anything else in there.
    names = readdirSync(dir).filter(n => /^\d+\.json$/.test(n))
  } catch {
    return []
  }

  const tasks: NativeTask[] = []
  for (const name of names) {
    try {
      const path = join(dir, name)
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      const status = raw.status as string
      if (!VALID_STATUS.has(status)) continue // e.g. a status we don't know yet
      // The CLI writes no timestamp, but it rewrites the whole file on every TaskUpdate,
      // so the file's mtime is exactly when this task last changed status. That is what
      // lets the panel keep the current work on screen and let an hour-old finished task
      // scroll up out of the way, instead of showing a session's entire history at once.
      let updatedAt: number | undefined
      try {
        updatedAt = statSync(path).mtimeMs
      } catch {
        // Vanished between readdir and stat: leave it undefined, the client treats a task
        // with no timestamp as current rather than hiding it.
      }
      tasks.push({
        id: String(raw.id ?? name.replace('.json', '')),
        subject: String(raw.subject ?? ''),
        activeForm: raw.activeForm ? String(raw.activeForm) : undefined,
        status: status as NativeTask['status'],
        blockedBy: Array.isArray(raw.blockedBy) ? (raw.blockedBy as unknown[]).map(String) : [],
        updatedAt,
      })
    } catch {
      // A write may be in flight (the CLI writes under a lock, we read without one).
      // Skipping the half-written file is correct: the watcher fires again on completion.
    }
  }

  // id doubles as creation order.
  return tasks.sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0))
}

/** Push a session's list to every instance bound to that session id. */
function pushForSession(sessionId: string): void {
  let rows: Array<{ id: string }>
  try {
    rows = db.prepare('SELECT id FROM instances WHERE session_id = ?').all(sessionId) as Array<{ id: string }>
  } catch {
    return
  }
  if (rows.length === 0) return // a terminal session with no OrcStrator instance

  const nativeTasks = readNativeTasks(sessionId)
  for (const row of rows) {
    broadcastEvent({ type: 'instance:updated', payload: { id: row.id, nativeTasks } })
  }
}

let pollTimer: NodeJS.Timeout | null = null
const debounces = new Map<string, NodeJS.Timeout>()

/** sessionId -> "name:mtime|name:mtime|..." for that session's task files. */
const signatures = new Map<string, string>()

let boundStmt: { all: () => Array<{ session_id: string }> } | null = null

/**
 * Session ids that at least one instance is bound to. Polling is scoped to these on
 * purpose: `~/.claude/tasks` accumulates a directory per session forever (hundreds of
 * files on a busy install, and it only grows), while the instances table is
 * bounded by what the user actually has open. Scoping keeps the per-tick cost flat over
 * time instead of creeping up for the rest of the install's life. A session with no
 * instance has nowhere to push to anyway: pushForSession would bail on it.
 */
function boundSessionIds(): string[] {
  try {
    if (!boundStmt) {
      boundStmt = db.prepare(
        "SELECT DISTINCT session_id FROM instances WHERE session_id IS NOT NULL AND session_id != ''",
      ) as unknown as { all: () => Array<{ session_id: string }> }
    }
    return boundStmt.all().map(r => r.session_id)
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
function signatureFor(sessionId: string): string {
  const dir = join(TASKS_ROOT, sessionId)
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => /^\d+\.json$/.test(n))
  } catch {
    return '' // absent directory is the normal case before the first TaskCreate
  }
  names.sort()
  let sig = ''
  for (const n of names) {
    try {
      sig += `${n}:${statSync(join(dir, n)).mtimeMs}|`
    } catch {
      // vanished mid-scan; the next tick sees the settled state
    }
  }
  return sig
}

function schedulePush(sessionId: string): void {
  const pending = debounces.get(sessionId)
  if (pending) clearTimeout(pending)
  debounces.set(
    sessionId,
    setTimeout(() => {
      debounces.delete(sessionId)
      try {
        pushForSession(sessionId)
      } catch (err) {
        console.warn('[native-tasks] push failed:', err)
      }
    }, DEBOUNCE_MS),
  )
}

let tickFailures = 0

function tick(): void {
  try {
    const ids = boundSessionIds()
    const live = new Set(ids)
    for (const sessionId of ids) {
      const sig = signatureFor(sessionId)
      const prev = signatures.get(sessionId)
      signatures.set(sessionId, sig)
      // A first sighting is not a change: the client already got this list from /state.
      if (prev === undefined || prev === sig) continue
      console.log(`[native-tasks] change in ${sessionId.slice(0, 8)}`)
      schedulePush(sessionId)
    }
    // Drop sessions no instance points at any more, so the map cannot grow forever.
    for (const known of signatures.keys()) if (!live.has(known)) signatures.delete(known)
    tickFailures = 0
  } catch (err) {
    // Never let a throw escape into the interval and silently end live updates.
    if (tickFailures++ % 50 === 0) {
      console.warn(`[native-tasks] poll failed (${tickFailures}x), live updates degraded:`, err)
    }
  }
}

/**
 * Start watching the native tasks root. Idempotent. Safe to call before the directory
 * exists (we create it empty) and safe to call when the CLI never writes tasks at all.
 *
 * This POLLS mtimes rather than using fs.watch. `dev-watch.mjs` had to make the same
 * swap (commit 4de5208): on Windows, recursive fs.watch silently drops events, and it
 * did so for an entire 9h session, leaving the server running stale code. The failure is
 * invisible from the outside, which is the worst property a watcher can have, and this
 * module had inherited exactly that pattern. Polling is boring and it always fires.
 *
 * Cost: one readdir plus one stat per task file, over bound sessions only. Even dozens of
 * sessions and a few hundred files come to a few milliseconds per tick.
 */
export function startNativeTaskWatcher(): void {
  if (pollTimer) return
  try {
    if (!existsSync(TASKS_ROOT)) mkdirSync(TASKS_ROOT, { recursive: true })
  } catch {
    // Can't create it: signatureFor() returns '' for every session until it appears.
  }

  // Seed the signatures so the first tick does not push a "change" for every session.
  for (const sessionId of boundSessionIds()) signatures.set(sessionId, signatureFor(sessionId))

  pollTimer = setInterval(tick, POLL_INTERVAL_MS)
  pollTimer.unref?.()
  console.log(
    `[native-tasks] polling ${TASKS_ROOT} every ${POLL_INTERVAL_MS}ms ` +
      `(${signatures.size} bound session(s))`,
  )
}

/** Stop watching (test teardown / shutdown). */
export function stopNativeTaskWatcher(): void {
  for (const t of debounces.values()) clearTimeout(t)
  debounces.clear()
  signatures.clear()
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
