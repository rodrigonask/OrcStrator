import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { orchestrator } from '../services/orchestrator.js'

export default async function orchestratorRoutes(app: FastifyInstance): Promise<void> {
  // Activate orchestrator for a folder
  app.post('/orchestrator/:folderId/activate', async (request, reply) => {
    const { folderId } = request.params as { folderId: string }

    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Record<string, unknown> | undefined
    if (!folder) {
      reply.code(404)
      return { error: 'Folder not found' }
    }

    db.prepare('UPDATE folders SET orchestrator_active = 1 WHERE id = ?').run(folderId)

    // Auto-enroll any existing instances in this folder that have a role but aren't managed yet
    db.prepare(`UPDATE instances SET orchestrator_managed = 1 WHERE folder_id = ? AND agent_role IS NOT NULL AND orchestrator_managed = 0`).run(folderId)

    broadcastEvent({ type: 'folder:updated', payload: { id: folderId, orchestratorActive: true } })

    // Immediately try to assign work
    orchestrator.triggerFolder(folderId)

    return { ok: true, active: true }
  })

  // Deactivate orchestrator for a folder
  app.post('/orchestrator/:folderId/deactivate', async (request, reply) => {
    const { folderId } = request.params as { folderId: string }

    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Record<string, unknown> | undefined
    if (!folder) {
      reply.code(404)
      return { error: 'Folder not found' }
    }

    db.prepare('UPDATE folders SET orchestrator_active = 0 WHERE id = ?').run(folderId)
    broadcastEvent({ type: 'folder:updated', payload: { id: folderId, orchestratorActive: false } })
    orchestrator.broadcastStatus(folderId)

    return { ok: true, active: false }
  })

  // Get orchestrator status for a folder
  app.get('/orchestrator/:folderId/status', async (request, reply) => {
    const { folderId } = request.params as { folderId: string }

    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Record<string, unknown> | undefined
    if (!folder) {
      reply.code(404)
      return { error: 'Folder not found' }
    }

    const idleAgents = db.prepare(`SELECT COUNT(*) as count FROM instances WHERE folder_id = ? AND orchestrator_managed = 1 AND state = 'idle'`)
      .get(folderId) as { count: number }

    const runningAgents = db.prepare(`SELECT COUNT(*) as count FROM instances WHERE folder_id = ? AND orchestrator_managed = 1 AND state = 'running'`)
      .get(folderId) as { count: number }

    const pendingTasks = db.prepare(`SELECT COUNT(*) as count FROM pipeline_tasks WHERE project_id = ? AND "column" IN ('backlog','spec','build','qa','ship') AND locked_by IS NULL`)
      .get(folderId) as { count: number }

    return {
      folderId,
      active: Boolean(folder.orchestrator_active),
      idleAgents: idleAgents.count,
      runningAgents: runningAgents.count,
      pendingTasks: pendingTasks.count,
    }
  })

  // Bottleneck detection — per column
  app.get('/orchestrator/:folderId/bottlenecks', async (request, reply) => {
    const { folderId } = request.params as { folderId: string }

    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Record<string, unknown> | undefined
    if (!folder) {
      reply.code(404)
      return { error: 'Folder not found' }
    }

    const columnRoles: Record<string, string> = { backlog: 'planner', spec: 'planner', build: 'builder', qa: 'tester', ship: 'promoter' }
    const bottlenecks: Array<{ column: string; waitingTasks: number; idleAgents: number; role: string }> = []

    for (const [col, role] of Object.entries(columnRoles)) {
      const waiting = db.prepare(`SELECT COUNT(*) as count FROM pipeline_tasks WHERE project_id = ? AND "column" = ? AND locked_by IS NULL`)
        .get(folderId, col) as { count: number }

      if (waiting.count === 0) continue

      const idle = db.prepare(`SELECT COUNT(*) as count FROM instances WHERE folder_id = ? AND orchestrator_managed = 1 AND agent_role = ? AND state = 'idle'`)
        .get(folderId, role) as { count: number }

      if (idle.count === 0) {
        bottlenecks.push({ column: col, waitingTasks: waiting.count, idleAgents: 0, role })
      }
    }

    return { bottlenecks }
  })
}
