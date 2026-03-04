import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import * as taskManager from '../services/task-manager.js'
import type { PipelineColumn, PipelineTask } from '@nasklaude/shared'

export default async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  // List all project pipelines
  app.get('/pipelines', async () => {
    const rows = db.prepare('SELECT DISTINCT project_id FROM pipeline_tasks').all() as Array<{ project_id: string }>
    const pipelines: Record<string, PipelineTask[]> = {}
    for (const row of rows) {
      pipelines[row.project_id] = taskManager.getTasksForProject(row.project_id)
    }
    return pipelines
  })

  // Get tasks for a specific project
  app.get('/pipelines/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string }
    return taskManager.getTasksForProject(projectId)
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
      groupId: body.groupId as string | undefined,
      groupIndex: body.groupIndex as number | undefined,
      groupTotal: body.groupTotal as number | undefined,
      dependsOn: body.dependsOn as string[] | undefined,
      createdBy: body.createdBy as string | undefined
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
      dependsOn: body.dependsOn as string[] | undefined
    })
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

  // Get next task
  app.get('/pipelines/:projectId/next', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const query = request.query as { column?: PipelineColumn; role?: string }
    const task = taskManager.getNextTask(projectId, query.column, query.role)
    return task || null
  })
}
