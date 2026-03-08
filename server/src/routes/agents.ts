import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import type { AgentConfig } from '@orcstrator/shared'
import { buildInterviewPrompt } from '../services/agent-interview-prompt.js'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
      INSERT INTO agents (id, name, content, level, skills, mcp_servers, personality, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.name || 'New Agent',
      body.content || '',
      body.level ?? 0,
      JSON.stringify(body.skills || []),
      JSON.stringify(body.mcpServers || []),
      body.personality ? JSON.stringify(body.personality) : null,
      body.source || 'user',
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
    if (body.personality !== undefined) { sets.push('personality = ?'); params.push(body.personality ? JSON.stringify(body.personality) : null) }

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

  // Sync native agents from server/agents/*.md
  app.post('/agents/sync-native', async () => {
    const agentsDir = path.resolve(__dirname, '../../agents')
    if (!fs.existsSync(agentsDir)) return { synced: 0 }

    const entries = fs.readdirSync(agentsDir, { withFileTypes: true })
    let synced = 0

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const filePath = path.join(agentsDir, entry.name)
      const content = fs.readFileSync(filePath, 'utf-8')
      const name = entry.name.replace(/-master\.md$/, '').replace(/\.md$/, '')
      const displayName = name.charAt(0).toUpperCase() + name.slice(1)

      // Upsert by name + source=native
      const existing = db.prepare("SELECT id FROM agents WHERE name = ? AND source = 'native'").get(displayName) as { id: string } | undefined
      if (existing) {
        db.prepare("UPDATE agents SET content = ? WHERE id = ?").run(content, existing.id)
      } else {
        const id = crypto.randomUUID()
        db.prepare(`
          INSERT INTO agents (id, name, content, level, skills, mcp_servers, source, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'native', ?)
        `).run(id, displayName, content, 1, '[]', '[]', Date.now())
      }
      synced++
    }

    const rows = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as Record<string, unknown>[]
    broadcastEvent({ type: 'agents:synced', payload: rows.map(rowToAgent) })
    return { synced, agents: rows.map(rowToAgent) }
  })

  // Edit session — create a Claude instance with interview prompt
  app.post('/agents/:id/edit-session', async (request) => {
    const { id } = request.params as { id: string }
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) throw { statusCode: 404, message: 'Agent not found' }

    const agent = rowToAgent(row)
    const prompt = buildInterviewPrompt(agent)

    // Find a folder to attach the instance to (use first available)
    const folder = db.prepare('SELECT id, path FROM folders ORDER BY sort_order ASC LIMIT 1').get() as { id: string; path: string } | undefined
    if (!folder) throw { statusCode: 400, message: 'No project folders available. Add a project first.' }

    const instanceId = crypto.randomUUID()
    const now = Date.now()

    db.prepare(`
      INSERT INTO instances (id, folder_id, name, cwd, state, agent_id, sort_order, created_at)
      VALUES (?, ?, ?, ?, 'idle', ?, 0, ?)
    `).run(instanceId, folder.id, `Edit: ${agent.name}`, folder.path, id, now)

    // Import sendMessage to fire the interview prompt
    const { sendMessage } = await import('../services/claude-process.js')
    await sendMessage({ instanceId, text: prompt, cwd: folder.path })

    broadcastEvent({ type: 'instance:created', payload: { id: instanceId, folderId: folder.id, name: `Edit: ${agent.name}`, cwd: folder.path, state: 'running', agentId: id, sortOrder: 0, createdAt: now, idleRestartMinutes: 0 } })

    return { instanceId }
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
    personality: safeJsonParse(row.personality as string, null),
    source: (row.source as 'user' | 'native') || 'user',
    createdAt: row.created_at as number
  }
}

function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback
  try { return JSON.parse(str) as T } catch { return fallback }
}
