import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import type { SkillConfig } from '@orcstrator/shared'
import crypto from 'crypto'

export default async function skillRoutes(app: FastifyInstance): Promise<void> {
  // List all skills
  app.get('/skills', async () => {
    const rows = db.prepare('SELECT * FROM skills ORDER BY created_at DESC').all() as Record<string, unknown>[]
    return rows.map(rowToSkill)
  })

  // Create skill
  app.post('/skills', async (request, reply) => {
    const body = request.body as Partial<SkillConfig>
    const id = crypto.randomUUID()
    const now = Date.now()

    db.prepare(`
      INSERT INTO skills (id, name, description, content, tags, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.name || 'New Skill',
      body.description || '',
      body.content || '',
      JSON.stringify(body.tags || []),
      now
    )

    const skill = rowToSkill(db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Record<string, unknown>)
    broadcastEvent({ type: 'skill:created', payload: skill })
    reply.code(201)
    return skill
  })

  // Delete skill
  app.delete('/skills/:id', async (request) => {
    const { id } = request.params as { id: string }
    db.prepare('DELETE FROM skills WHERE id = ?').run(id)
    broadcastEvent({ type: 'skill:deleted', payload: { id } })
    return { ok: true }
  })
}

function rowToSkill(row: Record<string, unknown>): SkillConfig {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    content: (row.content as string) || '',
    tags: safeJsonParse(row.tags as string, []),
    createdAt: row.created_at as number
  }
}

function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback
  try { return JSON.parse(str) as T } catch { return fallback }
}
