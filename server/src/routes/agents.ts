import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import type { AgentConfig } from '@nasklaude/shared'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

export default async function agentRoutes(app: FastifyInstance): Promise<void> {
  // List all agents
  app.get('/agents', async () => {
    const rows = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as Record<string, unknown>[]
    return rows.map(rowToAgent)
  })

  // Create agent
  app.post('/agents', async (request, reply) => {
    const body = request.body as Partial<AgentConfig>
    const id = crypto.randomUUID()
    const now = Date.now()

    db.prepare(`
      INSERT INTO agents (id, name, content, level, skills, mcp_servers, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.name || 'New Agent',
      body.content || '',
      body.level ?? 0,
      JSON.stringify(body.skills || []),
      JSON.stringify(body.mcpServers || []),
      now
    )

    const agent = rowToAgent(db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>)
    broadcastEvent({ type: 'agent:created', payload: agent })
    reply.code(201)
    return agent
  })

  // Get single agent
  app.get('/agents/:id', async (request) => {
    const { id } = request.params as { id: string }
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) throw { statusCode: 404, message: 'Agent not found' }
    return rowToAgent(row)
  })

  // Update agent
  app.put('/agents/:id', async (request) => {
    const { id } = request.params as { id: string }
    const body = request.body as Partial<AgentConfig>

    const sets: string[] = []
    const params: unknown[] = []

    if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name) }
    if (body.content !== undefined) { sets.push('content = ?'); params.push(body.content) }
    if (body.level !== undefined) { sets.push('level = ?'); params.push(body.level) }
    if (body.skills !== undefined) { sets.push('skills = ?'); params.push(JSON.stringify(body.skills)) }
    if (body.mcpServers !== undefined) { sets.push('mcp_servers = ?'); params.push(JSON.stringify(body.mcpServers)) }

    if (sets.length === 0) return { ok: true }

    params.push(id)
    db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...params)

    const agent = rowToAgent(db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>)
    broadcastEvent({ type: 'agent:updated', payload: agent })
    return agent
  })

  // Delete agent
  app.delete('/agents/:id', async (request) => {
    const { id } = request.params as { id: string }
    db.prepare('DELETE FROM agents WHERE id = ?').run(id)
    // Clear agent_id from instances using this agent
    db.prepare('UPDATE instances SET agent_id = NULL WHERE agent_id = ?').run(id)
    broadcastEvent({ type: 'agent:deleted', payload: { id } })
    return { ok: true }
  })

  // Scan for agent markdown files in a directory
  app.post('/agents/scan', async (request) => {
    const { directory } = request.body as { directory: string }
    if (!directory) {
      return { agents: [] }
    }

    // Validate directory is under an allowed root
    const resolved = path.resolve(directory)
    const allowedRoots = [
      path.resolve(os.homedir()),
      path.resolve(os.tmpdir()),
    ]
    try {
      const folderRows = db.prepare('SELECT path FROM folders').all() as Array<{ path: string }>
      for (const r of folderRows) {
        allowedRoots.push(path.resolve(r.path))
      }
    } catch {
      // DB may not have 'folders' table yet
    }

    const isAllowed = allowedRoots.some(root => {
      const rel = path.relative(root, resolved)
      return !rel.startsWith('..') && !path.isAbsolute(rel)
    })

    if (!isAllowed) {
      throw { statusCode: 403, message: 'Directory not in allowed paths' }
    }

    if (!fs.existsSync(resolved)) {
      return { agents: [] }
    }

    const found: Array<{ name: string; path: string; content: string }> = []

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const filePath = path.join(resolved, entry.name)
          const content = fs.readFileSync(filePath, 'utf-8')
          found.push({
            name: entry.name.replace(/\.md$/, ''),
            path: filePath,
            content
          })
        }
      }
    } catch {
      // ignore scan errors
    }

    return { agents: found }
  })
}

function rowToAgent(row: Record<string, unknown>): AgentConfig {
  return {
    id: row.id as string,
    name: row.name as string,
    content: row.content as string,
    level: row.level as number,
    skills: safeJsonParse(row.skills as string, []),
    mcpServers: safeJsonParse(row.mcp_servers as string, []),
    createdAt: row.created_at as number
  }
}

function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback
  try { return JSON.parse(str) as T } catch { return fallback }
}
