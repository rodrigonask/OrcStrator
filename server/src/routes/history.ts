import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { clampLimit } from '../services/limits.js'
import { broadcastEvent } from '../ws/handler.js'
import crypto from 'crypto'
import type { ChatMessage, MessageContentBlock } from '@orcstrator/shared'
import { mediaNamesForInstances, releaseMedia } from '../services/message-media.js'

export default async function historyRoutes(app: FastifyInstance): Promise<void> {
  // Get paginated message history for an instance
  app.get('/instances/:id/history', async (request) => {
    const { id } = request.params as { id: string }
    const query = request.query as { limit?: string; before?: string }
    const limit = clampLimit(query.limit, 50, 200) // a negative LIMIT is unlimited in SQLite
    const before = query.before ? parseInt(query.before, 10) : undefined

    let sql = 'SELECT * FROM messages WHERE instance_id = ?'
    const params: unknown[] = [id]

    if (before) {
      sql += ' AND created_at < ?'
      params.push(before)
    }

    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]

    const messages: ChatMessage[] = rows.map(r => ({
      id: r.id as string,
      instanceId: r.instance_id as string,
      role: r.role as ChatMessage['role'],
      // Coerced on read too: a row stored before the POST checked shapes must not crash the chat.
      content: (() => {
        const c = safeJsonParse<unknown>(r.content as string, [])
        return (Array.isArray(c) ? c.filter(b => b && typeof b === 'object' && typeof (b as { type?: unknown }).type === 'string') : []) as MessageContentBlock[]
      })(),
      inputTokens: r.input_tokens as number | undefined,
      outputTokens: r.output_tokens as number | undefined,
      costUsd: r.cost_usd as number | undefined,
      createdAt: r.created_at as number
    })).reverse() // Return in chronological order

    return { messages, hasMore: rows.length === limit }
  })

  // Add a message to history
  app.post('/instances/:id/history', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as {
      role: string
      content: MessageContentBlock[]
      inputTokens?: number
      outputTokens?: number
      costUsd?: number
    }

    // A message is a list of content blocks. Anything else is stored forever and renders as a
    // crash on every open of this chat, so it is refused here.
    const validRoles = ['user', 'assistant', 'system']
    if (!body || !Array.isArray(body.content) || body.content.some(b => !b || typeof b !== 'object' || typeof (b as { type?: unknown }).type !== 'string')) {
      return reply.code(400).send({ error: 'content must be a list of blocks, each with a type' })
    }
    if (typeof body.role !== 'string' || !validRoles.includes(body.role)) {
      return reply.code(400).send({ error: `role must be one of ${validRoles.join(', ')}` })
    }
    if (!db.prepare('SELECT id FROM instances WHERE id = ?').get(id)) {
      return reply.code(404).send({ error: 'Chat not found' })
    }

    const msgId = crypto.randomUUID()
    const now = Date.now()

    const contentStr = JSON.stringify(body.content)
    const MAX_CONTENT_BYTES = 50 * 1024
    const finalContent = Buffer.byteLength(contentStr) > MAX_CONTENT_BYTES
      ? JSON.stringify([{ type: 'text', text: '[Output truncated — exceeded 50KB storage limit]' }])
      : contentStr

    db.prepare(`
      INSERT INTO messages (id, instance_id, role, content, input_tokens, output_tokens, cost_usd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msgId, id, body.role,
      finalContent,
      body.inputTokens ?? null,
      body.outputTokens ?? null,
      body.costUsd ?? null,
      now
    )

    broadcastEvent({ type: 'message:created', payload: { instanceId: id, messageId: msgId } })
    reply.code(201)
    return { id: msgId, createdAt: now }
  })

  // Clear all messages for an instance
  app.delete('/instances/:id/history', async (request) => {
    const { id } = request.params as { id: string }
    const media = mediaNamesForInstances([id])
    db.prepare('DELETE FROM messages WHERE instance_id = ?').run(id)
    releaseMedia(media) // cleared history takes its stored screenshots with it
    broadcastEvent({ type: 'history:cleared', payload: { instanceId: id } })
    return { ok: true }
  })
}

function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback
  try {
    return JSON.parse(str) as T
  } catch {
    return fallback
  }
}
