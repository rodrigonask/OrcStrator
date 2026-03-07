import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { OVERDRIVE_LEVELS } from '@orcstrator/shared'

const CACHE_WINDOW_MS = 3_600_000 // 1 hour

function getOverdriveLevel(tasks: number) {
  let result: (typeof OVERDRIVE_LEVELS)[number] = OVERDRIVE_LEVELS[0]
  for (const level of OVERDRIVE_LEVELS) {
    if (tasks >= level.minTasks) result = level
    else break
  }
  return result
}

export function updateOverdriveOnComplete(instanceId: string): void {
  const row = db.prepare(
    'SELECT overdrive_tasks, overdrive_started_at, last_task_at FROM instances WHERE id = ?'
  ).get(instanceId) as { overdrive_tasks: number; overdrive_started_at: number | null; last_task_at: number | null } | undefined
  if (!row) return

  const now = Date.now()
  let tasks = row.overdrive_tasks ?? 0
  let startedAt = row.overdrive_started_at

  // Reset if cache window expired
  if (row.last_task_at != null && (now - row.last_task_at) > CACHE_WINDOW_MS) {
    tasks = 0
    startedAt = null
  }

  tasks++
  if (startedAt == null) startedAt = now

  const od = getOverdriveLevel(tasks)

  db.prepare(
    'UPDATE instances SET overdrive_tasks = ?, overdrive_started_at = ?, last_task_at = ? WHERE id = ?'
  ).run(tasks, startedAt, now, instanceId)

  broadcastEvent({
    type: 'instance:overdrive',
    payload: {
      instanceId,
      overdriveLevel: od.level,
      overdriveTasks: tasks,
      overdriveStartedAt: startedAt,
      lastTaskAt: now,
      savings: od.savings,
    },
  })
}

export function resetOverdriveIfExpired(instanceId: string): void {
  const row = db.prepare(
    'SELECT last_task_at FROM instances WHERE id = ?'
  ).get(instanceId) as { last_task_at: number | null } | undefined
  if (!row) return

  if (row.last_task_at != null && (Date.now() - row.last_task_at) > CACHE_WINDOW_MS) {
    db.prepare(
      'UPDATE instances SET overdrive_tasks = 0, overdrive_started_at = NULL, last_task_at = NULL WHERE id = ?'
    ).run(instanceId)

    broadcastEvent({
      type: 'instance:overdrive',
      payload: {
        instanceId,
        overdriveLevel: 0,
        overdriveTasks: 0,
        overdriveStartedAt: undefined,
        lastTaskAt: undefined,
        savings: 0,
      },
    })
  }
}

export function resetOverdriveForAll(): void {
  const now = Date.now()
  const cutoff = now - CACHE_WINDOW_MS

  const stale = db.prepare(
    'SELECT id FROM instances WHERE overdrive_tasks > 0 AND last_task_at IS NOT NULL AND last_task_at < ?'
  ).all(cutoff) as { id: string }[]

  if (stale.length === 0) return

  db.prepare(
    'UPDATE instances SET overdrive_tasks = 0, overdrive_started_at = NULL, last_task_at = NULL WHERE overdrive_tasks > 0 AND last_task_at IS NOT NULL AND last_task_at < ?'
  ).run(cutoff)

  for (const { id } of stale) {
    broadcastEvent({
      type: 'instance:overdrive',
      payload: {
        instanceId: id,
        overdriveLevel: 0,
        overdriveTasks: 0,
        overdriveStartedAt: undefined,
        lastTaskAt: undefined,
        savings: 0,
      },
    })
  }

  console.log(`[overdrive] Swept ${stale.length} expired overdrive instance(s)`)
}
