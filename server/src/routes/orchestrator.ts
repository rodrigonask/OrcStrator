import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { orchestrator, getOrcLogs, updateDevLock } from '../services/orchestrator.js'
import { getBlueprints, getBlueprint, createBlueprint, updateBlueprint, deleteBlueprint } from '../services/task-manager.js'

export default async function orchestratorRoutes(app: FastifyInstance): Promise<void> {
  // Orchestrator event log (ring buffer)
  app.get('/orchestrator/logs', async (request) => {
    const { type, limit, after } = request.query as Record<string, string>
    return {
      logs: getOrcLogs({
        type: type || undefined,
        limit: limit ? parseInt(limit, 10) : 100,
        after: after ? parseInt(after, 10) : undefined,
      }),
    }
  })

  // Restart status endpoint — used by client to check cooldown and show rebellion modal
  app.get('/orchestrator/restart-status', async () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'last_restart_at'").get() as { value: string } | undefined
    const lastRestartAt = row ? JSON.parse(row.value) as number : 0
    const cooldownRemaining = Math.max(0, 60_000 - (Date.now() - lastRestartAt))

    const adoptedRow = db.prepare("SELECT value FROM settings WHERE key = 'restart_adopted_count'").get() as { value: string } | undefined
    const adoptedCount = adoptedRow ? JSON.parse(adoptedRow.value) as number : 0

    const foldersRow = db.prepare("SELECT value FROM settings WHERE key = 'restart_deactivated_folders'").get() as { value: string } | undefined
    const deactivatedFolders = foldersRow ? JSON.parse(foldersRow.value) as string[] : []

    return {
      lastRestartAt,
      cooldownRemaining,
      cooldownActive: cooldownRemaining > 0,
      adoptedCount,
      deactivatedFolders,
    }
  })

  // Reactivate all previously-active folders after restart
  app.post('/orchestrator/reactivate-all', async (_request, reply) => {
    const restartRow = db.prepare("SELECT value FROM settings WHERE key = 'last_restart_at'").get() as { value: string } | undefined
    if (restartRow) {
      const lastRestart = JSON.parse(restartRow.value) as number
      const cooldownRemaining = Math.max(0, 60_000 - (Date.now() - lastRestart))
      if (cooldownRemaining > 0) {
        reply.code(429)
        return { error: 'Restart cooldown active', cooldownRemaining }
      }
    }

    const foldersRow = db.prepare("SELECT value FROM settings WHERE key = 'restart_deactivated_folders'").get() as { value: string } | undefined
    const folderIds = foldersRow ? JSON.parse(foldersRow.value) as string[] : []

    let activated = 0
    for (const folderId of folderIds) {
      const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId) as { id: string } | undefined
      if (folder) {
        db.prepare('UPDATE folders SET orchestrator_active = 1 WHERE id = ?').run(folderId)
        db.prepare(`UPDATE instances SET orchestrator_managed = 1 WHERE folder_id = ? AND agent_role IS NOT NULL AND orchestrator_managed = 0`).run(folderId)
        broadcastEvent({ type: 'folder:updated', payload: { id: folderId, orchestratorActive: true } })
        orchestrator.triggerFolder(folderId)
        activated++
      }
    }

    // Clear restart state
    db.prepare("DELETE FROM settings WHERE key IN ('restart_deactivated_folders', 'restart_adopted_count')").run()
    updateDevLock()

    return { ok: true, activated }
  })

  // Activate orchestrator for a folder
  app.post('/orchestrator/:folderId/activate', async (request, reply) => {
    const { folderId } = request.params as { folderId: string }

    // Cooldown check: block reactivation within 60s of a restart
    const restartRow = db.prepare("SELECT value FROM settings WHERE key = 'last_restart_at'").get() as { value: string } | undefined
    if (restartRow) {
      const lastRestart = JSON.parse(restartRow.value) as number
      const cooldownRemaining = Math.max(0, 60_000 - (Date.now() - lastRestart))
      if (cooldownRemaining > 0) {
        reply.code(429)
        return { error: 'Restart cooldown active — wait before reactivating', cooldownRemaining }
      }
    }

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
    updateDevLock()

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
    updateDevLock()

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

    const idleAgents = db.prepare(`SELECT COUNT(*) as count FROM instances WHERE folder_id = ? AND orchestrator_managed = 1 AND process_state = 'idle'`)
      .get(folderId) as { count: number }

    const runningAgents = db.prepare(`SELECT COUNT(*) as count FROM instances WHERE folder_id = ? AND orchestrator_managed = 1 AND process_state IN ('reserved', 'spawning', 'running')`)
      .get(folderId) as { count: number }

    const pendingTasks = db.prepare(`SELECT COUNT(*) as count FROM pipeline_tasks WHERE project_id = ? AND "column" IN ('ready','in_progress') AND locked_by IS NULL`)
      .get(folderId) as { count: number }

    return {
      folderId,
      active: Boolean(folder.orchestrator_active),
      idleAgents: idleAgents.count,
      runningAgents: runningAgents.count,
      pendingTasks: pendingTasks.count,
    }
  })

  // Bottleneck detection — per role (blueprint-driven)
  app.get('/orchestrator/:folderId/bottlenecks', async (request, reply) => {
    const { folderId } = request.params as { folderId: string }

    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Record<string, unknown> | undefined
    if (!folder) {
      reply.code(404)
      return { error: 'Folder not found' }
    }

    // Get distinct roles from tasks currently waiting
    const waitingByRole = db.prepare(`
      SELECT current_step_role AS role, COUNT(*) AS count
      FROM pipeline_tasks
      WHERE project_id = ? AND "column" IN ('ready', 'in_progress')
        AND locked_by IS NULL AND current_step_role IS NOT NULL
      GROUP BY current_step_role
    `).all(folderId) as Array<{ role: string; count: number }>

    const bottlenecks: Array<{ role: string; waitingTasks: number; idleAgents: number }> = []
    for (const { role, count } of waitingByRole) {
      if (count === 0) continue
      const idle = db.prepare(`SELECT COUNT(*) as count FROM instances WHERE folder_id = ? AND orchestrator_managed = 1 AND agent_role = ? AND process_state = 'idle'`)
        .get(folderId, role) as { count: number }
      if (idle.count === 0) {
        bottlenecks.push({ role, waitingTasks: count, idleAgents: 0 })
      }
    }

    return { bottlenecks }
  })

  // === BLUEPRINT CRUD ===

  app.get('/blueprints', async () => {
    return getBlueprints()
  })

  app.post('/blueprints', async (request) => {
    const { name, steps, isDefault } = request.body as { name: string; steps: Array<{ role: string; agentId?: string; instruction?: string }>; isDefault?: boolean }
    return createBlueprint({ name, steps, isDefault })
  })

  app.put('/blueprints/:id', async (request) => {
    const { id } = request.params as { id: string }
    const updates = request.body as { name?: string; steps?: Array<{ role: string; agentId?: string; instruction?: string }>; isDefault?: boolean }
    return updateBlueprint(id, updates)
  })

  app.delete('/blueprints/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      deleteBlueprint(id)
      return { ok: true }
    } catch (err) {
      reply.code(400)
      return { error: (err as Error).message }
    }
  })
}
