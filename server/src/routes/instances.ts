import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { sendMessage, killProcess } from '../services/claude-process.js'
import { preprocessImages, detectMediaType } from '../services/image-processor.js'
import { getLastAssistantMessage } from '../services/session-sync.js'
import { orchestrator } from '../services/orchestrator.js'
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
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (body[jsKey] !== undefined) {
        sets.push(`${dbKey} = ?`)
        params.push(boolFields.has(jsKey) ? (body[jsKey] ? 1 : 0) : body[jsKey])
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
    killProcess(id)
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

    // Load settings for global flags
    const flagRows = db.prepare("SELECT value FROM settings WHERE key = 'globalFlags'").get() as { value: string } | undefined
    const globalFlags: string[] = flagRows ? JSON.parse(flagRows.value) : []

    // Load agent prompt if assigned
    let agentPrompt: string | undefined
    if (instance.agent_id) {
      const agent = db.prepare('SELECT content FROM agents WHERE id = ?').get(instance.agent_id) as { content: string } | undefined
      if (agent?.content) {
        agentPrompt = agent.content
      }
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
    const content = [{ type: 'text', text: body.text }]
    if (body.images) {
      for (const img of body.images) {
        content.push({ type: 'image', base64: img, mediaType: detectMediaType(img) } as unknown as { type: string; text: string })
      }
    }

    db.prepare(`
      INSERT INTO messages (id, instance_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(msgId, id, 'user', JSON.stringify(content), now)

    const result = sendMessage({
      instanceId: id,
      text: imageTextPrefix + body.text,
      images: processedImages,
      cwd: instance.cwd as string,
      sessionId: instance.session_id as string | undefined,
      flags: [...globalFlags, ...(body.flags || [])],
      agentPrompt
    })

    return { sessionId: result.sessionId }
  })

  // Pause instance
  app.post('/instances/:id/pause', async (request) => {
    const { id } = request.params as { id: string }
    killProcess(id)
    db.prepare("UPDATE instances SET state = 'paused' WHERE id = ?").run(id)
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
  }
}
