import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import readline from 'readline'
import crypto from 'crypto'
import type { SessionFile } from '@orcstrator/shared'

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects')

/** Walk directories up to maxDepth, collecting .jsonl files */
function collectJsonlFiles(dir: string, depth: number, maxDepth: number): string[] {
  const results: string[] = []
  if (depth > maxDepth) return results
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectJsonlFiles(full, depth + 1, maxDepth))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(full)
    }
  }
  return results
}

/** Parse a JSONL file to extract token/cost summary. Reads only first+last few lines for speed. */
async function parseSessionFile(filePath: string): Promise<{ inputTokens: number; outputTokens: number; costUsd: number; lineCount: number }> {
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  let lineCount = 0

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of rl) {
    lineCount++
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      // result events carry token info
      if (obj.type === 'result' || obj.costUsd != null) {
        if (obj.inputTokens) inputTokens += obj.inputTokens
        if (obj.outputTokens) outputTokens += obj.outputTokens
        if (obj.costUsd) costUsd += obj.costUsd
      }
    } catch { /* skip malformed lines */ }
  }

  return { inputTokens, outputTokens, costUsd, lineCount }
}

export default async function sessionsRoutes(app: FastifyInstance): Promise<void> {
  // List session files
  app.get('/sessions', async () => {
    if (!fs.existsSync(CLAUDE_DIR)) {
      return { sessions: [] }
    }

    const files = collectJsonlFiles(CLAUDE_DIR, 0, 3)

    // Look up known instances/folders for enrichment
    const instances = db.prepare('SELECT id, name, session_id, folder_id FROM instances').all() as Array<{
      id: string; name: string; session_id: string | null; folder_id: string
    }>
    const folders = db.prepare('SELECT id, name, display_name, emoji FROM folders').all() as Array<{
      id: string; name: string; display_name: string | null; emoji: string | null
    }>

    const sessionMap = new Map<string, { instanceId: string; instanceName: string; folderId: string }>()
    for (const inst of instances) {
      if (inst.session_id) {
        sessionMap.set(inst.session_id, { instanceId: inst.id, instanceName: inst.name, folderId: inst.folder_id })
      }
    }

    const folderMap = new Map<string, { name: string; emoji: string | null }>()
    for (const f of folders) {
      folderMap.set(f.id, { name: f.display_name || f.name, emoji: f.emoji })
    }

    // Stat all files in parallel (async) — avoids blocking the event loop with 1000+ statSync calls
    const statResults = await Promise.all(
      files.map(async (filePath) => {
        try {
          const stat = await fsp.stat(filePath)
          return { filePath, sessionId: path.basename(filePath, '.jsonl'), mtime: stat.mtimeMs }
        } catch { return null }
      })
    )

    // Build session list without expensive per-file content parsing.
    // Stats are loaded on demand via GET /sessions/:sessionId/stats.
    const sessions: SessionFile[] = []
    for (const entry of statResults) {
      if (!entry) continue
      const match = sessionMap.get(entry.sessionId)
      const folder = match ? folderMap.get(match.folderId) : undefined
      sessions.push({
        sessionId: entry.sessionId,
        instanceId: match?.instanceId,
        instanceName: match?.instanceName,
        folderId: match?.folderId,
        folderName: folder?.name,
        folderEmoji: folder?.emoji ?? undefined,
        mtime: entry.mtime,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        lineCount: 0,
      })
    }

    // Sort by mtime descending (newest first)
    sessions.sort((a, b) => b.mtime - a.mtime)

    return { sessions }
  })

  // Get detailed stats for a single session file
  app.get('/sessions/:sessionId/stats', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }

    // Find the file
    if (!fs.existsSync(CLAUDE_DIR)) {
      reply.code(404)
      return { error: 'Session directory not found' }
    }

    const files = collectJsonlFiles(CLAUDE_DIR, 0, 3)
    const match = files.find(f => path.basename(f, '.jsonl') === sessionId)
    if (!match) {
      reply.code(404)
      return { error: 'Session file not found' }
    }

    const stats = await parseSessionFile(match)
    return stats
  })

  // Request summary via idle agent
  app.post('/sessions/:sessionId/request-summary', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const body = request.body as { instanceId: string }

    if (!body.instanceId) {
      reply.code(400)
      return { error: 'instanceId is required' }
    }

    // Verify instance is idle
    const inst = db.prepare('SELECT id, state, process_state FROM instances WHERE id = ?').get(body.instanceId) as {
      id: string; state: string; process_state: string
    } | undefined

    if (!inst) {
      reply.code(404)
      return { error: 'Instance not found' }
    }

    if (inst.state !== 'idle' || (inst.process_state && inst.process_state !== 'idle')) {
      reply.code(409)
      return { error: 'Instance is not idle' }
    }

    // Find the session file
    if (!fs.existsSync(CLAUDE_DIR)) {
      reply.code(404)
      return { error: 'Session directory not found' }
    }

    const files = collectJsonlFiles(CLAUDE_DIR, 0, 3)
    const filePath = files.find(f => path.basename(f, '.jsonl') === sessionId)
    if (!filePath) {
      reply.code(404)
      return { error: 'Session file not found' }
    }

    // Send the summary request via the instance's send endpoint
    const { sendMessage } = await import('../services/claude-process.js')
    const prompt = `Please read and summarize the session log file at: ${filePath}\n\nProvide a concise summary of what was done, key decisions made, and any pending work.`

    const instRow = db.prepare('SELECT cwd, session_id FROM instances WHERE id = ?').get(body.instanceId) as {
      cwd: string; session_id: string | null
    } | undefined

    if (!instRow?.cwd) {
      reply.code(500)
      return { error: 'Instance has no cwd' }
    }

    // Insert a user message into history
    const msgId = crypto.randomUUID()
    const now = Date.now()
    db.prepare(
      'INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(msgId, body.instanceId, 'user', JSON.stringify([{ type: 'text', text: prompt }]), now)

    try {
      await sendMessage({
        instanceId: body.instanceId,
        text: prompt,
        cwd: instRow.cwd,
        sessionId: instRow.session_id ?? undefined,
        flags: [],
      })
    } catch (err) {
      reply.code(500)
      return { error: 'Failed to spawn summary process' }
    }

    return { ok: true, instanceId: body.instanceId, sessionId }
  })
}
