import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { clampLimit } from '../services/limits.js'
import type { ActivityEntry } from '@orcstrator/shared'

// Task Activity: every scheduled fire in one list, newest first. Scheduled card runs and
// wake-ups are the two kinds of scheduled fire this app has; both are already persisted, so
// this is a read, not a new record. It exists so a SILENT card, which by design never shows
// up in the grid, still has one place where its runs can be found and opened.
//
// `kind: 'routine'` still means "the scheduler started this turn". Since migration047 that
// is sourced from the card's own schedule rather than from a routines row, but it is the
// same concept and the token is deliberately unchanged.

const MAX_LIMIT = 300

interface RunJoin {
  id: string
  task_id: string
  task_title: string | null
  task_silent: number | null
  instance_id: string | null
  instance_name: string | null
  folder_id: string | null
  started_at: number
  finished_at: number | null
  status: string
  error: string | null
  cost_usd: number | null
}

interface WakeJoin {
  id: string
  instance_id: string
  instance_name: string | null
  folder_id: string | null
  fire_at: number
  fired_at: number | null
  created_at: number
  reason: string | null
  prompt: string
  status: string
}

export function listActivity(limit: number): ActivityEntry[] {
  const lim = Math.max(1, Math.min(MAX_LIMIT, limit))
  const runs = db.prepare(`
    SELECT r.id, r.task_id, t.title AS task_title, t.silent AS task_silent,
           r.instance_id, i.name AS instance_name, COALESCE(i.folder_id, t.project_id) AS folder_id,
           r.started_at, r.finished_at, r.status, r.error, r.cost_usd
    FROM task_runs r
    LEFT JOIN pipeline_tasks t ON t.id = r.task_id
    LEFT JOIN instances i ON i.id = r.instance_id
    ORDER BY r.started_at DESC
    LIMIT ?
  `).all(lim) as RunJoin[]
  const wakes = db.prepare(`
    SELECT w.id, w.instance_id, i.name AS instance_name, i.folder_id,
           w.fire_at, w.fired_at, w.created_at, w.reason, w.prompt, w.status
    FROM scheduled_wakeups w
    LEFT JOIN instances i ON i.id = w.instance_id
    ORDER BY COALESCE(w.fired_at, w.created_at) DESC
    LIMIT ?
  `).all(lim) as WakeJoin[]

  const entries: ActivityEntry[] = [
    ...runs.map((r): ActivityEntry => ({
      id: r.id,
      kind: 'routine',
      name: r.task_title ?? 'Deleted card',
      taskId: r.task_id,
      instanceId: r.instance_id,
      instanceName: r.instance_name,
      folderId: r.folder_id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      error: r.error,
      costUsd: r.cost_usd ?? 0,
      silent: !!r.task_silent,
    })),
    ...wakes.map((w): ActivityEntry => ({
      id: w.id,
      kind: 'wakeup',
      name: w.reason?.trim() || w.prompt.slice(0, 80),
      taskId: null,
      instanceId: w.instance_id,
      instanceName: w.instance_name,
      folderId: w.folder_id,
      // An armed wake-up sorts by when it was ARMED, not by its future fire time: a
      // wake-up set for tomorrow must not sit above everything that actually happened.
      startedAt: w.fired_at ?? w.created_at,
      finishedAt: null,
      status: w.status,
      error: null,
      costUsd: 0,
      silent: false,
    })),
  ]
  // Newest first. A timeline, not a sequence.
  entries.sort((a, b) => b.startedAt - a.startedAt)
  return entries.slice(0, lim)
}

export default async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/activity', async (request) => {
    const q = request.query as { limit?: string }
    const limit = clampLimit(q.limit, 100, MAX_LIMIT)
    return { entries: listActivity(Number.isFinite(limit) ? limit : 100) }
  })
}
