import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import * as taskManager from '../services/task-manager.js'
import type { PipelineColumn, PipelineTask, TaskAttachment, TaskComment, ScheduleConfig } from '@orcstrator/shared'
import { computeNextRun } from '@orcstrator/shared'
import crypto from 'crypto'

export default async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  // List all project pipelines (lightweight: excludes done tasks, history, full descriptions)
  app.get('/pipelines', async (request) => {
    const query = request.query as { includeDone?: string }
    const includeDone = query.includeDone === 'true'
    const rows = db.prepare('SELECT DISTINCT project_id FROM pipeline_tasks').all() as Array<{ project_id: string }>
    const pipelines: Record<string, unknown[]> = {}
    for (const row of rows) {
      pipelines[row.project_id] = includeDone
        ? taskManager.getTasksForProject(row.project_id, true)
        : taskManager.getTasksForProjectLight(row.project_id)
    }
    return pipelines
  })

  // Get tasks for a specific project
  app.get('/pipelines/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const query = request.query as { includeDone?: string }
    return query.includeDone === 'true'
      ? taskManager.getTasksForProject(projectId, true)
      : taskManager.getTasksForProjectLight(projectId)
  })

  // Get single task (full payload with description)
  app.get('/pipelines/:projectId/tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as { projectId: string; taskId: string }
    const task = taskManager.getTask(taskId)
    if (!task) {
      reply.code(404)
      return { error: 'Task not found' }
    }
    return task
  })

  // Create task
  app.post('/pipelines/:projectId/tasks', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const body = request.body as Record<string, unknown>
    const task = await taskManager.createTask({
      projectId,
      title: body.title as string,
      description: body.description as string | undefined,
      column: body.column as PipelineColumn | undefined,
      priority: body.priority as 1 | 2 | 3 | 4 | undefined,
      labels: body.labels as string[] | undefined,
      attachments: body.attachments as TaskAttachment[] | undefined,
      groupId: body.groupId as string | undefined,
      groupIndex: body.groupIndex as number | undefined,
      groupTotal: body.groupTotal as number | undefined,
      dependsOn: body.dependsOn as string[] | undefined,
      createdBy: body.createdBy as string | undefined,
      skill: body.skill as string | undefined,
    })
    reply.code(201)
    return task
  })

  // Update task
  app.put('/pipelines/:projectId/tasks/:taskId', async (request) => {
    const { taskId } = request.params as { projectId: string; taskId: string }
    const body = request.body as Record<string, unknown>
    return taskManager.updateTask(taskId, {
      title: body.title as string | undefined,
      description: body.description as string | undefined,
      priority: body.priority as 1 | 2 | 3 | 4 | undefined,
      labels: body.labels as string[] | undefined,
      dependsOn: body.dependsOn as string[] | undefined,
      skill: body.skill as string | undefined,
    })
  })

  // Update task schedule
  app.put('/pipelines/:projectId/tasks/:taskId/schedule', async (request, reply) => {
    const { taskId } = request.params as { projectId: string; taskId: string }
    const schedule = request.body as ScheduleConfig
    if (!schedule || !schedule.type) {
      reply.code(400)
      return { error: 'schedule.type is required' }
    }
    return taskManager.updateTaskSchedule(taskId, schedule)
  })

  // Delete task
  app.delete('/pipelines/:projectId/tasks/:taskId', async (request) => {
    const { taskId } = request.params as { projectId: string; taskId: string }
    await taskManager.deleteTask(taskId)
    return { ok: true }
  })

  // Move task
  app.post('/pipelines/:projectId/tasks/:taskId/move', async (request) => {
    const { taskId } = request.params as { projectId: string; taskId: string }
    const { column, agent } = request.body as { column: PipelineColumn; agent?: string }
    return taskManager.moveTask(taskId, column, agent)
  })

  // Claim task
  app.post('/pipelines/:projectId/tasks/:taskId/claim', async (request) => {
    const { taskId } = request.params as { projectId: string; taskId: string }
    const { agentRole } = request.body as { agentRole: string }
    return taskManager.claimTask(taskId, agentRole)
  })

  // Block task
  app.post('/pipelines/:projectId/tasks/:taskId/block', async (request) => {
    const { taskId } = request.params as { projectId: string; taskId: string }
    const { reason, agent } = request.body as { reason: string; agent?: string }
    return taskManager.blockTask(taskId, reason, agent)
  })

  // Unblock task
  app.post('/pipelines/:projectId/tasks/:taskId/unblock', async (request) => {
    const { taskId } = request.params as { projectId: string; taskId: string }
    const { agent } = request.body as { agent?: string }
    return taskManager.unblockTask(taskId, agent)
  })

  // Get comments for a task
  app.get('/pipelines/:projectId/tasks/:taskId/comments', async (request) => {
    const { taskId } = request.params as { projectId: string; taskId: string }
    const rows = db.prepare(
      'SELECT id, task_id, author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at ASC'
    ).all(taskId) as Array<Record<string, unknown>>
    return rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      author: r.author,
      body: r.body,
      createdAt: r.created_at,
    } as TaskComment))
  })

  // Add a comment to a task
  app.post('/pipelines/:projectId/tasks/:taskId/comments', async (request, reply) => {
    const { taskId } = request.params as { projectId: string; taskId: string }
    const body = request.body as { author?: string; body: string }
    if (!body.body?.trim()) {
      reply.code(400)
      return { error: 'Comment body is required' }
    }
    const now = Date.now()
    const author = body.author?.trim() || 'human'
    // Dedup guard 1: exact body match within 60s
    const exactDupe = db.prepare(
      'SELECT id FROM task_comments WHERE task_id = ? AND body = ? AND created_at > ?'
    ).get(taskId, body.body.trim(), now - 60_000) as Record<string, unknown> | undefined
    if (exactDupe) {
      reply.code(409)
      return { error: 'Duplicate comment', existingId: exactDupe.id }
    }
    // Dedup guard 2: same non-human author on same task within 5 minutes (catches rephrased dupes)
    if (author !== 'human') {
      const recentByAuthor = db.prepare(
        'SELECT id FROM task_comments WHERE task_id = ? AND author = ? AND created_at > ?'
      ).get(taskId, author, now - 300_000) as Record<string, unknown> | undefined
      if (recentByAuthor) {
        reply.code(409)
        return { error: 'Rate limited: same author commented recently', existingId: recentByAuthor.id }
      }
    }
    const id = crypto.randomUUID()
    db.prepare(
      'INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, taskId, author, body.body.trim(), now)
    reply.code(201)
    return { id, taskId, author, body: body.body.trim(), createdAt: now } as TaskComment
  })

  // Get next task
  app.get('/pipelines/:projectId/next', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const query = request.query as { column?: PipelineColumn; role?: string }
    const task = taskManager.getNextTask(projectId, query.column, query.role)
    return task || null
  })

  // Get scheduled tasks with upcoming runs for the next N days
  app.get('/pipelines/:projectId/scheduled-upcoming', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const query = request.query as { days?: string }
    const days = parseInt(query.days || '30', 10)
    const now = Date.now()
    const horizon = now + days * 24 * 60 * 60 * 1000

    const rows = db.prepare(
      "SELECT * FROM pipeline_tasks WHERE project_id = ? AND \"column\" = 'scheduled'"
    ).all(projectId) as Record<string, unknown>[]

    return rows.map(row => {
      let schedule: ScheduleConfig | null = null
      try { schedule = row.schedule ? JSON.parse(row.schedule as string) : null } catch { /* ignore */ }
      let executions: unknown[] = []
      try { executions = JSON.parse((row.executions as string) || '[]') } catch { /* ignore */ }

      const nextRunAt = schedule ? (schedule.nextRunAt ?? computeNextRun(schedule, now)) : undefined

      return {
        id: row.id,
        title: row.title,
        skill: row.skill,
        schedule,
        executions: (executions as Array<Record<string, unknown>>).slice(-5), // last 5 runs
        nextRunAt,
        withinHorizon: nextRunAt != null && nextRunAt <= horizon,
        currentlyRunning: schedule?.currentlyRunning ?? false,
      }
    }).filter(t => t.schedule != null)
  })
}
