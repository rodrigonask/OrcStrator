import type { FastifyInstance } from 'fastify'
import type { FolderConfig, PermissionRuleSet } from '@orcstrator/shared'
import { dedupeRules, survivesAutoMode } from '@orcstrator/shared'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { processRegistry } from '../services/process-registry.js'
import { canonicalizeCwd } from '../services/canonical-path.js'
import { clearAwaitingInput } from '../services/awaiting-input.js'
import { parsePermissionRules } from '../services/permission-rule-sets.js'
import { folderRuleChain, readFolderRules, writeFolderRules } from '../services/folder-rules.js'
import crypto from 'crypto'
import { spawn, exec } from 'child_process'

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
    stealthMode: Boolean(r.stealth_mode),
    cloudSync: Boolean(r.cloud_sync),
    lastSyncedAt: r.last_synced_at as number | undefined,
    permissionRules: parsePermissionRules(r.permission_rules),
  }
}

export default async function folderRoutes(app: FastifyInstance): Promise<void> {
  /**
   * PROJECT permission rules: the middle scope behind "Allow always".
   *
   * Read returns two things, because the modal has to show both and the difference matters: `own`
   * is what THIS folder grants and is the only part that can be removed from here, and `chain` is
   * every folder from the outermost one down, so a chat in a sub-folder can see where an inherited
   * grant actually lives instead of wondering why it has a rule nobody set on it.
   */
  app.get('/folders/:id/permission-rules', async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = db.prepare('SELECT id FROM folders WHERE id = ?').get(id)
    if (!row) return reply.code(404).send({ error: 'Folder not found' })
    return { own: readFolderRules(id) ?? null, chain: folderRuleChain(id) }
  })

  /**
   * Add or remove project allow rules.
   *
   * A PATCH that appends and subtracts rather than a PUT that replaces, for the same reason the
   * app-wide route works that way: a tab that loaded an hour ago would otherwise wipe every rule
   * saved since, and a project's rules are exactly the kind a second chat adds to while the first
   * one's tab sits open.
   *
   * `add` refuses any rule auto mode drops. Saving one of those is the loop this whole feature was
   * built to end: the rule is stored, the CLI throws it away at spawn, the retry is refused again,
   * and the operator clicks Allow always a second time for nothing. The buttons never offer such a
   * rule; this is the backstop for anything else that calls the route.
   */
  app.patch('/folders/:id/permission-rules', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { add?: unknown; remove?: unknown } | undefined
    const row = db.prepare('SELECT id FROM folders WHERE id = ?').get(id)
    if (!row) return reply.code(404).send({ error: 'Folder not found' })

    const add = Array.isArray(body?.add) ? dedupeRules(body.add) : []
    const remove = Array.isArray(body?.remove) ? dedupeRules(body.remove) : []
    if (add.length === 0 && remove.length === 0) {
      reply.code(400)
      return { ok: false, error: 'Nothing to add or remove' }
    }
    const refused = add.filter(rule => !survivesAutoMode(rule))
    if (refused.length > 0) {
      reply.code(422)
      return { ok: false, error: 'auto-mode-would-drop', refused }
    }

    const current: PermissionRuleSet = readFolderRules(id) ?? {}
    const allow = dedupeRules([...(current.allow ?? []), ...add]).filter(rule => !remove.includes(rule))
    const next = writeFolderRules(id, { ...current, allow })
    return { ok: true, permissionRules: next ?? null }
  })

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
      canonicalizeCwd(body.path as string),
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
      stealthMode: 'stealth_mode',
      cloudSync: 'cloud_sync'
    }

    const boolFields = new Set(['expanded', 'stealthMode', 'cloudSync'])
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

  // Open folder in OS file explorer
  app.post('/folders/:id/open', async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = db.prepare('SELECT path FROM folders WHERE id = ?').get(id) as { path: string } | undefined
    if (!row) return reply.code(404).send({ error: 'Folder not found' })

    const folderPath = row.path
    const platform = process.platform

    if (platform === 'win32') {
      const safePath = folderPath.replace(/\\/g, '/').replace(/'/g, "''")
      exec(`powershell.exe -NoProfile -Command "Invoke-Item '${safePath}'"`)
    } else {
      const bin = platform === 'darwin' ? 'open' : 'xdg-open'
      spawn(bin, [folderPath], { detached: true, stdio: 'ignore', shell: false }).unref()
    }

    return { ok: true, path: folderPath }
  })

  // Pause all running instances in a folder
  app.post('/folders/:id/pause-all', async (request) => {
    const { id: folderId } = request.params as { id: string }
    const instances = db.prepare('SELECT * FROM instances WHERE folder_id = ?').all(folderId) as Record<string, unknown>[]

    await Promise.all(instances.map(inst => processRegistry.killProcess(inst.id as string)))

    db.prepare("UPDATE instances SET state = 'idle' WHERE folder_id = ?").run(folderId)
    for (const inst of instances) clearAwaitingInput(inst.id as string)

    for (const inst of instances) {
      broadcastEvent({ type: 'instance:updated', payload: { id: inst.id, state: 'idle' } })
    }

    return { paused: instances.length }
  })

  // Release all sessions in a folder (clears session IDs)
  app.post('/folders/:id/release-all', async (request) => {
    const { id: folderId } = request.params as { id: string }
    const instances = db.prepare('SELECT * FROM instances WHERE folder_id = ?').all(folderId) as Record<string, unknown>[]

    await Promise.all(instances.map(inst => processRegistry.killProcess(inst.id as string)))

    db.prepare("UPDATE instances SET state = 'idle', session_id = NULL WHERE folder_id = ?").run(folderId)
    for (const inst of instances) clearAwaitingInput(inst.id as string)

    const instanceIds = instances.map(i => i.id as string)

    for (const inst of instances) {
      broadcastEvent({ type: 'instance:updated', payload: { id: inst.id, state: 'idle', sessionId: null } })
    }

    return { released: instances.length, instanceIds }
  })

  // Close All — kill all processes and delete all instances in the folder
  app.post('/folders/:id/close-all', async (request) => {
    const { id: folderId } = request.params as { id: string }
    const instances = db.prepare('SELECT * FROM instances WHERE folder_id = ?').all(folderId) as Record<string, unknown>[]

    await Promise.all(instances.map(inst => processRegistry.killProcess(inst.id as string)))

    const instanceIds = instances.map(i => i.id as string)

    db.prepare('DELETE FROM instances WHERE folder_id = ?').run(folderId)

    for (const id of instanceIds) {
      broadcastEvent({ type: 'instance:deleted', payload: { id } })
    }

    return { closed: instances.length, instanceIds }
  })

  // Renew — kill all processes, clear sessions, release locked tasks, warm up fresh sessions
  app.post('/folders/:id/renew', async (request) => {
    const { id: folderId } = request.params as { id: string }
    const body = request.body as { newNames?: string[] }
    const instances = db.prepare('SELECT * FROM instances WHERE folder_id = ? ORDER BY sort_order ASC').all(folderId) as Record<string, unknown>[]

    // 1. Kill all running processes
    await Promise.all(instances.map(inst => processRegistry.killProcess(inst.id as string)))

    const oldInstanceIds = instances.map(i => i.id as string)

    // 2. Delete message history for old instances
    if (oldInstanceIds.length > 0) {
      const ph = oldInstanceIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM messages WHERE instance_id IN (${ph})`).run(...oldInstanceIds)
    }

    // 3. Delete old instances
    db.prepare('DELETE FROM instances WHERE folder_id = ?').run(folderId)

    // 4. Create new instances with same configs but fresh IDs, names, and no session
    const now = Date.now()
    const newInstances: Record<string, unknown>[] = []
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i]
      const newId = crypto.randomUUID()
      const newName = body.newNames?.[i] ?? (inst.name as string)
      db.prepare(`
        INSERT INTO instances (id, folder_id, name, cwd, session_id, state, process_state, agent_id, idle_restart_minutes, sort_order, created_at)
        VALUES (?, ?, ?, ?, NULL, 'idle', 'idle', ?, ?, ?, ?)
      `).run(
        newId, folderId, newName, inst.cwd as string,
        (inst.agent_id as string) ?? null,
        (inst.idle_restart_minutes as number) ?? 0,
        (inst.sort_order as number) ?? i,
        now + i
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

    // Sessions are gone, so no question survives this.
    db.prepare("UPDATE instances SET state = 'idle', session_id = NULL").run()
    // Unlike /terminate, shutdown leaves the SERVER AND THE CLIENT ALIVE, so a silent bulk
    // clear would leave amber chips on screen for questions the DB says are gone. Clear it
    // per instance so each one broadcasts.
    for (const inst of instances) clearAwaitingInput(inst.id as string)

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

    // Sessions are gone, so no question survives this. Folded into the same statement
    // rather than a per-instance broadcast loop: the client is going away anyway.
    db.prepare("UPDATE instances SET state = 'idle', session_id = NULL, awaiting_input = NULL, awaiting_input_at = NULL").run()

    const instanceIds = instances.map(i => i.id as string)
    for (const inst of instances) {
      broadcastEvent({ type: 'instance:updated', payload: { id: inst.id, state: 'idle', sessionId: null } })
    }

    // Exit after response is sent
    setTimeout(() => process.exit(0), 500)

    return { ok: true, killed: instances.length, instanceIds }
  })
}
