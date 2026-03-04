import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import crypto from 'crypto'
import type { ChatMessage, MessageContentBlock } from '@nasklaude/shared'

export default async function historyRoutes(app: FastifyInstance): Promise<void> {
  // Get paginated message history for an instance
  app.get('/instances/:id/history', async (request) => {
    const { id } = request.params as { id: string }
    const query = request.query as { limit?: string; before?: string }
    const limit = Math.min(parseInt(query.limit || '50', 10), 200)
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
      content: safeJsonParse<MessageContentBlock[]>(r.content as string, []),
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
    const body = request.body as {
      role: string
      content: MessageContentBlock[]
      inputTokens?: number
      outputTokens?: number
      costUsd?: number
    }

    const msgId = crypto.randomUUID()
    const now = Date.now()

    db.prepare(`
      INSERT INTO messages (id, instance_id, role, content, input_tokens, output_tokens, cost_usd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msgId, id, body.role,
      JSON.stringify(body.content),
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
    db.prepare('DELETE FROM messages WHERE instance_id = ?').run(id)
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
