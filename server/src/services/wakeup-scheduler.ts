import crypto from 'crypto'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { processRegistry, agentSlot } from './process-registry.js'
import { isClaimed, chatKey } from './turn-gate.js'

// Agent-initiated ONE-SHOT self-wakeups (ScheduleWakeup tool calls). User-defined
// RECURRING prompts live in routine-scheduler.ts — the two are deliberately separate.

export interface WakeupRow {
  id: string
  instance_id: string
  tool_use_id: string | null
  fire_at: number
  delay_seconds: number
  prompt: string
  reason: string | null
  // 'firing' is the short window while the turn is being started: not 'pending', so sendMessage's
  // own cancelPendingForInstance cannot cancel the wake-up that is sending it.
  status: 'pending' | 'firing' | 'fired' | 'cancelled' | 'failed'
  created_at: number
  fired_at: number | null
}

export interface ScheduledWakeup {
  id: string
  instanceId: string
  fireAt: number
  delaySeconds: number
  prompt: string
  reason: string | null
  status: WakeupRow['status']
  createdAt: number
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
let started = false

function rowToWakeup(r: WakeupRow): ScheduledWakeup {
  return {
    id: r.id,
    instanceId: r.instance_id,
    fireAt: r.fire_at,
    delaySeconds: r.delay_seconds,
    prompt: r.prompt,
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
  }
}

function arm(wakeup: WakeupRow): void {
  // Already armed — clear so we don't double-fire after a re-load.
  const existing = timers.get(wakeup.id)
  if (existing) clearTimeout(existing)

  const delay = Math.max(0, wakeup.fire_at - Date.now())
  const timer = setTimeout(() => fire(wakeup.id), delay)
  timers.set(wakeup.id, timer)
}

/** How long a wake-up waits when its chat is busy, or when a send fails, before trying again. */
export const WAKEUP_RETRY_MS = 60_000
/** Sends that may fail before a wake-up is given up on (a busy chat does not count). */
const MAX_SEND_ATTEMPTS = 3
const sendFailures = new Map<string, number>()

type Sender = (opts: { instanceId: string; text: string; cwd: string; sessionId?: string; origin: 'wakeup' }) => Promise<unknown>

/**
 * A chat is busy while a turn runs in it: tracked by the registry, or not idle in the DB, or a
 * turn is starting on it right now (turn-gate.ts). The agent limit being full
 * counts as busy too: the wake-up waits for a slot instead of failing its send attempts.
 */
function chatIsBusy(instanceId: string, processState: string | null): boolean {
  return processRegistry.isTracked(instanceId) || (processState != null && processState !== 'idle')
    || isClaimed(chatKey(instanceId)) || !agentSlot(instanceId).ok
}

/** Push a wake-up back by WAKEUP_RETRY_MS and re-arm it, keeping it pending. */
function rearm(wakeupId: string): void {
  db.prepare("UPDATE scheduled_wakeups SET status = 'pending', fire_at = ? WHERE id = ?").run(Date.now() + WAKEUP_RETRY_MS, wakeupId)
  const row = db.prepare('SELECT * FROM scheduled_wakeups WHERE id = ?').get(wakeupId) as WakeupRow | undefined
  if (row) {
    arm(row)
    broadcastEvent({ type: 'wakeup:scheduled', payload: rowToWakeup(row) })
  }
}

/**
 * Fire one wake-up.
 *
 * Two rules the old version broke:
 *   1. A wake-up never lands on a busy chat. sendMessage KILLS a running process before it spawns,
 *      so an agent still working when its own wake-up came due was killed mid-turn by it. Now the
 *      wake-up waits another minute instead, as many times as it takes.
 *   2. It is marked fired only once the turn actually started. It used to be marked first, so a
 *      send that failed was simply lost. A failed send goes back to pending and retries, and is
 *      given up on ('failed') only after MAX_SEND_ATTEMPTS.
 *
 * `send` is injectable for the test; the real one is sendMessage, imported lazily to avoid the
 * circular dependency with claude-process.
 */
export async function fireWakeup(wakeupId: string, send?: Sender): Promise<'fired' | 'deferred' | 'retry' | 'failed' | 'skipped'> {
  const pendingTimer = timers.get(wakeupId)
  if (pendingTimer) clearTimeout(pendingTimer)
  timers.delete(wakeupId)

  const row = db.prepare('SELECT * FROM scheduled_wakeups WHERE id = ?').get(wakeupId) as WakeupRow | undefined
  if (!row || row.status !== 'pending') return 'skipped'

  const instance = db.prepare('SELECT id, cwd, session_id, process_state FROM instances WHERE id = ?')
    .get(row.instance_id) as { id: string; cwd: string; session_id: string | null; process_state: string | null } | undefined
  if (!instance) {
    db.prepare("UPDATE scheduled_wakeups SET status = 'cancelled' WHERE id = ?").run(wakeupId)
    return 'skipped'
  }

  // The user stopped or paused this chat since the wake-up was scheduled: it does not start the
  // chat again on its own. The user stop hook cancels these
  // already; this is the check at the moment of firing.
  const paused = (db.prepare('SELECT state FROM instances WHERE id = ?').get(instance.id) as { state: string } | undefined)?.state === 'paused'
  // Only a wake-up scheduled BEFORE the stop: one a later turn scheduled (a routine's own
  // follow-up) is that turn's, not something the user stopped.
  if (paused || processRegistry.stoppedByUserSince(instance.id, row.created_at)) {
    db.prepare("UPDATE scheduled_wakeups SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(wakeupId)
    broadcastEvent({ type: 'wakeup:cancelled', payload: { instanceId: instance.id, wakeupId } })
    console.log(`[wakeup] ${wakeupId.slice(0, 8)} cancelled: its chat was ${paused ? 'paused' : 'stopped'} by the user`)
    return 'skipped'
  }

  if (chatIsBusy(instance.id, instance.process_state)) {
    console.log(`[wakeup] ${wakeupId.slice(0, 8)} due, but its chat is busy; trying again in ${WAKEUP_RETRY_MS / 1000}s`)
    rearm(wakeupId)
    return 'deferred'
  }

  // Claimed, not yet fired. Guarded on 'pending' so two timers can never both claim it.
  const claimed = db.prepare("UPDATE scheduled_wakeups SET status = 'firing' WHERE id = ? AND status = 'pending'").run(wakeupId)
  if (claimed.changes === 0) return 'skipped'

  // A wake-up is an autonomous fire too, so its chat surfaces exactly like a routine fire
  // does (grid tile, one glow, bright status until read). The surface itself is made inside
  // sendMessage from `origin: 'wakeup'` below, not here: one decision point for every path
  // (see turn-origins.ts). Silence is still read off the chat, so a wake-up scheduled from
  // inside a silent routine's run stays out of the grid.

  // Replace the autonomous-loop sentinel with a sensible default since OrcStrator has no /loop runtime.
  const prompt = row.prompt === '<<autonomous-loop-dynamic>>' || row.prompt === '<<autonomous-loop>>'
    ? 'Auto-scheduled check-in. Continue or report status.'
    : row.prompt

  const sender: Sender = send ?? (async (o) => (await import('./claude-process.js')).sendMessage(o))
  try {
    await sender({
      instanceId: row.instance_id,
      text: prompt,
      cwd: instance.cwd,
      sessionId: instance.session_id ?? undefined,
      origin: 'wakeup',
    })
  } catch (err) {
    // The turn never started (spawn failure, a race with a manual send). sendMessage takes its
    // own surface back, by the exact timestamp it wrote.
    const failures = (sendFailures.get(wakeupId) ?? 0) + 1
    sendFailures.set(wakeupId, failures)
    if (failures >= MAX_SEND_ATTEMPTS) {
      console.error(`[wakeup] ${wakeupId.slice(0, 8)} failed to send ${failures} times, giving up:`, err)
      sendFailures.delete(wakeupId)
      db.prepare("UPDATE scheduled_wakeups SET status = 'failed' WHERE id = ?").run(wakeupId)
      broadcastEvent({ type: 'wakeup:cancelled', payload: { instanceId: row.instance_id, wakeupId } })
      return 'failed'
    }
    console.error(`[wakeup] ${wakeupId.slice(0, 8)} failed to send (attempt ${failures}), retrying in ${WAKEUP_RETRY_MS / 1000}s:`, err)
    rearm(wakeupId)
    return 'retry'
  }

  sendFailures.delete(wakeupId)
  db.prepare("UPDATE scheduled_wakeups SET status = 'fired', fired_at = ? WHERE id = ?").run(Date.now(), wakeupId)
  broadcastEvent({ type: 'wakeup:fired', payload: { instanceId: row.instance_id, wakeupId } })
  return 'fired'
}

function fire(wakeupId: string): Promise<unknown> {
  return fireWakeup(wakeupId).catch(err => console.error(`[wakeup] fire ${wakeupId.slice(0, 8)} crashed:`, err))
}

export function scheduleWakeup(opts: {
  instanceId: string
  delaySeconds: number
  prompt: string
  reason?: string
  toolUseId?: string
}): ScheduledWakeup {
  const clamped = Math.max(60, Math.min(3600, Math.round(opts.delaySeconds)))
  const id = crypto.randomUUID()
  const now = Date.now()
  const fireAt = now + clamped * 1000

  // The same tool call seen twice (a resumed stream re-sends it) is ONE wake-up,
  // and a chat may have at most MAX_PENDING_PER_CHAT waiting: an agent that queued dozens
  // had them all fire together. Checked and inserted in one transaction.
  const existing = db.transaction(() => {
    if (opts.toolUseId) {
      const dup = db.prepare('SELECT id FROM scheduled_wakeups WHERE instance_id = ? AND tool_use_id = ?')
        .get(opts.instanceId, opts.toolUseId) as { id: string } | undefined
      if (dup) return dup.id
    }
    const pending = (db.prepare("SELECT COUNT(*) AS n FROM scheduled_wakeups WHERE instance_id = ? AND status = 'pending'")
      .get(opts.instanceId) as { n: number }).n
    if (pending >= MAX_PENDING_PER_CHAT) throw new WakeupCapError(MAX_PENDING_PER_CHAT)
    db.prepare(`
      INSERT INTO scheduled_wakeups
        (id, instance_id, tool_use_id, fire_at, delay_seconds, prompt, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, opts.instanceId, opts.toolUseId ?? null, fireAt, clamped, opts.prompt, opts.reason ?? null, now)
    return null
  }).immediate()
  if (existing) return rowToWakeup(db.prepare('SELECT * FROM scheduled_wakeups WHERE id = ?').get(existing) as WakeupRow)

  const row = db.prepare('SELECT * FROM scheduled_wakeups WHERE id = ?').get(id) as WakeupRow
  arm(row)

  const wakeup = rowToWakeup(row)
  broadcastEvent({ type: 'wakeup:scheduled', payload: wakeup })
  return wakeup
}

/** Pending wake-ups one chat may hold at once. */
export const MAX_PENDING_PER_CHAT = 5

export class WakeupCapError extends Error {
  constructor(max: number) {
    super(`This chat already has ${max} wake-ups waiting, so a new one was not scheduled. Cancel one first.`)
  }
}

/**
 * Cancel a pending wake-up. With `instanceId`, only one belonging to that chat
 * (the route used to ignore the chat id in its URL, so any chat could cancel any other's).
 */
export function cancelWakeup(wakeupId: string, instanceId?: string): boolean {
  if (instanceId !== undefined) {
    const owner = db.prepare('SELECT instance_id FROM scheduled_wakeups WHERE id = ?').get(wakeupId) as { instance_id: string } | undefined
    if (!owner || owner.instance_id !== instanceId) return false
  }
  const timer = timers.get(wakeupId)
  if (timer) {
    clearTimeout(timer)
    timers.delete(wakeupId)
  }
  const result = db.prepare("UPDATE scheduled_wakeups SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
    .run(wakeupId)
  if (result.changes > 0) {
    const row = db.prepare('SELECT instance_id FROM scheduled_wakeups WHERE id = ?').get(wakeupId) as { instance_id: string } | undefined
    if (row) {
      broadcastEvent({ type: 'wakeup:cancelled', payload: { instanceId: row.instance_id, wakeupId } })
    }
    return true
  }
  return false
}

// Cancel all pending wake-ups for an instance — called when the user sends a manual
// message so an in-flight auto-check doesn't interrupt the conversation.
export function cancelPendingForInstance(instanceId: string): number {
  const rows = db.prepare("SELECT id FROM scheduled_wakeups WHERE instance_id = ? AND status = 'pending'")
    .all(instanceId) as Array<{ id: string }>
  let cancelled = 0
  for (const r of rows) {
    if (cancelWakeup(r.id)) cancelled++
  }
  return cancelled
}

export function getPendingForInstance(instanceId: string): ScheduledWakeup[] {
  const rows = db.prepare(
    "SELECT * FROM scheduled_wakeups WHERE instance_id = ? AND status = 'pending' ORDER BY fire_at ASC"
  ).all(instanceId) as WakeupRow[]
  return rows.map(rowToWakeup)
}

export function getAllPending(): ScheduledWakeup[] {
  const rows = db.prepare("SELECT * FROM scheduled_wakeups WHERE status = 'pending' ORDER BY fire_at ASC")
    .all() as WakeupRow[]
  return rows.map(rowToWakeup)
}

export function startWakeupScheduler(): void {
  if (started) return
  started = true
  // A 'firing' row means the server stopped between claiming a wake-up and starting its turn,
  // so the turn never started: it is pending again, not lost.
  db.prepare("UPDATE scheduled_wakeups SET status = 'pending' WHERE status = 'firing'").run()
  const pending = db.prepare("SELECT * FROM scheduled_wakeups WHERE status = 'pending'").all() as WakeupRow[]
  for (const row of pending) arm(row)
  console.log(`[wakeup] Scheduler started — re-armed ${pending.length} pending wake-up(s)`)
}

export function stopWakeupScheduler(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  started = false
}
