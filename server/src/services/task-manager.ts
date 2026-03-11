import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import type { PipelineTask, PipelineColumn, PipelineBlueprint, BlueprintStep, TaskHistoryEntry, TaskAttachment, ScheduleConfig, ScheduleExecution } from '@orcstrator/shared'
import { computeNextRun } from '@orcstrator/shared'
import crypto from 'crypto'
import { orchestrator } from './orchestrator.js'

function rowToTask(row: Record<string, unknown>): PipelineTask {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    description: (row.description as string) || '',
    column: (row.column as PipelineColumn) || 'backlog',
    priority: (row.priority as 1 | 2 | 3 | 4) || 4,
    labels: safeJsonParse(row.labels as string, []),
    assignedAgent: row.assigned_agent as string | undefined,
    groupId: row.group_id as string | undefined,
    groupIndex: row.group_index as number | undefined,
    groupTotal: row.group_total as number | undefined,
    attachments: safeJsonParse(row.attachments as string, []),
    dependsOn: safeJsonParse(row.depends_on as string, []),
    createdBy: (row.created_by as string) || 'human',
    history: safeJsonParse(row.history as string, []),
    lockedBy: row.locked_by as string | undefined,
    completedAt: row.completed_at as number | undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    schedule: row.schedule ? safeJsonParse(row.schedule as string, undefined) : undefined,
    executions: safeJsonParse(row.executions as string, []),
    skill: row.skill as string | undefined,
    totalInputTokens: (row.total_input_tokens as number) || 0,
    totalOutputTokens: (row.total_output_tokens as number) || 0,
    totalCostUsd: (row.total_cost_usd as number) || 0,
    pipelineId: row.pipeline_id as string | undefined,
    currentStep: (row.current_step as number) || 1,
    totalSteps: (row.total_steps as number) || 1,
    currentStepRole: row.current_step_role as string | undefined,
    stepInstructions: row.step_instructions ? safeJsonParse(row.step_instructions as string, undefined) : undefined,
  }
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

const MAX_DESCRIPTION_CHARS = 5000

export function createTask(params: {
  projectId: string
  title: string
  description?: string
  column?: PipelineColumn
  priority?: 1 | 2 | 3 | 4
  labels?: string[]
  attachments?: TaskAttachment[]
  groupId?: string
  groupIndex?: number
  groupTotal?: number
  dependsOn?: string[]
  createdBy?: string
  skill?: string
  pipelineId?: string
  stepInstructions?: Record<string, string>
}): PipelineTask {
  const task = db.transaction(() => {
    const now = Date.now()
    const id = crypto.randomUUID()
    const history: TaskHistoryEntry[] = [{ action: 'created', timestamp: now, agent: params.createdBy || 'human' }]
    const desc = (params.description || '').slice(0, MAX_DESCRIPTION_CHARS)
    const column = params.column || 'backlog'

    // Resolve blueprint: explicit pipelineId, or auto-assign default when entering 'ready'
    let pipelineId = params.pipelineId || null
    let currentStep = 1
    let totalSteps = 1
    let currentStepRole: string | null = null

    if (column === 'ready' && !pipelineId) {
      const defaultBp = db.prepare("SELECT id, steps FROM pipeline_blueprints WHERE is_default = 1 LIMIT 1").get() as { id: string; steps: string } | undefined
      if (defaultBp) {
        pipelineId = defaultBp.id
      }
    }

    if (pipelineId) {
      const bp = db.prepare("SELECT steps FROM pipeline_blueprints WHERE id = ?").get(pipelineId) as { steps: string } | undefined
      if (bp) {
        const steps = JSON.parse(bp.steps) as Array<{ role: string }>
        totalSteps = steps.length
        currentStepRole = steps[0]?.role || null
      }
    }

    db.prepare(`
      INSERT INTO pipeline_tasks (id, project_id, title, description, "column", priority, labels, attachments, assigned_agent, group_id, group_index, group_total, depends_on, created_by, history, skill, pipeline_id, current_step, total_steps, current_step_role, step_instructions, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.projectId,
      params.title,
      desc,
      column,
      params.priority || 4,
      JSON.stringify(params.labels || []),
      JSON.stringify(params.attachments || []),
      params.groupId || null,
      params.groupIndex ?? null,
      params.groupTotal ?? null,
      JSON.stringify(params.dependsOn || []),
      params.createdBy || 'human',
      JSON.stringify(history),
      params.skill || null,
      pipelineId,
      currentStep,
      totalSteps,
      currentStepRole,
      params.stepInstructions ? JSON.stringify(params.stepInstructions) : null,
      now,
      now
    )

    return getTask(id)!
  })()

  broadcastPipeline(params.projectId, task.id, 'created', task.column)

  // Notify orchestrator AFTER transaction commits
  if (task.column === 'ready' || task.column === 'in_progress') {
    setImmediate(() => {
      const folder = db.prepare('SELECT orchestrator_active FROM folders WHERE id = ?').get(params.projectId) as { orchestrator_active: number } | undefined
      if (folder?.orchestrator_active) {
        orchestrator.triggerFolder(params.projectId)
      }
    })
  }

  return task
}

export function moveTask(taskId: string, column: PipelineColumn, agent?: string): PipelineTask {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  // Lock check: if task is locked by an active agent, only that agent or 'human' can move it
  if (task.lockedBy && agent !== task.lockedBy && agent !== 'human' && agent !== undefined) {
    throw Object.assign(new Error(`Task locked by ${task.lockedBy}`), { statusCode: 409 })
  }

  const updated = db.transaction(() => {
    const now = Date.now()
    const row = db.prepare('SELECT history, version FROM pipeline_tasks WHERE id = ?').get(taskId) as { history: string; version: number }
    const history: TaskHistoryEntry[] = safeJsonParse(row.history, [])
    history.push({ action: 'moved', timestamp: now, agent, from: task.column, to: column })

    const completedAt = column === 'done' ? now : null

    let extraSets = ''
    const extraParams: unknown[] = []
    if (column === 'ready' && !task.pipelineId) {
      const defaultBp = db.prepare("SELECT id, steps FROM pipeline_blueprints WHERE is_default = 1 LIMIT 1").get() as { id: string; steps: string } | undefined
      if (defaultBp) {
        const steps = JSON.parse(defaultBp.steps) as Array<{ role: string }>
        extraSets = ', pipeline_id = ?, current_step = 1, total_steps = ?, current_step_role = ?'
        extraParams.push(defaultBp.id, steps.length, steps[0]?.role || null)
      }
    }

    let labelsUpdate = ''
    if (column === 'in_progress' && task.column === 'in_review') {
      const labels = task.labels.filter(l => l !== 'stuck')
      labelsUpdate = ', labels = ?'
      extraParams.push(JSON.stringify(labels))
    }

    const r = db.prepare(`
      UPDATE pipeline_tasks SET "column" = ?, history = ?, updated_at = ?, completed_at = COALESCE(?, completed_at),
        locked_by = NULL, locked_at = NULL, lock_version = lock_version + 1, version = version + 1${extraSets}${labelsUpdate}
      WHERE id = ? AND version = ?
    `).run(column, JSON.stringify(history), now, completedAt, ...extraParams, taskId, row.version)

    if (r.changes === 0) throw new Error('Concurrent modification on moveTask')
    return getTask(taskId)!
  })()

  broadcastPipeline(task.projectId, taskId, 'moved', column, {
    fromColumn: task.column,
    lockedBy: task.lockedBy ?? null,
  })

  // Notify orchestrator AFTER transaction commits
  setImmediate(() => {
    const folder = db.prepare('SELECT orchestrator_active FROM folders WHERE id = ?').get(task.projectId) as { orchestrator_active: number } | undefined
    if (folder?.orchestrator_active) {
      orchestrator.triggerFolder(task.projectId)
    }
  })

  return updated
}

export function claimTask(taskId: string, agentRole: string): PipelineTask {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const updated = db.transaction(() => {
    const now = Date.now()
    const row = db.prepare('SELECT history, version FROM pipeline_tasks WHERE id = ?').get(taskId) as { history: string; version: number }
    const history: TaskHistoryEntry[] = safeJsonParse(row.history, [])
    history.push({ action: 'claimed', timestamp: now, agent: agentRole })

    const r = db.prepare(`
      UPDATE pipeline_tasks SET assigned_agent = ?, history = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ?
    `).run(agentRole, JSON.stringify(history), now, taskId, row.version)

    if (r.changes === 0) throw new Error('Concurrent modification on claimTask')
    return getTask(taskId)!
  })()

  broadcastPipeline(task.projectId, taskId, 'claimed')
  return updated
}

export function blockTask(taskId: string, reason: string, agent?: string): PipelineTask {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const updated = db.transaction(() => {
    const now = Date.now()
    const row = db.prepare('SELECT labels, history, version FROM pipeline_tasks WHERE id = ?').get(taskId) as { labels: string; history: string; version: number }
    const labels: string[] = safeJsonParse(row.labels, [])
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
    const labels: string[] = safeJsonParse(row.labels, [])
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

export function resetTaskPipeline(taskId: string, newPipelineId?: string, targetColumn: 'backlog' | 'ready' = 'ready'): PipelineTask {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const pipelineId = newPipelineId || task.pipelineId
  if (!pipelineId) throw new Error('Task has no pipeline to reset')

  const bp = db.prepare('SELECT steps FROM pipeline_blueprints WHERE id = ?').get(pipelineId) as { steps: string } | undefined
  if (!bp) throw new Error(`Blueprint ${pipelineId} not found`)

  const updated = db.transaction(() => {
    const now = Date.now()
    const steps = JSON.parse(bp!.steps) as Array<{ role: string }>
    const totalSteps = steps.length
    const currentStepRole = steps[0]?.role || null

    const row = db.prepare('SELECT history, version FROM pipeline_tasks WHERE id = ?').get(taskId) as { history: string; version: number }
    const history: TaskHistoryEntry[] = safeJsonParse(row.history, [])
    history.push({
      action: newPipelineId && newPipelineId !== task.pipelineId ? 'pipeline changed' : 'pipeline reset',
      timestamp: now,
      agent: 'human',
      note: `Reset to step 1/${totalSteps}`,
    })

    const r = db.prepare(`
      UPDATE pipeline_tasks
      SET pipeline_id = ?, current_step = 1, total_steps = ?, current_step_role = ?,
          "column" = ?, locked_by = NULL, locked_at = NULL, assigned_agent = NULL,
          lock_version = lock_version + 1, version = version + 1,
          history = ?, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(pipelineId, totalSteps, currentStepRole, targetColumn, JSON.stringify(history), now, taskId, row.version)

    if (r.changes === 0) throw new Error('Concurrent modification on resetTaskPipeline')
    return getTask(taskId)!
  })()

  broadcastPipeline(task.projectId, taskId, 'updated', targetColumn)

  if (targetColumn === 'ready') {
    setImmediate(() => {
      const folder = db.prepare('SELECT orchestrator_active FROM folders WHERE id = ?').get(task.projectId) as { orchestrator_active: number } | undefined
      if (folder?.orchestrator_active) {
        orchestrator.triggerFolder(task.projectId)
      }
    })
  }

  return updated
}

export function updateTask(taskId: string, updates: Partial<{
  title: string
  description: string
  priority: 1 | 2 | 3 | 4
  labels: string[]
  dependsOn: string[]
  skill: string
}>): PipelineTask {
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
    if (updates.dependsOn !== undefined) { sets.push('depends_on = ?'); params.push(JSON.stringify(updates.dependsOn)) }
    if (updates.skill !== undefined) { sets.push('skill = ?'); params.push(updates.skill || null) }

    const stuckRemoved = updates.labels !== undefined
      && task.column === 'in_review'
      && task.labels.includes('stuck')
      && !updates.labels.includes('stuck')

    if (stuckRemoved) {
      sets.push('"column" = ?')
      params.push('in_progress')
    }

    const history: TaskHistoryEntry[] = safeJsonParse(row.history, [])
    history.push({ action: 'edited', timestamp: now })
    if (stuckRemoved) {
      history.push({ action: 'moved', timestamp: now, from: 'in_review', to: 'in_progress', note: 'stuck label removed' })
    }
    sets.push('history = ?')
    params.push(JSON.stringify(history))

    params.push(taskId, row.version)
    const r = db.prepare(`UPDATE pipeline_tasks SET ${sets.join(', ')} WHERE id = ? AND version = ?`).run(...params)

    if (r.changes === 0) throw new Error('Concurrent modification on updateTask')
    return getTask(taskId)!
  })()

  broadcastPipeline(task.projectId, taskId, 'updated')

  const stuckRemoved = updates.labels !== undefined
    && task.column === 'in_review'
    && task.labels.includes('stuck')
    && !updates.labels!.includes('stuck')

  if (stuckRemoved) {
    setImmediate(() => {
      const folder = db.prepare('SELECT orchestrator_active FROM folders WHERE id = ?').get(task.projectId) as { orchestrator_active: number } | undefined
      if (folder?.orchestrator_active) {
        orchestrator.triggerFolder(task.projectId)
      }
    })
  }

  return updated
}

export function deleteTask(taskId: string): void {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  db.prepare('DELETE FROM pipeline_tasks WHERE id = ?').run(taskId)
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

// Lightweight list: excludes history, description, and attachments to reduce payload
export function getTasksForProjectLight(projectId: string): Array<Omit<PipelineTask, 'history' | 'description' | 'attachments'> & { description: string }> {
  const rows = db.prepare(
    'SELECT id, project_id, title, "column", priority, labels, assigned_agent, group_id, group_index, group_total, depends_on, created_by, locked_by, completed_at, created_at, updated_at, total_input_tokens, total_output_tokens, total_cost_usd, pipeline_id, current_step, total_steps, current_step_role FROM pipeline_tasks WHERE project_id = ? AND "column" != \'done\' ORDER BY priority ASC, created_at ASC'
  ).all(projectId) as Record<string, unknown>[]
  return rows.map(row => ({
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    description: '',
    column: (row.column as PipelineColumn) || 'backlog',
    priority: (row.priority as 1 | 2 | 3 | 4) || 4,
    labels: safeJsonParse(row.labels as string, []),
    assignedAgent: row.assigned_agent as string | undefined,
    groupId: row.group_id as string | undefined,
    groupIndex: row.group_index as number | undefined,
    groupTotal: row.group_total as number | undefined,
    dependsOn: safeJsonParse(row.depends_on as string, []),
    createdBy: (row.created_by as string) || 'human',
    lockedBy: row.locked_by as string | undefined,
    completedAt: row.completed_at as number | undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    totalInputTokens: (row.total_input_tokens as number) || 0,
    totalOutputTokens: (row.total_output_tokens as number) || 0,
    totalCostUsd: (row.total_cost_usd as number) || 0,
    pipelineId: row.pipeline_id as string | undefined,
    currentStep: (row.current_step as number) || 1,
    totalSteps: (row.total_steps as number) || 1,
    currentStepRole: row.current_step_role as string | undefined,
  }))
}

export function updateTaskSchedule(taskId: string, schedule: ScheduleConfig): PipelineTask {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)
  const now = Date.now()
  // Compute next run
  const updated: ScheduleConfig = { ...schedule, nextRunAt: computeNextRun(schedule, now) }
  db.prepare('UPDATE pipeline_tasks SET schedule = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(updated), now, taskId)
  const result = getTask(taskId)!
  broadcastPipeline(task.projectId, taskId, 'schedule-updated')
  return result
}

export function getScheduledTasksDue(projectId: string, now: number): PipelineTask[] {
  const rows = db.prepare(
    "SELECT * FROM pipeline_tasks WHERE project_id = ? AND \"column\" = 'scheduled' AND schedule IS NOT NULL"
  ).all(projectId) as Record<string, unknown>[]
  return rows
    .map(rowToTask)
    .filter(t => {
      if (!t.schedule) return false
      if (!t.schedule.enabled) return false
      if (t.schedule.currentlyRunning) return false
      if (!t.schedule.nextRunAt) return false
      return t.schedule.nextRunAt <= now
    })
}

export function markScheduleRunning(taskId: string, running: boolean, instanceId?: string): void {
  const task = getTask(taskId)
  if (!task?.schedule) return
  const updated: ScheduleConfig = { ...task.schedule, currentlyRunning: running, currentInstanceId: running ? instanceId : undefined }
  db.prepare('UPDATE pipeline_tasks SET schedule = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(updated), Date.now(), taskId)
  broadcastPipeline(task.projectId, taskId, 'schedule-running-changed')
}

export function appendExecution(taskId: string, exec: ScheduleExecution): void {
  const task = getTask(taskId)
  if (!task) return
  const executions: ScheduleExecution[] = task.executions ?? []
  executions.push(exec)
  // Keep last 50 executions
  const trimmed = executions.slice(-50)
  db.prepare('UPDATE pipeline_tasks SET executions = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(trimmed), Date.now(), taskId)
}

export function updateScheduleAfterRun(taskId: string, now: number): void {
  const task = getTask(taskId)
  if (!task?.schedule) return
  const schedule = task.schedule
  const fireCount = (schedule.fireCount ?? 0) + 1
  const lastRunAt = now
  let enabled = schedule.enabled
  // one-time tasks: disable after first run
  if (schedule.type === 'once') enabled = false
  const updated: ScheduleConfig = { ...schedule, lastRunAt, fireCount, currentlyRunning: false, currentInstanceId: undefined, enabled }
  updated.nextRunAt = computeNextRun(updated, now)
  db.prepare('UPDATE pipeline_tasks SET schedule = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(updated), now, taskId)
  broadcastPipeline(task.projectId, taskId, 'schedule-after-run')
}

export function getAllProjectIds(): string[] {
  const rows = db.prepare('SELECT DISTINCT project_id FROM pipeline_tasks').all() as Array<{ project_id: string }>
  return rows.map(r => r.project_id)
}

export function getNextTask(projectId: string, column?: PipelineColumn, role?: string): PipelineTask | null {
  let query = 'SELECT * FROM pipeline_tasks WHERE project_id = ?'
  const params: unknown[] = [projectId]

  if (column) {
    query += ' AND "column" = ?'
    params.push(column)
  }

  // Exclude blocked tasks
  query += " AND (labels NOT LIKE '%blocked%')"

  // Optionally filter unassigned or matching role
  if (role) {
    query += ' AND (assigned_agent IS NULL OR assigned_agent = ?)'
    params.push(role)
  }

  query += ' ORDER BY priority ASC, created_at ASC LIMIT 1'

  const row = db.prepare(query).get(...params) as Record<string, unknown> | undefined
  if (!row) return null
  return rowToTask(row)
}

// === BLUEPRINT CRUD ===

function rowToBlueprint(row: Record<string, unknown>): PipelineBlueprint {
  return {
    id: row.id as string,
    name: row.name as string,
    steps: safeJsonParse(row.steps as string, []),
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }
}

export function getBlueprints(): PipelineBlueprint[] {
  const rows = db.prepare('SELECT * FROM pipeline_blueprints ORDER BY is_default DESC, name ASC').all() as Record<string, unknown>[]
  return rows.map(rowToBlueprint)
}

export function getBlueprint(id: string): PipelineBlueprint | null {
  const row = db.prepare('SELECT * FROM pipeline_blueprints WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return rowToBlueprint(row)
}

export function getDefaultBlueprint(): PipelineBlueprint | null {
  const row = db.prepare('SELECT * FROM pipeline_blueprints WHERE is_default = 1 LIMIT 1').get() as Record<string, unknown> | undefined
  if (!row) return null
  return rowToBlueprint(row)
}

export function createBlueprint(params: { name: string; steps: BlueprintStep[]; isDefault?: boolean }): PipelineBlueprint {
  const id = crypto.randomUUID()
  const now = Date.now()
  if (params.isDefault) {
    db.prepare('UPDATE pipeline_blueprints SET is_default = 0').run()
  }
  db.prepare(
    'INSERT INTO pipeline_blueprints (id, name, steps, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, params.name, JSON.stringify(params.steps), params.isDefault ? 1 : 0, now, now)
  return getBlueprint(id)!
}

export function updateBlueprint(id: string, updates: { name?: string; steps?: BlueprintStep[]; isDefault?: boolean }): PipelineBlueprint {
  const bp = getBlueprint(id)
  if (!bp) throw new Error(`Blueprint ${id} not found`)
  const now = Date.now()
  if (updates.isDefault) {
    db.prepare('UPDATE pipeline_blueprints SET is_default = 0').run()
  }
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name) }
  if (updates.steps !== undefined) { sets.push('steps = ?'); params.push(JSON.stringify(updates.steps)) }
  if (updates.isDefault !== undefined) { sets.push('is_default = ?'); params.push(updates.isDefault ? 1 : 0) }
  params.push(id)
  db.prepare(`UPDATE pipeline_blueprints SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getBlueprint(id)!
}

export function deleteBlueprint(id: string): void {
  const bp = getBlueprint(id)
  if (!bp) throw new Error(`Blueprint ${id} not found`)
  // Reject if active tasks reference it
  const activeCount = db.prepare(
    "SELECT COUNT(*) as count FROM pipeline_tasks WHERE pipeline_id = ? AND \"column\" NOT IN ('done')"
  ).get(id) as { count: number }
  if (activeCount.count > 0) {
    throw new Error(`Cannot delete blueprint "${bp.name}" — ${activeCount.count} active tasks reference it`)
  }
  db.prepare('DELETE FROM pipeline_blueprints WHERE id = ?').run(id)
}
