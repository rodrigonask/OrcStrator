import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import type { PipelineTask, PipelineColumn, TaskHistoryEntry, TaskAttachment } from '@orcstrator/shared'
import crypto from 'crypto'

function rowToTask(row: Record<string, unknown>): PipelineTask {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    description: (row.description as string) || '',
    column: (row.column as PipelineColumn) || 'backlog',
    priority: (row.priority as 1 | 2 | 3 | 4) || 4,
    labels: readLabels(row.labels as string),
    attachments: readAttachments(row.attachments as string),
    createdBy: (row.created_by as string) || 'human',
    history: safeJsonParse(row.history as string, []),
    completedAt: row.completed_at as number | undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    workStartedAt: (row.work_started_at as number) ?? undefined,
    workEndedAt: (row.work_ended_at as number) ?? undefined,
    totalInputTokens: (row.total_input_tokens as number) || 0,
    totalOutputTokens: (row.total_output_tokens as number) || 0,
    totalCostUsd: (row.total_cost_usd as number) || 0,
    instanceId: (row.instance_id as string) || undefined,

    // Schedule. Absent on an ordinary card, which is the overwhelming majority, so these
    // stay undefined rather than being defaulted into something the board would draw.
    scheduleKind: (row.schedule_kind as PipelineTask['scheduleKind']) ?? undefined,
    scheduleValue: (row.schedule_value as string) ?? undefined,
    scheduleEnabled: row.schedule_enabled ? true : false,
    nextRunAt: (row.next_run_at as number) ?? null,
    lastRunAt: (row.last_run_at as number) ?? null,
    queuedSince: (row.queued_since as number) ?? null,
    // NOT instanceId. See the warning on PipelineTask: this is the chat the NEXT fire is
    // aimed at, instanceId is the chat the LAST run happened to land on.
    targetInstanceId: (row.target_instance_id as string) ?? null,

    // Scheduler v2. Each null MEANS something (every day / the whole day / computer time /
    // no end / no limit), so none of them collapses to a default here.
    scheduleDays: (row.schedule_days as string) ?? null,
    scheduleWindow: (row.schedule_window as string) ?? null,
    scheduleTz: (row.schedule_tz as string) ?? null,
    scheduleUntil: (row.schedule_until as string) ?? null,
    scheduleMaxRuns: (row.schedule_max_runs as number) ?? null,
    runCount: (row.run_count as number) ?? 0,
    catchupPolicy: (row.catchup_policy as PipelineTask['catchupPolicy']) ?? 'late',
    consecutiveFailures: (row.consecutive_failures as number) ?? 0,
    disarmAfterFailures: (row.disarm_after_failures as number) ?? 3,
    maxRunMinutes: (row.max_run_minutes as number) ?? null,
    budgetCapUsd: (row.budget_cap_usd as number) ?? null,
    autoCompact: row.auto_compact ? true : false,
    autoClose: row.auto_close ? true : false,
    selfClose: row.self_close ? true : false,
    resumeSessionId: (row.resume_session_id as string) ?? null,
    scheduleState: (row.schedule_state as PipelineTask['scheduleState']) ?? null,
    silent: row.silent ? true : false,
    rawPrompt: row.raw_prompt ? true : false,
    sendComments: row.send_comments == null ? null : !!row.send_comments,

    // Run settings. null means inherit the global default, so null is preserved rather
    // than being collapsed to undefined or to today's default value.
    model: (row.model as string) ?? null,
    effort: (row.effort as PipelineTask['effort']) ?? null,
    permissionMode: (row.permission_mode as PipelineTask['permissionMode']) ?? null,
    maxBudgetUsd: (row.max_budget_usd as number) ?? null,
    fallbackModel: (row.fallback_model as string) ?? null,
    outputStyle: (row.output_style as string) ?? null,
    language: (row.language as string) ?? null,
  }
}

/**
 * The card fields that are neither identity nor board position: the schedule and the run
 * settings. Shared by create and update so the two cannot accept different sets.
 *
 * Every one is nullable and every null MEANS something: on a setting it means "inherit the
 * global default", on a schedule field it means "no schedule". Undefined means "leave this
 * column alone", which is why the two are told apart carefully below.
 */
export interface TaskConfigUpdates {
  scheduleKind: string | null
  scheduleValue: string | null
  scheduleEnabled: boolean
  nextRunAt: number | null
  targetInstanceId: string | null
  silent: boolean
  rawPrompt: boolean
  /** null = auto (see PipelineTask.sendComments), so NOT in BOOLEAN_CONFIG. */
  sendComments: boolean | null
  // Scheduler v2. See PipelineTask for what each null means.
  scheduleDays: string | null
  scheduleWindow: string | null
  scheduleTz: string | null
  scheduleUntil: string | null
  scheduleMaxRuns: number | null
  runCount: number | null
  catchupPolicy: string | null
  consecutiveFailures: number | null
  disarmAfterFailures: number | null
  maxRunMinutes: number | null
  budgetCapUsd: number | null
  autoCompact: boolean
  autoClose: boolean
  selfClose: boolean
  resumeSessionId: string | null
  scheduleState: string | null
  model: string | null
  effort: string | null
  permissionMode: string | null
  maxBudgetUsd: number | null
  fallbackModel: string | null
  outputStyle: string | null
  language: string | null
}

/** Column name for each config field, in one place so create and update cannot diverge. */
const CONFIG_COLUMNS: Record<keyof TaskConfigUpdates, string> = {
  scheduleKind: 'schedule_kind',
  scheduleValue: 'schedule_value',
  scheduleEnabled: 'schedule_enabled',
  nextRunAt: 'next_run_at',
  targetInstanceId: 'target_instance_id',
  silent: 'silent',
  rawPrompt: 'raw_prompt',
  sendComments: 'send_comments',
  scheduleDays: 'schedule_days',
  scheduleWindow: 'schedule_window',
  scheduleTz: 'schedule_tz',
  scheduleUntil: 'schedule_until',
  scheduleMaxRuns: 'schedule_max_runs',
  runCount: 'run_count',
  catchupPolicy: 'catchup_policy',
  consecutiveFailures: 'consecutive_failures',
  disarmAfterFailures: 'disarm_after_failures',
  maxRunMinutes: 'max_run_minutes',
  budgetCapUsd: 'budget_cap_usd',
  autoCompact: 'auto_compact',
  autoClose: 'auto_close',
  selfClose: 'self_close',
  resumeSessionId: 'resume_session_id',
  scheduleState: 'schedule_state',
  model: 'model',
  effort: 'effort',
  permissionMode: 'permission_mode',
  maxBudgetUsd: 'max_budget_usd',
  fallbackModel: 'fallback_model',
  outputStyle: 'output_style',
  language: 'language',
}

const BOOLEAN_CONFIG = new Set(['scheduleEnabled', 'silent', 'rawPrompt', 'autoCompact', 'autoClose', 'selfClose'])

/**
 * Columns declared NOT NULL in the schema. A null arriving for one of these means "put it
 * back to its default", not "write NULL": writing NULL throws a constraint error and loses
 * the WHOLE edit, which is a bad way to find out that a counter was being reset.
 */
const NOT_NULL_CONFIG: Record<string, string | number> = {
  runCount: 0,
  catchupPolicy: 'late',
  consecutiveFailures: 0,
  disarmAfterFailures: 3,
}

/** Turn the provided config fields into SET clauses + params. Absent fields are skipped. */
function configSets(updates: Partial<TaskConfigUpdates>): { sets: string[]; params: unknown[] } {
  const sets: string[] = []
  const params: unknown[] = []
  for (const [key, column] of Object.entries(CONFIG_COLUMNS)) {
    const value = updates[key as keyof TaskConfigUpdates]
    if (value === undefined) continue
    sets.push(`${column} = ?`)
    if (BOOLEAN_CONFIG.has(key)) {
      params.push(value ? 1 : 0)
      continue
    }
    if (typeof value === 'boolean') { params.push(value ? 1 : 0); continue }
    const blank = value === null || value === ''
    params.push(blank ? (NOT_NULL_CONFIG[key] ?? null) : value)
  }
  return { sets, params }
}

/**
 * Labels off a stored row, always a string[]. A row written before the routes checked shapes
 * can hold `"bug"` or `{}` here, and the board calls `.slice().map()` on this, so
 * anything that is not a list of strings reads as the strings it does contain, or nothing.
 */
export function readLabels(raw: string | null | undefined): string[] {
  const v = safeJsonParse<unknown>(raw, [])
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Attachments off a stored row, always a list of objects carrying a string dataUrl. */
export function readAttachments(raw: string | null | undefined): TaskAttachment[] {
  const v = safeJsonParse<unknown>(raw, [])
  if (!Array.isArray(v)) return []
  return v.filter((a): a is TaskAttachment => !!a && typeof a === 'object' && typeof (a as TaskAttachment).dataUrl === 'string')
}

export function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback
  try {
    return JSON.parse(str) as T
  } catch {
    return fallback
  }
}

function broadcastPipeline(
  projectId: string,
  taskId: string,
  action: string,
  newColumn?: PipelineColumn,
  extra?: Record<string, unknown>,
): void {
  broadcastEvent({
    type: 'pipeline:updated',
    payload: { projectId, taskId, action, newColumn, ...extra }
  })
}

export const MAX_DESCRIPTION_CHARS = 5000

export function createTask(params: {
  projectId: string
  title: string
  description?: string
  column?: PipelineColumn
  priority?: 1 | 2 | 3 | 4
  labels?: string[]
  attachments?: TaskAttachment[]
  createdBy?: string
  /** The span the work actually occupied, when the caller knows it (see PipelineTask). */
  workStartedAt?: number
  workEndedAt?: number
} & Partial<TaskConfigUpdates>): PipelineTask {
  const task = db.transaction(() => {
    const now = Date.now()
    const id = crypto.randomUUID()
    const history: TaskHistoryEntry[] = [{ action: 'created', timestamp: now, agent: params.createdBy || 'human' }]
    const desc = (params.description || '').slice(0, MAX_DESCRIPTION_CHARS)
    const column = params.column || 'backlog'

    db.prepare(`
      INSERT INTO pipeline_tasks (id, project_id, title, description, "column", priority, labels, attachments, created_by, history, created_at, updated_at, work_started_at, work_ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.projectId,
      params.title,
      desc,
      column,
      params.priority || 4,
      JSON.stringify(params.labels || []),
      JSON.stringify(params.attachments || []),
      params.createdBy || 'human',
      JSON.stringify(history),
      now,
      now,
      params.workStartedAt ?? null,
      params.workEndedAt ?? null
    )

    // Schedule + run settings, applied as a second statement so the INSERT above keeps the
    // exact shape every existing caller relies on and an ordinary card writes nothing extra.
    const { sets, params: configParams } = configSets(params)
    if (sets.length > 0) {
      db.prepare(`UPDATE pipeline_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...configParams, id)
    }

    return getTask(id)!
  })()

  broadcastPipeline(params.projectId, task.id, 'created', task.column)
  return task
}

/**
 * Widen a task's work span to cover another session.
 *
 * A task can be worked in more than one chat, so this takes the union rather than
 * overwriting: earliest start wins, latest end wins. COALESCE covers the first session,
 * where both columns are still NULL. The CASE guards matter as much: without them a
 * session that produced a start but no end would write NULL over an end already on the
 * row, because MAX(x, NULL) is NULL in SQLite. Never throws, because a missing work date
 * must not cost a close its summary.
 */
export function recordWorkSpan(taskId: string, startedAt: number | null, endedAt: number | null): void {
  if (!startedAt && !endedAt) return
  try {
    db.prepare(`
      UPDATE pipeline_tasks
         SET work_started_at = CASE WHEN :started IS NULL THEN work_started_at
                                    ELSE MIN(COALESCE(work_started_at, :started), :started) END,
             work_ended_at   = CASE WHEN :ended IS NULL THEN work_ended_at
                                    ELSE MAX(COALESCE(work_ended_at, :ended), :ended) END
       WHERE id = :id
    `).run({ started: startedAt, ended: endedAt, id: taskId })
  } catch (err) {
    console.error('[task-manager] could not record work span:', err)
  }
}

export function moveTask(taskId: string, column: PipelineColumn, agent?: string): PipelineTask {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const updated = db.transaction(() => {
    const now = Date.now()
    const row = db.prepare('SELECT history, version FROM pipeline_tasks WHERE id = ?').get(taskId) as { history: string; version: number }
    const history: TaskHistoryEntry[] = safeJsonParse(row.history, [])
    history.push({ action: 'moved', timestamp: now, agent, from: task.column, to: column })

    const completedAt = column === 'done' ? now : null

    const r = db.prepare(`
      UPDATE pipeline_tasks SET "column" = ?, history = ?, updated_at = ?, completed_at = COALESCE(?, completed_at),
        version = version + 1
      WHERE id = ? AND version = ?
    `).run(column, JSON.stringify(history), now, completedAt, taskId, row.version)

    if (r.changes === 0) throw new Error('Concurrent modification on moveTask')
    return getTask(taskId)!
  })()

  broadcastPipeline(task.projectId, taskId, 'moved', column, { fromColumn: task.column })
  return updated
}

export function blockTask(taskId: string, reason: string, agent?: string): PipelineTask {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const updated = db.transaction(() => {
    const now = Date.now()
    const row = db.prepare('SELECT labels, history, version FROM pipeline_tasks WHERE id = ?').get(taskId) as { labels: string; history: string; version: number }
    const labels: string[] = readLabels(row.labels)
    if (!labels.includes('blocked')) labels.push('blocked')

    const history: TaskHistoryEntry[] = safeJsonParse(row.history, [])
    history.push({ action: 'blocked', timestamp: now, agent, note: reason })

    const r = db.prepare(`
      UPDATE pipeline_tasks SET labels = ?, history = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ?
    `).run(JSON.stringify(labels), JSON.stringify(history), now, taskId, row.version)

    if (r.changes === 0) throw new Error('Concurrent modification on blockTask')
    return getTask(taskId)!
  })()

  broadcastPipeline(task.projectId, taskId, 'blocked')
  return updated
}

export function unblockTask(taskId: string, agent?: string): PipelineTask {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const updated = db.transaction(() => {
    const now = Date.now()
    const row = db.prepare('SELECT labels, history, version FROM pipeline_tasks WHERE id = ?').get(taskId) as { labels: string; history: string; version: number }
    const labels: string[] = readLabels(row.labels)
    const filtered = labels.filter(l => l !== 'blocked')

    const history: TaskHistoryEntry[] = safeJsonParse(row.history, [])
    history.push({ action: 'unblocked', timestamp: now, agent })

    const r = db.prepare(`
      UPDATE pipeline_tasks SET labels = ?, history = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ?
    `).run(JSON.stringify(filtered), JSON.stringify(history), now, taskId, row.version)

    if (r.changes === 0) throw new Error('Concurrent modification on unblockTask')
    return getTask(taskId)!
  })()

  broadcastPipeline(task.projectId, taskId, 'unblocked')
  return updated
}

export function updateTask(taskId: string, updates: Partial<{
  title: string
  description: string
  priority: 1 | 2 | 3 | 4
  labels: string[]
} & TaskConfigUpdates>): PipelineTask {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const updated = db.transaction(() => {
    const now = Date.now()
    const row = db.prepare('SELECT history, version FROM pipeline_tasks WHERE id = ?').get(taskId) as { history: string; version: number }

    const sets: string[] = ['updated_at = ?', 'version = version + 1']
    const params: unknown[] = [now]

    if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title) }
    if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description.slice(0, MAX_DESCRIPTION_CHARS)) }
    if (updates.priority !== undefined) { sets.push('priority = ?'); params.push(updates.priority) }
    if (updates.labels !== undefined) { sets.push('labels = ?'); params.push(JSON.stringify(updates.labels)) }

    const config = configSets(updates)
    sets.push(...config.sets)
    params.push(...config.params)

    const history: TaskHistoryEntry[] = safeJsonParse(row.history, [])
    history.push({ action: 'edited', timestamp: now })
    sets.push('history = ?')
    params.push(JSON.stringify(history))

    params.push(taskId, row.version)
    const r = db.prepare(`UPDATE pipeline_tasks SET ${sets.join(', ')} WHERE id = ? AND version = ?`).run(...params)

    if (r.changes === 0) throw new Error('Concurrent modification on updateTask')
    return getTask(taskId)!
  })()

  broadcastPipeline(task.projectId, taskId, 'updated')
  return updated
}

export function deleteTask(taskId: string): void {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  // Run history goes with the card. Deleting a ROUTINE never did this (routes/routines.ts
  // issued a bare DELETE), which is why migration047 found orphaned run rows pointing at
  // deleted routines: invisible, unreachable, and counted in nothing.
  db.transaction(() => {
    db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(taskId)
    db.prepare('DELETE FROM pipeline_tasks WHERE id = ?').run(taskId)
  })()
  broadcastPipeline(task.projectId, taskId, 'deleted')
}

export function getTask(taskId: string): PipelineTask | null {
  const row = db.prepare('SELECT * FROM pipeline_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined
  if (!row) return null
  return rowToTask(row)
}

export function getTasksForProject(projectId: string, includeDone = false): PipelineTask[] {
  const query = includeDone
    ? 'SELECT * FROM pipeline_tasks WHERE project_id = ? ORDER BY priority ASC, created_at ASC'
    : 'SELECT * FROM pipeline_tasks WHERE project_id = ? AND "column" != \'done\' ORDER BY priority ASC, created_at ASC'
  const rows = db.prepare(query).all(projectId) as Record<string, unknown>[]
  return rows.map(rowToTask)
}

// Lightweight list: excludes history, description, and attachments to reduce payload.
// includeDone exists for the all-projects board, which renders a Done column: without it
// that column is structurally empty no matter how much work has been finished.
export function getTasksForProjectLight(projectId: string, includeDone = false): Array<Omit<PipelineTask, 'history' | 'description' | 'attachments'> & { description: string }> {
  // The schedule columns ride along even though this is the light shape. They are seven
  // small scalars, and without them a scheduled card arrives on the all-projects board and
  // in the sidebar looking like an ordinary one: no pill, no next-run time, and the
  // close-a-chat warning silently finds nothing to warn about. Cheap to send, expensive to
  // omit.
  //
  // THE RUN SETTINGS RIDE ALONG TOO, and they have to. They used to be left out on the
  // grounds that nothing renders them on a card, which was true and still cost a card its
  // configuration: the edit form was handed this shape, read model, effort, permissions,
  // the spend limits and the rest as unset, and wrote those blanks back on the next save.
  // A card silently lost its model by being opened and saved. Omitting a field from a read
  // is only safe while nothing round-trips it, and something always ends up round-tripping
  // it, so they are all here: eleven more small scalars against a whole class of bug.
  const COLS = 'id, project_id, title, "column", priority, labels, created_by, completed_at, created_at, updated_at, work_started_at, work_ended_at, total_input_tokens, total_output_tokens, total_cost_usd, instance_id, schedule_kind, schedule_value, schedule_enabled, next_run_at, last_run_at, queued_since, target_instance_id, silent, schedule_days, schedule_window, schedule_tz, schedule_until, schedule_max_runs, run_count, schedule_state, consecutive_failures, disarm_after_failures, budget_cap_usd, catchup_policy, max_run_minutes, auto_compact, auto_close, self_close, model, effort, permission_mode, max_budget_usd, fallback_model, output_style, language'
  const rows = db.prepare(
    includeDone
      ? `SELECT ${COLS} FROM pipeline_tasks WHERE project_id = ? ORDER BY priority ASC, created_at ASC`
      : `SELECT ${COLS} FROM pipeline_tasks WHERE project_id = ? AND "column" != 'done' ORDER BY priority ASC, created_at ASC`
  ).all(projectId) as Record<string, unknown>[]
  return rows.map(row => ({
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    description: '',
    column: (row.column as PipelineColumn) || 'backlog',
    priority: (row.priority as 1 | 2 | 3 | 4) || 4,
    labels: readLabels(row.labels as string),
    createdBy: (row.created_by as string) || 'human',
    completedAt: row.completed_at as number | undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    workStartedAt: (row.work_started_at as number) ?? undefined,
    workEndedAt: (row.work_ended_at as number) ?? undefined,
    totalInputTokens: (row.total_input_tokens as number) || 0,
    totalOutputTokens: (row.total_output_tokens as number) || 0,
    totalCostUsd: (row.total_cost_usd as number) || 0,
    instanceId: (row.instance_id as string) || undefined,
    scheduleKind: (row.schedule_kind as PipelineTask['scheduleKind']) ?? undefined,
    scheduleValue: (row.schedule_value as string) ?? undefined,
    scheduleEnabled: row.schedule_enabled ? true : false,
    nextRunAt: (row.next_run_at as number) ?? null,
    lastRunAt: (row.last_run_at as number) ?? null,
    queuedSince: (row.queued_since as number) ?? null,
    targetInstanceId: (row.target_instance_id as string) ?? null,
    silent: row.silent ? true : false,
    // Everything the PILL needs to say what this card does, and the red dot needs to know
    // it is in trouble. Without these the all-projects board draws a scheduled card as an
    // ordinary one, which is how a failed routine goes a week without anybody noticing.
    scheduleDays: (row.schedule_days as string) ?? null,
    scheduleWindow: (row.schedule_window as string) ?? null,
    scheduleTz: (row.schedule_tz as string) ?? null,
    scheduleUntil: (row.schedule_until as string) ?? null,
    scheduleMaxRuns: (row.schedule_max_runs as number) ?? null,
    runCount: (row.run_count as number) ?? 0,
    scheduleState: (row.schedule_state as PipelineTask['scheduleState']) ?? null,
    consecutiveFailures: (row.consecutive_failures as number) ?? 0,
    disarmAfterFailures: (row.disarm_after_failures as number) ?? 3,
    budgetCapUsd: (row.budget_cap_usd as number) ?? null,

    // Run settings. null means inherit the global default, so null is preserved rather
    // than being collapsed to undefined or to today's default value. Undefined is what
    // an edit form reads as "unset, write a blank", which is how these came to be here.
    catchupPolicy: (row.catchup_policy as PipelineTask['catchupPolicy']) ?? 'late',
    maxRunMinutes: (row.max_run_minutes as number) ?? null,
    autoCompact: row.auto_compact ? true : false,
    autoClose: row.auto_close ? true : false,
    selfClose: row.self_close ? true : false,
    model: (row.model as string) ?? null,
    effort: (row.effort as PipelineTask['effort']) ?? null,
    permissionMode: (row.permission_mode as PipelineTask['permissionMode']) ?? null,
    maxBudgetUsd: (row.max_budget_usd as number) ?? null,
    fallbackModel: (row.fallback_model as string) ?? null,
    outputStyle: (row.output_style as string) ?? null,
    language: (row.language as string) ?? null,
  }))
}
