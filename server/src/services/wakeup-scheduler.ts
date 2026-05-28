import crypto from 'crypto'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'

export interface WakeupRow {
  id: string
  instance_id: string
  tool_use_id: string | null
  fire_at: number
  delay_seconds: number
  prompt: string
  reason: string | null
  status: 'pending' | 'fired' | 'cancelled'
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

async function fire(wakeupId: string): Promise<void> {
  timers.delete(wakeupId)

  const row = db.prepare('SELECT * FROM scheduled_wakeups WHERE id = ?').get(wakeupId) as WakeupRow | undefined
  if (!row || row.status !== 'pending') return

  const instance = db.prepare('SELECT id, cwd, session_id FROM instances WHERE id = ?')
    .get(row.instance_id) as { id: string; cwd: string; session_id: string | null } | undefined
  if (!instance) {
    db.prepare("UPDATE scheduled_wakeups SET status = 'cancelled' WHERE id = ?").run(wakeupId)
    return
  }

  db.prepare("UPDATE scheduled_wakeups SET status = 'fired', fired_at = ? WHERE id = ?")
    .run(Date.now(), wakeupId)

  broadcastEvent({ type: 'wakeup:fired', payload: { instanceId: row.instance_id, wakeupId } })

  // Replace the autonomous-loop sentinel with a sensible default since OrcStrator has no /loop runtime.
  const prompt = row.prompt === '<<autonomous-loop-dynamic>>' || row.prompt === '<<autonomous-loop>>'
    ? 'Auto-scheduled check-in. Continue or report status.'
    : row.prompt

  // Lazy import to avoid circular dependency between claude-process and this scheduler.
  const { sendMessage } = await import('./claude-process.js')
  try {
    await sendMessage({
      instanceId: row.instance_id,
      text: prompt,
      cwd: instance.cwd,
      sessionId: instance.session_id ?? undefined,
    })
  } catch (err) {
    console.error(`[wakeup] Failed to fire wakeup ${wakeupId}:`, err)
  }
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

  db.prepare(`
    INSERT INTO scheduled_wakeups
      (id, instance_id, tool_use_id, fire_at, delay_seconds, prompt, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, opts.instanceId, opts.toolUseId ?? null, fireAt, clamped, opts.prompt, opts.reason ?? null, now)

  const row = db.prepare('SELECT * FROM scheduled_wakeups WHERE id = ?').get(id) as WakeupRow
  arm(row)

  const wakeup = rowToWakeup(row)
  broadcastEvent({ type: 'wakeup:scheduled', payload: wakeup })
  return wakeup
}

export function cancelWakeup(wakeupId: string): boolean {
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
  const pending = db.prepare("SELECT * FROM scheduled_wakeups WHERE status = 'pending'").all() as WakeupRow[]
  for (const row of pending) arm(row)
  console.log(`[wakeup] Scheduler started — re-armed ${pending.length} pending wake-up(s)`)
}

export function stopWakeupScheduler(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  started = false
}
