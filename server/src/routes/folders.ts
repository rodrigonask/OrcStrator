import type { FastifyInstance } from 'fastify'
import type { FolderConfig } from '@orcstrator/shared'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { processRegistry } from '../services/process-registry.js'
import crypto from 'crypto'

function rowToFolder(r: Record<string, unknown>): FolderConfig {
  return {
    id: r.id as string,
    path: r.path as string,
    name: r.name as string,
    displayName: r.display_name as string | undefined,
    emoji: r.emoji as string | undefined,
    client: r.client as string | undefined,
    projectType: r.project_type as FolderConfig['projectType'],
    color: r.color as string | undefined,
    status: (r.status as FolderConfig['status']) || 'active',
    repoUrl: r.repo_url as string | undefined,
    notes: r.notes as string | undefined,
    expanded: Boolean(r.expanded),
    sortOrder: r.sort_order as number,
    createdAt: r.created_at as number,
    orchestratorActive: Boolean(r.orchestrator_active),
    stealthMode: Boolean(r.stealth_mode),
  }
}

export default async function folderRoutes(app: FastifyInstance): Promise<void> {
  // Create folder
  app.post('/folders', async (request, reply) => {
    const body = request.body as Record<string, unknown>
    const id = crypto.randomUUID()
    const now = Date.now()

    db.prepare(`
      INSERT INTO folders (id, path, name, display_name, emoji, client, project_type, color, status, repo_url, notes, expanded, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.path as string,
      body.name as string || '',
      body.displayName as string || null,
      body.emoji as string || null,
      body.client as string || null,
      body.projectType as string || 'other',
      body.color as string || null,
      body.status as string || 'active',
      body.repoUrl as string || null,
      body.notes as string || null,
      body.expanded !== undefined ? (body.expanded ? 1 : 0) : 1,
      body.sortOrder as number ?? 0,
      now
    )

    const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Record<string, unknown>
    const folder = rowToFolder(row)
    broadcastEvent({ type: 'folder:created', payload: folder })
    reply.code(201)
    return folder
  })

  // Update folder
  app.put('/folders/:id', async (request) => {
    const { id } = request.params as { id: string }
    const body = request.body as Record<string, unknown>

    const sets: string[] = []
    const params: unknown[] = []

    const fieldMap: Record<string, string> = {
      path: 'path', name: 'name', displayName: 'display_name',
      emoji: 'emoji', client: 'client', projectType: 'project_type',
      color: 'color', status: 'status', repoUrl: 'repo_url',
      notes: 'notes', expanded: 'expanded', sortOrder: 'sort_order',
      orchestratorActive: 'orchestrator_active',
      stealthMode: 'stealth_mode'
    }

    const boolFields = new Set(['expanded', 'orchestratorActive', 'stealthMode'])
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (body[jsKey] !== undefined) {
        sets.push(`${dbKey} = ?`)
        params.push(boolFields.has(jsKey) ? (body[jsKey] ? 1 : 0) : body[jsKey])
      }
    }

    if (sets.length === 0) return { ok: true }

    params.push(id)
    db.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).run(...params)

    const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Record<string, unknown>
    const folder = rowToFolder(row)
    broadcastEvent({ type: 'folder:updated', payload: folder })
    return folder
  })

  // Delete folder
  app.delete('/folders/:id', async (request) => {
    const { id } = request.params as { id: string }
    const deleteTx = db.transaction(() => {
      db.prepare('DELETE FROM task_comments WHERE task_id IN (SELECT id FROM pipeline_tasks WHERE project_id = ?)').run(id)
      db.prepare('DELETE FROM pipeline_tasks WHERE project_id = ?').run(id)
      db.prepare('DELETE FROM instances WHERE folder_id = ?').run(id)
      db.prepare('DELETE FROM folders WHERE id = ?').run(id)
    })
    deleteTx()
    broadcastEvent({ type: 'folder:deleted', payload: { id } })
    return { ok: true }
  })

  // Reorder folders
  app.put('/folders/reorder', async (request) => {
    const { ids } = request.body as { ids: string[] }
    const stmt = db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?')
    const transaction = db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        stmt.run(i, ids[i])
      }
    })
    transaction()
    broadcastEvent({ type: 'folders:reordered', payload: { ids } })
    return { ok: true }
  })

  // Pause all running instances in a folder and deactivate orchestrator
  app.post('/folders/:id/pause-all', async (request) => {
    const { id: folderId } = request.params as { id: string }
    const instances = db.prepare('SELECT * FROM instances WHERE folder_id = ?').all(folderId) as Record<string, unknown>[]

    await Promise.all(instances.map(inst => processRegistry.killProcess(inst.id as string)))

    db.prepare("UPDATE instances SET state = 'idle' WHERE folder_id = ?").run(folderId)
    db.prepare('UPDATE folders SET orchestrator_active = 0 WHERE id = ?').run(folderId)

    const idleAgents = instances.length
    const pendingTasks = db.prepare(`SELECT COUNT(*) as count FROM pipeline_tasks WHERE project_id = ? AND "column" IN ('backlog','ready','in_progress','in_review') AND locked_by IS NULL`)
      .get(folderId) as { count: number }

    broadcastEvent({ type: 'orchestrator:status', payload: { folderId, active: false, idleAgents, pendingTasks: pendingTasks.count } })
    for (const inst of instances) {
      broadcastEvent({ type: 'instance:updated', payload: { id: inst.id, state: 'idle' } })
    }

    return { paused: idleAgents }
  })

  // Release all sessions in a folder (clears session IDs, stops orchestrator, unlocks tasks)
  app.post('/folders/:id/release-all', async (request) => {
    const { id: folderId } = request.params as { id: string }
    const instances = db.prepare('SELECT * FROM instances WHERE folder_id = ?').all(folderId) as Record<string, unknown>[]

    await Promise.all(instances.map(inst => processRegistry.killProcess(inst.id as string)))

    db.prepare("UPDATE instances SET state = 'idle', session_id = NULL WHERE folder_id = ?").run(folderId)
    db.prepare('UPDATE folders SET orchestrator_active = 0 WHERE id = ?').run(folderId)

    // Release any pipeline tasks locked by instances in this folder
    const instanceIds = instances.map(i => i.id as string)
    if (instanceIds.length > 0) {
      const placeholders = instanceIds.map(() => '?').join(',')
      db.prepare(`UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL WHERE locked_by IN (${placeholders})`).run(...instanceIds)
    }

    const pendingTasks = db.prepare(`SELECT COUNT(*) as count FROM pipeline_tasks WHERE project_id = ? AND "column" IN ('backlog','ready','in_progress','in_review') AND locked_by IS NULL`)
      .get(folderId) as { count: number }
    broadcastEvent({ type: 'orchestrator:status', payload: { folderId, active: false, idleAgents: instances.length, pendingTasks: pendingTasks.count } })

    for (const inst of instances) {
      broadcastEvent({ type: 'instance:updated', payload: { id: inst.id, state: 'idle', sessionId: null } })
    }

    return { released: instances.length, instanceIds }
  })

  // Renew — kill all processes, clear sessions, release locked tasks, warm up fresh sessions
  app.post('/folders/:id/renew', async (request) => {
    const { id: folderId } = request.params as { id: string }
    const body = request.body as { newNames?: string[] }
    const instances = db.prepare('SELECT * FROM instances WHERE folder_id = ? ORDER BY sort_order ASC').all(folderId) as Record<string, unknown>[]

    // 1. Kill all running processes
    await Promise.all(instances.map(inst => processRegistry.killProcess(inst.id as string)))

    const oldInstanceIds = instances.map(i => i.id as string)

    // 2. Release any locked pipeline tasks
    if (oldInstanceIds.length > 0) {
      const ph = oldInstanceIds.map(() => '?').join(',')
      db.prepare(`UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL WHERE locked_by IN (${ph})`).run(...oldInstanceIds)
    }

    // 3. Delete message history for old instances
    if (oldInstanceIds.length > 0) {
      const ph = oldInstanceIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM messages WHERE instance_id IN (${ph})`).run(...oldInstanceIds)
    }

    // 4. Delete old instances
    db.prepare('DELETE FROM instances WHERE folder_id = ?').run(folderId)

    // 5. Create new instances with same configs but fresh IDs, names, and no session
    const now = Date.now()
    const newInstances: Record<string, unknown>[] = []
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i]
      const newId = crypto.randomUUID()
      const newName = body.newNames?.[i] ?? (inst.name as string)
      db.prepare(`
        INSERT INTO instances (id, folder_id, name, cwd, session_id, state, process_state, agent_id, idle_restart_minutes, sort_order, created_at, agent_role, specialization, orchestrator_managed)
        VALUES (?, ?, ?, ?, NULL, 'idle', 'idle', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId, folderId, newName, inst.cwd as string,
        (inst.agent_id as string) ?? null,
        (inst.idle_restart_minutes as number) ?? 0,
        (inst.sort_order as number) ?? i,
        now + i,
        (inst.agent_role as string) ?? null,
        (inst.specialization as string) ?? null,
        inst.orchestrator_managed ? 1 : 0
      )
      const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(newId) as Record<string, unknown>
      newInstances.push(row)
    }

    return { renewed: instances.length, oldInstanceIds, newInstances }
  })

  // Global shutdown — kill every running session across all folders
  app.post('/shutdown', async () => {
    const instances = db.prepare('SELECT * FROM instances').all() as Record<string, unknown>[]

    await Promise.all(instances.map(inst => processRegistry.killProcess(inst.id as string)))

    db.prepare("UPDATE instances SET state = 'idle', session_id = NULL").run()
    db.prepare('UPDATE folders SET orchestrator_active = 0').run()

    const instanceIds = instances.map(i => i.id as string)
    for (const inst of instances) {
      broadcastEvent({ type: 'instance:updated', payload: { id: inst.id, state: 'idle', sessionId: null } })
    }

    return { killed: instances.length, instanceIds }
  })

  // Terminate — kill everything then shut down the server process
  app.post('/terminate', async () => {
    const instances = db.prepare('SELECT * FROM instances').all() as Record<string, unknown>[]

    await Promise.all(instances.map(inst => processRegistry.killProcess(inst.id as string)))

    db.prepare("UPDATE instances SET state = 'idle', session_id = NULL").run()
    db.prepare('UPDATE folders SET orchestrator_active = 0').run()

    const instanceIds = instances.map(i => i.id as string)
    for (const inst of instances) {
      broadcastEvent({ type: 'instance:updated', payload: { id: inst.id, state: 'idle', sessionId: null } })
    }

    // Exit after response is sent
    setTimeout(() => process.exit(0), 500)

    return { ok: true, killed: instances.length, instanceIds }
  })
}
