import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import type { SkillConfig } from '@orcstrator/shared'
import { scanSkills, type ProjectRoot } from '../services/skill-scanner.js'

export default async function skillRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every skill on disk. Registered BEFORE nothing in particular, but note it must stay
   * distinct from `/skills` itself: that one returns the (empty, in-app) skills table,
   * which has never had anything to do with Claude's skills.
   */
  app.get('/skills/available', async () => {
    const projects = db.prepare(
      "SELECT path, COALESCE(NULLIF(display_name, ''), name) AS name FROM folders WHERE path IS NOT NULL"
    ).all() as ProjectRoot[]
    return scanSkills(projects)
  })

  // List all skills
  app.get('/skills', async () => {
    const rows = db.prepare('SELECT * FROM skills ORDER BY created_at DESC').all() as Record<string, unknown>[]
    return rows.map(rowToSkill)
  })

  // The create and delete endpoints for this in-app table were removed. Nothing
  // in the app ever called them; the only reader left is the list above, which the chat
  // header still asks for.
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
