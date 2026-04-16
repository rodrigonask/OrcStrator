import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { sendMessage } from '../services/claude-process.js'
import { processRegistry } from '../services/process-registry.js'
import { preprocessImages, detectMediaType } from '../services/image-processor.js'
import { getLastAssistantMessage } from '../services/session-sync.js'
import { orchestrator } from '../services/orchestrator.js'
import { dispatchCommand, isValidCommand, getAllCommands } from '../services/command-registry.js'
import crypto from 'crypto'

export default async function instanceRoutes(app: FastifyInstance): Promise<void> {
  // Create instance
  app.post('/instances', async (request, reply) => {
    const body = request.body as Record<string, unknown>
    const id = crypto.randomUUID()
    const now = Date.now()

    db.prepare(`
      INSERT INTO instances (id, folder_id, name, cwd, session_id, state, agent_id, idle_restart_minutes, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.folderId as string,
      body.name as string || 'Instance',
      body.cwd as string || '',
      null,
      'idle',
      body.agentId as string || null,
      body.idleRestartMinutes as number ?? 0,
      body.sortOrder as number ?? 0,
      now
    )

    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown>
    const instance = rowToInstance(row)
    broadcastEvent({ type: 'instance:created', payload: instance })
    reply.code(201)
    return instance
  })

  // Update instance
  app.put('/instances/:id', async (request) => {
    const { id } = request.params as { id: string }
    const body = request.body as Record<string, unknown>

    const sets: string[] = []
    const params: unknown[] = []

    const fieldMap: Record<string, string> = {
      name: 'name', cwd: 'cwd', sessionId: 'session_id',
      state: 'state', agentId: 'agent_id',
      idleRestartMinutes: 'idle_restart_minutes', sortOrder: 'sort_order',
      agentRole: 'agent_role', specialization: 'specialization',
      orchestratorManaged: 'orchestrator_managed'
    }

    const boolFields = new Set(['orchestratorManaged'])
    const nullableFields = new Set(['agentRole', 'specialization'])
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (body[jsKey] !== undefined) {
        sets.push(`${dbKey} = ?`)
        const val = body[jsKey]
        if (nullableFields.has(jsKey) && val === null) {
          params.push(null)
        } else {
          params.push(boolFields.has(jsKey) ? (val ? 1 : 0) : val)
        }
      }
    }

    if (sets.length === 0) return { ok: true }

    params.push(id)
    db.prepare(`UPDATE instances SET ${sets.join(', ')} WHERE id = ?`).run(...params)

    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown>
    const instance = rowToInstance(row)
    broadcastEvent({ type: 'instance:updated', payload: instance })

    // If role or managed status changed, let the orchestrator try to assign work immediately
    if (body.agentRole !== undefined || body.orchestratorManaged !== undefined) {
      const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(row.folder_id as string) as Record<string, unknown> | undefined
      if (folder?.orchestrator_active) {
        orchestrator.triggerFolder(row.folder_id as string)
      }
    }

    return instance
  })

  // Delete instance
  app.delete('/instances/:id', async (request) => {
    const { id } = request.params as { id: string }
    await processRegistry.killProcess(id)
    db.prepare('DELETE FROM instances WHERE id = ?').run(id)
    broadcastEvent({ type: 'instance:deleted', payload: { id } })
    return { ok: true }
  })

  // Send message to instance
  app.post('/instances/:id/send', async (request) => {
    const { id } = request.params as { id: string }
    const body = request.body as { text: string; images?: string[]; flags?: string[] }

    const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!instance) {
      throw { statusCode: 404, message: 'Instance not found' }
    }

    // Guard: reject if already running to prevent duplicate spawns from rapid clicks
    if (processRegistry.isTracked(id)) {
      throw { statusCode: 409, message: 'Instance already running' }
    }

    // Load settings for global flags
    const flagRows = db.prepare("SELECT value FROM settings WHERE key = 'globalFlags'").get() as { value: string } | undefined
    const globalFlags: string[] = flagRows ? JSON.parse(flagRows.value) : []

    // Load defaultModel setting and inject --model flag if needed
    const defaultModelRow = db.prepare("SELECT value FROM settings WHERE key = 'defaultModel'").get() as { value: string } | undefined
    const defaultModel = defaultModelRow?.value?.replace(/^"|"$/g, '') || 'default'
    const allFlags = [...globalFlags, ...(body.flags || [])]
    const hasModelFlag = allFlags.some(f => f.startsWith('--model'))
    if (defaultModel && defaultModel !== 'default' && !hasModelFlag) {
      globalFlags.push(`--model=${defaultModel}`)
    }

    // Load agent prompt if assigned
    let agentPrompt: string | undefined
    if (instance.agent_id) {
      const agent = db.prepare('SELECT content FROM agents WHERE id = ?').get(instance.agent_id) as { content: string } | undefined
      if (agent?.content) {
        agentPrompt = agent.content
      }
    }

    // Stealth mode: prepend no-memory instruction if folder has stealth_mode enabled
    const folderRow = db.prepare('SELECT stealth_mode FROM folders WHERE id = (SELECT folder_id FROM instances WHERE id = ?)').get(id) as { stealth_mode: number } | undefined
    if (folderRow?.stealth_mode) {
      const stealthNote = 'STEALTH MODE: Do not use the Memory tool. Do not create or update any CLAUDE.md memory files. Do not persist any context between conversations.'
      agentPrompt = agentPrompt ? `${stealthNote}\n\n${agentPrompt}` : stealthNote
    }

    // Detect media types and preprocess images (compress, tile, stitch as needed)
    let processedImages: Array<{ base64: string; mediaType: string }> | undefined
    let imageTextPrefix = ''
    if (body.images && body.images.length > 0) {
      const rawImages = body.images.map(b64 => ({ base64: b64, mediaType: detectMediaType(b64) }))
      const preprocessed = await preprocessImages(rawImages)
      processedImages = preprocessed.images
      imageTextPrefix = preprocessed.textPrefix
    }

    // Save user message to DB (original images for display)
    const msgId = crypto.randomUUID()
    const now = Date.now()
    const content: Array<Record<string, unknown>> = []
    if (body.text) content.push({ type: 'text', text: body.text })
    if (body.images) {
      for (const img of body.images) {
        content.push({ type: 'image', base64: img, mediaType: detectMediaType(img) })
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: '' })

    db.prepare(`
      INSERT INTO messages (id, instance_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(msgId, id, 'user', JSON.stringify(content), now)

    const result = await sendMessage({
      instanceId: id,
      text: (imageTextPrefix + body.text) || (processedImages?.length ? '[Attached image(s)]' : body.text),
      images: processedImages,
      cwd: instance.cwd as string,
      sessionId: instance.session_id as string | undefined,
      flags: [...globalFlags, ...(body.flags || [])],
      agentPrompt
    })

    return { sessionId: result.sessionId }
  })

  // Send a CLI slash command — dispatched through the command registry
  // Each command is routed to the appropriate strategy handler (skill, native, client-only, etc.)
  app.post('/instances/:id/command', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { command: rawCommand } = request.body as { command: string }
    if (!rawCommand) { reply.code(400); return { error: 'Missing command' } }

    const baseCmd = rawCommand.split(/\s/)[0].toLowerCase()
    if (!isValidCommand(baseCmd)) {
      reply.code(400)
      return { error: `Unknown command: ${baseCmd}. Type /help to see available commands.` }
    }

    const instance = db.prepare('SELECT session_id, cwd FROM instances WHERE id = ?').get(id) as { session_id: string | null; cwd: string } | undefined
    if (!instance) { reply.code(404); return { error: 'Not found' } }

    return dispatchCommand(rawCommand, {
      instanceId: id,
      sessionId: instance.session_id,
      cwd: instance.cwd,
      args: '',
    })
  })

  // List all available commands (for client command palette)
  app.get('/instances/commands', async () => {
    return { commands: getAllCommands() }
  })

  // Write data to a running process's stdin (for responding to CLI prompts like login/permissions)
  app.post('/instances/:id/stdin', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { data } = request.body as { data: string }
    if (typeof data !== 'string') { reply.code(400); return { error: 'Missing data' } }
    if (!processRegistry.isTracked(id)) { reply.code(404); return { error: 'No running process for this instance' } }
    const ok = processRegistry.writeStdin(id, data)
    return { ok }
  })

  // Kill instance process (stops Claude, resets to idle — does not delete instance)
  app.post('/instances/:id/kill', async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = db.prepare('SELECT id FROM instances WHERE id = ?').get(id) as { id: string } | undefined
    if (!row) { reply.code(404); return { error: 'Not found' } }
    const wasRunning = processRegistry.isTracked(id)
    await processRegistry.killProcess(id)
    db.prepare("UPDATE instances SET state = 'idle', process_state = 'idle', process_pid = NULL, assigned_task_ids = NULL, version = version + 1 WHERE id = ?").run(id)
    broadcastEvent({ type: 'instance:state', payload: { instanceId: id, state: 'idle' } })
    return { killed: wasRunning }
  })

  // Pause instance
  app.post('/instances/:id/pause', async (request) => {
    const { id } = request.params as { id: string }
    await processRegistry.killProcess(id)
    db.prepare("UPDATE instances SET state = 'paused', process_state = 'idle', process_pid = NULL, assigned_task_ids = NULL, version = version + 1 WHERE id = ?").run(id)
    broadcastEvent({ type: 'instance:state', payload: { instanceId: id, state: 'paused' } })
    return { ok: true }
  })

  // Resume instance
  app.post('/instances/:id/resume', async (request) => {
    const { id } = request.params as { id: string }
    db.prepare("UPDATE instances SET state = 'idle' WHERE id = ?").run(id)
    broadcastEvent({ type: 'instance:state', payload: { instanceId: id, state: 'idle' } })
    return { ok: true }
  })

  // Sync session — read last assistant message from session JSONL
  app.post('/instances/:id/sync-session', async (request) => {
    const { id } = request.params as { id: string }
    const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!instance) {
      throw { statusCode: 404, message: 'Instance not found' }
    }

    if (!instance.session_id || !instance.cwd) {
      return { message: null }
    }

    const message = getLastAssistantMessage(instance.cwd as string, instance.session_id as string)
    return { message }
  })

  // Reorder instances
  app.put('/instances/reorder', async (request) => {
    const { ids } = request.body as { ids: string[] }
    const stmt = db.prepare('UPDATE instances SET sort_order = ? WHERE id = ?')
    const transaction = db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        stmt.run(i, ids[i])
      }
    })
    transaction()
    broadcastEvent({ type: 'instances:reordered', payload: { ids } })
    return { ok: true }
  })
}

function rowToInstance(r: Record<string, unknown>) {
  return {
    id: r.id as string,
    folderId: r.folder_id as string,
    name: r.name as string,
    cwd: r.cwd as string,
    sessionId: r.session_id as string | undefined,
    state: (r.state as string) || 'idle',
    agentId: r.agent_id as string | undefined,
    idleRestartMinutes: r.idle_restart_minutes as number,
    sortOrder: r.sort_order as number,
    createdAt: r.created_at as number,
    agentRole: r.agent_role as string | undefined,
    specialization: r.specialization as string | undefined,
    orchestratorManaged: Boolean(r.orchestrator_managed),
    xpTotal: (r.xp_total as number) ?? 0,
    level: (r.level as number) ?? 1,
    overdriveTasks: (r.overdrive_tasks as number) ?? 0,
    overdriveStartedAt: r.overdrive_started_at as number | undefined,
    lastTaskAt: r.last_task_at as number | undefined,
  }
}
