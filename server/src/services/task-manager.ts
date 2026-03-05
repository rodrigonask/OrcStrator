import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import type { PipelineTask, PipelineColumn, TaskHistoryEntry, TaskAttachment } from '@nasklaude/shared'
import crypto from 'crypto'
import { orchestrator } from './orchestrator.js'

// Per-project mutex to serialize writes
const locks = new Map<string, Promise<void>>()

async function withLock<T>(projectId: string, fn: () => T): Promise<T> {
  const prev = locks.get(projectId) ?? Promise.resolve()
  let resolve: () => void
  const next = new Promise<void>(r => { resolve = r })
  locks.set(projectId, next)
  await prev
  try {
    return fn()
  } finally {
    resolve!()
    if (locks.get(projectId) === next) locks.delete(projectId)
  }
}

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
    completedAt: row.completed_at as number | undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number
  }
}

function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback
  try {
    return JSON.parse(str) as T
  } catch {
    return fallback
  }
}

function broadcastPipeline(projectId: string, taskId: string, action: string, newColumn?: PipelineColumn): void {
  broadcastEvent({
    type: 'pipeline:updated',
    payload: { projectId, taskId, action, newColumn }
  })
}

export async function createTask(params: {
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
}): Promise<PipelineTask> {
  return withLock(params.projectId, () => {
    const now = Date.now()
    const id = crypto.randomUUID()
    const history: TaskHistoryEntry[] = [{ action: 'created', timestamp: now, agent: params.createdBy || 'human' }]

    db.prepare(`
      INSERT INTO pipeline_tasks (id, project_id, title, description, "column", priority, labels, attachments, assigned_agent, group_id, group_index, group_total, depends_on, created_by, history, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.projectId,
      params.title,
      params.description || '',
      params.column || 'backlog',
      params.priority || 4,
      JSON.stringify(params.labels || []),
      JSON.stringify(params.attachments || []),
      params.groupId || null,
      params.groupIndex ?? null,
      params.groupTotal ?? null,
      JSON.stringify(params.dependsOn || []),
      params.createdBy || 'human',
      JSON.stringify(history),
      now,
      now
    )

    const task = getTask(id)!
    broadcastPipeline(params.projectId, id, 'created', task.column)
    return task
  })
}

export async function moveTask(taskId: string, column: PipelineColumn, agent?: string): Promise<PipelineTask> {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  return withLock(task.projectId, () => {
    const now = Date.now()
    const history: TaskHistoryEntry[] = safeJsonParse(
      (db.prepare('SELECT history FROM pipeline_tasks WHERE id = ?').get(taskId) as Record<string, string>)?.history,
      []
    )
    history.push({ action: 'moved', timestamp: now, agent, from: task.column, to: column })

    const completedAt = column === 'done' ? now : null

    db.prepare(`
      UPDATE pipeline_tasks SET "column" = ?, history = ?, updated_at = ?, completed_at = COALESCE(?, completed_at),
        locked_by = NULL, locked_at = NULL
      WHERE id = ?
    `).run(column, JSON.stringify(history), now, completedAt, taskId)

    const updated = getTask(taskId)!
    broadcastPipeline(task.projectId, taskId, 'moved', column)
    // Notify orchestrator so it can immediately assign the next agent (only if enabled)
    setImmediate(() => {
      const folder = db.prepare('SELECT orchestrator_active FROM folders WHERE id = ?').get(task.projectId) as { orchestrator_active: number } | undefined
      if (folder?.orchestrator_active) {
        orchestrator.triggerFolder(task.projectId)
      }
    })
    return updated
  })
}

export async function claimTask(taskId: string, agentRole: string): Promise<PipelineTask> {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  return withLock(task.projectId, () => {
    const now = Date.now()
    const history: TaskHistoryEntry[] = safeJsonParse(
      (db.prepare('SELECT history FROM pipeline_tasks WHERE id = ?').get(taskId) as Record<string, string>)?.history,
      []
    )
    history.push({ action: 'claimed', timestamp: now, agent: agentRole })

    db.prepare(`
      UPDATE pipeline_tasks SET assigned_agent = ?, history = ?, updated_at = ?
      WHERE id = ?
    `).run(agentRole, JSON.stringify(history), now, taskId)

    const updated = getTask(taskId)!
    broadcastPipeline(task.projectId, taskId, 'claimed')
    return updated
  })
}

export async function blockTask(taskId: string, reason: string, agent?: string): Promise<PipelineTask> {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  return withLock(task.projectId, () => {
    const now = Date.now()
    const labels: string[] = safeJsonParse(
      (db.prepare('SELECT labels FROM pipeline_tasks WHERE id = ?').get(taskId) as Record<string, string>)?.labels,
      []
    )
    if (!labels.includes('blocked')) labels.push('blocked')

    const history: TaskHistoryEntry[] = safeJsonParse(
      (db.prepare('SELECT history FROM pipeline_tasks WHERE id = ?').get(taskId) as Record<string, string>)?.history,
      []
    )
    history.push({ action: 'blocked', timestamp: now, agent, note: reason })

    db.prepare(`
      UPDATE pipeline_tasks SET labels = ?, history = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(labels), JSON.stringify(history), now, taskId)

    const updated = getTask(taskId)!
    broadcastPipeline(task.projectId, taskId, 'blocked')
    return updated
  })
}

export async function unblockTask(taskId: string, agent?: string): Promise<PipelineTask> {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  return withLock(task.projectId, () => {
    const now = Date.now()
    const labels: string[] = safeJsonParse(
      (db.prepare('SELECT labels FROM pipeline_tasks WHERE id = ?').get(taskId) as Record<string, string>)?.labels,
      []
    )
    const filtered = labels.filter(l => l !== 'blocked')

    const history: TaskHistoryEntry[] = safeJsonParse(
      (db.prepare('SELECT history FROM pipeline_tasks WHERE id = ?').get(taskId) as Record<string, string>)?.history,
      []
    )
    history.push({ action: 'unblocked', timestamp: now, agent })

    db.prepare(`
      UPDATE pipeline_tasks SET labels = ?, history = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(filtered), JSON.stringify(history), now, taskId)

    const updated = getTask(taskId)!
    broadcastPipeline(task.projectId, taskId, 'unblocked')
    return updated
  })
}

export async function updateTask(taskId: string, updates: Partial<{
  title: string
  description: string
  priority: 1 | 2 | 3 | 4
  labels: string[]
  dependsOn: string[]
}>): Promise<PipelineTask> {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  return withLock(task.projectId, () => {
    const now = Date.now()
    const sets: string[] = ['updated_at = ?']
    const params: unknown[] = [now]

    if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title) }
    if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description) }
    if (updates.priority !== undefined) { sets.push('priority = ?'); params.push(updates.priority) }
    if (updates.labels !== undefined) { sets.push('labels = ?'); params.push(JSON.stringify(updates.labels)) }
    if (updates.dependsOn !== undefined) { sets.push('depends_on = ?'); params.push(JSON.stringify(updates.dependsOn)) }

    // Append edit history
    const history: TaskHistoryEntry[] = safeJsonParse(
      (db.prepare('SELECT history FROM pipeline_tasks WHERE id = ?').get(taskId) as Record<string, string>)?.history,
      []
    )
    history.push({ action: 'edited', timestamp: now })
    sets.push('history = ?')
    params.push(JSON.stringify(history))

    params.push(taskId)
    db.prepare(`UPDATE pipeline_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params)

    const updated = getTask(taskId)!
    broadcastPipeline(task.projectId, taskId, 'updated')
    return updated
  })
}

export async function deleteTask(taskId: string): Promise<void> {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  await withLock(task.projectId, () => {
    db.prepare('DELETE FROM pipeline_tasks WHERE id = ?').run(taskId)
    broadcastPipeline(task.projectId, taskId, 'deleted')
  })
}

export function getTask(taskId: string): PipelineTask | null {
  const row = db.prepare('SELECT * FROM pipeline_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined
  if (!row) return null
  return rowToTask(row)
}

export function getTasksForProject(projectId: string): PipelineTask[] {
  const rows = db.prepare('SELECT * FROM pipeline_tasks WHERE project_id = ? ORDER BY priority ASC, created_at ASC').all(projectId) as Record<string, unknown>[]
  return rows.map(rowToTask)
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
