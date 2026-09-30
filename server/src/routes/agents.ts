import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import type { AgentConfig } from '@orcstrator/shared'
import { buildInterviewPrompt } from '../services/agent-interview-prompt.js'
import crypto from 'crypto'

export default async function agentRoutes(app: FastifyInstance): Promise<void> {
  // List all agents
  app.get('/agents', async () => {
    const rows = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as Record<string, unknown>[]
    return rows.map(rowToAgent)
  })

  // Create agent
  app.post('/agents', async (request, reply) => {
    const body = (request.body ?? {}) as Partial<AgentConfig>
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
    const body = (request.body ?? {}) as Partial<AgentConfig>

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

  // Edit session: create a Claude instance with interview prompt
  app.post('/agents/:id/edit-session', async (request) => {
    const { id } = request.params as { id: string }
    // The UI says 'user'; anything that does not is treated as an agent and surfaces.
    const body = (request.body || {}) as { startedBy?: unknown }
    const startedBy = body.startedBy === 'user' ? 'user' : 'agent'
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
    // Surfaces only when something other than the UI asked for it: the UI opens the chat
    // it just created, an HTTP caller leaves it running off-screen.
    await sendMessage({ instanceId, text: prompt, cwd: folder.path, origin: 'agent-edit', startedBy })

    broadcastEvent({ type: 'instance:created', payload: { id: instanceId, folderId: folder.id, name: `Edit: ${agent.name}`, cwd: folder.path, state: 'running', agentId: id, sortOrder: 0, createdAt: now, idleRestartMinutes: 0 } })

    return { instanceId }
  })

  // Two dead endpoints were removed from here. /agents/sync-native read
  // server/agents/*.md, a folder that went away with the orchestration layer, yet
  // the Agents page still called it on every open. /agents/scan returned every .md file, with
  // its contents, from any single folder under the home folder, and nothing in the app ever
  // called it with a folder to scan.
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
