import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import fs from 'fs'
import readline from 'readline'
import crypto from 'crypto'
import type { SessionFile } from '@orcstrator/shared'
import { getSessionIndex, findSessionEntry, readSessionCwd, type SessionEntry } from '../services/session-index.js'
import { findFolderForCwd, importSessionTail } from '../services/session-adopt.js'
import { canonicalizeCwd } from '../services/canonical-path.js'
import { cwdToSlug } from '../services/session-sanitizer.js'
import { prettySlug } from '../services/pretty-slug.js'
import { broadcastEvent } from '../ws/handler.js'
import { rowToInstance } from './instances.js'

/** Page size when the client does not ask for one. The full list is 6,000+ rows. */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

interface SessionStats { inputTokens: number; outputTokens: number; costUsd: number; lineCount: number }

/** The rootFolder setting (JSON-encoded in the settings table), or '' when unset or unreadable. */
function readRootFolder(): string {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('rootFolder') as { value: string } | undefined
    const value: unknown = row ? JSON.parse(row.value) : ''
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/** Stats are pure functions of the file, so cache them against its size+mtime. */
const statsCache = new Map<string, { size: number; mtime: number; stats: SessionStats }>()

/**
 * Aggregate token/cost totals for one transcript.
 *
 * Streamed a line at a time, and only lines that could carry usage are handed to
 * JSON.parse — the big files here run past 300 MB, where parsing every line was the
 * whole cost of this endpoint.
 */
async function parseSessionFile(filePath: string): Promise<SessionStats> {
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  let lineCount = 0

  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of rl) {
    lineCount++
    if (!line.includes('"usage"') && !line.includes('costUSD') && !line.includes('costUsd')) continue
    try {
      const obj = JSON.parse(line) as Record<string, any>
      // Where the CLI actually records spend: assistant turns carry message.usage in the
      // API's own field names. The old code read obj.inputTokens/obj.costUsd, which no
      // entry in a Claude Code transcript has — every session reported 0 in / 0 out.
      const usage = obj?.message?.usage
      if (usage) {
        inputTokens += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
        outputTokens += usage.output_tokens || 0
      }
      const cost = obj.costUSD ?? obj.costUsd
      if (typeof cost === 'number') costUsd += cost
    } catch { /* skip malformed lines */ }
  }

  return { inputTokens, outputTokens, costUsd, lineCount }
}

export default async function sessionsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Distinct projects, for the filter dropdown. Counts exclude sub-agent runs unless
   * asked for, so the number next to a project matches what the list will show.
   */
  app.get('/sessions/projects', async (request) => {
    const query = request.query as { subagents?: string }
    const includeSubagents = query.subagents === '1'
    const entries = await getSessionIndex()

    const folders = db.prepare('SELECT name, display_name, emoji, path FROM folders WHERE path IS NOT NULL').all() as Array<{
      name: string; display_name: string | null; emoji: string | null; path: string
    }>
    // Slug is how the CLI encodes a cwd, so a folder's own slug is the exact key to match.
    const bySlug = new Map(folders.map(f => [cwdToSlug(f.path), f]))
    const rootFolder = readRootFolder()

    const counts = new Map<string, number>()
    for (const entry of entries) {
      if (entry.isSubagent && !includeSubagents) continue
      counts.set(entry.projectSlug, (counts.get(entry.projectSlug) ?? 0) + 1)
    }

    const projects = [...counts.entries()].map(([slug, count]) => {
      const folder = bySlug.get(slug)
      return {
        slug,
        label: folder ? (folder.display_name || folder.name) : prettySlug(slug, rootFolder),
        emoji: folder?.emoji ?? undefined,
        known: Boolean(folder),
        count,
      }
    })
    // Known projects first (the ones with a name), then by volume.
    projects.sort((a, b) => Number(b.known) - Number(a.known) || b.count - a.count)
    return { projects }
  })

  // List session files (paginated — the client must never render all of them at once)
  app.get('/sessions', async (request) => {
    const query = request.query as {
      limit?: string; offset?: string; q?: string
      subagents?: string; project?: string; linked?: string; days?: string; sort?: string
    }
    const limit = Math.min(Math.max(parseInt(query.limit || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)
    const offset = Math.max(parseInt(query.offset || '0', 10) || 0, 0)
    const search = (query.q || '').trim().toLowerCase()
    // Sub-agent transcripts are noise in this list by default: roughly one file in nine,
    // none of them something you opened yourself.
    const includeSubagents = query.subagents === '1'
    const project = (query.project || '').trim()
    const linked = query.linked === 'chat' || query.linked === 'orphan' ? query.linked : null
    const days = Math.max(parseInt(query.days || '0', 10) || 0, 0)
    const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0
    const sort = ['recent', 'oldest', 'largest', 'smallest'].includes(query.sort || '') ? query.sort! : 'recent'

    const entries = await getSessionIndex()

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

    // Build the enriched row for one entry. Stats stay at zero: they cost a full file read
    // and are loaded on demand via GET /sessions/:sessionId/stats.
    const toSessionFile = (entry: SessionEntry): SessionFile => {
      const match = sessionMap.get(entry.sessionId)
      const folder = match ? folderMap.get(match.folderId) : undefined
      return {
        sessionId: entry.sessionId,
        instanceId: match?.instanceId,
        instanceName: match?.instanceName,
        folderId: match?.folderId,
        folderName: folder?.name,
        folderEmoji: folder?.emoji ?? undefined,
        mtime: entry.mtime,
        sizeBytes: entry.size,
        project: entry.projectSlug,
        isSubagent: entry.isSubagent || undefined,
        parentSessionId: entry.parentSessionId,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        lineCount: 0,
      }
    }

    // Every filter runs against the cached index, so a filtered page costs no more disk
    // work than an unfiltered one.
    const matched: SessionFile[] = []
    for (const entry of entries) {
      if (entry.isSubagent && !includeSubagents) continue
      if (project && entry.projectSlug !== project) continue
      if (cutoff && entry.mtime < cutoff) continue
      const row = toSessionFile(entry)
      if (linked === 'chat' && !row.instanceId) continue
      if (linked === 'orphan' && row.instanceId) continue
      if (search) {
        const hay = `${row.sessionId} ${row.instanceName ?? ''} ${row.folderName ?? ''} ${row.project ?? ''}`.toLowerCase()
        if (!hay.includes(search)) continue
      }
      matched.push(row)
    }

    // The index arrives newest-first, so only the other three orders need a sort.
    if (sort === 'oldest') matched.reverse()
    else if (sort === 'largest') matched.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))
    else if (sort === 'smallest') matched.sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))

    const rows = matched.slice(offset, offset + limit)
    return { sessions: rows, total: matched.length, offset, limit, hasMore: offset + rows.length < matched.length }
  })

  // Get detailed stats for a single session file
  app.get('/sessions/:sessionId/stats', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }

    const entry = await findSessionEntry(sessionId)
    if (!entry) {
      reply.code(404)
      return { error: 'Session file not found' }
    }

    const cached = statsCache.get(sessionId)
    if (cached && cached.size === entry.size && cached.mtime === entry.mtime) return cached.stats

    const stats = await parseSessionFile(entry.filePath)
    statsCache.set(sessionId, { size: entry.size, mtime: entry.mtime, stats })
    return stats
  })

  /**
   * Resume a session file: give it a chat to live in.
   *
   * Binding the session id to an instance is all it takes — every send already spawns
   * `claude --resume <session_id>` in the instance's cwd. A brand new chat also gets the
   * tail of the transcript imported so the pane is not blank.
   */
  app.post('/sessions/:sessionId/resume', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }

    const entry = await findSessionEntry(sessionId)
    if (!entry) {
      reply.code(404)
      return { error: 'Session file not found' }
    }

    // Already open somewhere — hand back that chat rather than making a second one
    // pointed at the same session (two chats resuming one session id corrupt each other).
    const existing = db.prepare('SELECT id FROM instances WHERE session_id = ?').get(sessionId) as { id: string } | undefined
    if (existing) return { instanceId: existing.id, created: false, imported: 0 }

    // A sub-agent transcript is a side channel of its parent run, not a session the CLI
    // can --resume. Binding one to a chat would produce a tab that dies on first send.
    if (entry.isSubagent) {
      reply.code(422)
      return { error: 'Sub-agent runs cannot be resumed — open the session that spawned it instead.', parentSessionId: entry.parentSessionId }
    }

    const rawCwd = await readSessionCwd(entry.filePath)
    if (!rawCwd) {
      reply.code(422)
      return { error: 'Could not work out which folder this session ran in' }
    }
    const sessionCwd = canonicalizeCwd(rawCwd)

    const folder = findFolderForCwd(sessionCwd)
    if (!folder) {
      reply.code(409)
      return { error: `No project covers ${sessionCwd}. Add it as a project first.`, cwd: sessionCwd }
    }

    // Sessions that ran in a since-removed worktree still have their transcript; bind them
    // to the project root instead of a directory that is gone. The send path relocates the
    // JSONL into the new cwd's slug on first resume (healSessionLocation), so it survives.
    const cwd = fs.existsSync(sessionCwd) ? sessionCwd : canonicalizeCwd(folder.path)
    const relocated = cwd !== sessionCwd
    if (!fs.existsSync(cwd)) {
      reply.code(422)
      return { error: `The folder this session ran in no longer exists: ${sessionCwd}` }
    }

    const id = crypto.randomUUID()
    const now = Date.now()
    const nextOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM instances WHERE folder_id = ?')
      .get(folder.id) as { n: number }).n

    db.prepare(`
      INSERT INTO instances (id, folder_id, name, cwd, session_id, state, idle_restart_minutes, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, 'idle', 0, ?, ?)
    `).run(id, folder.id, `Resumed ${sessionId.slice(0, 8)}`, cwd, sessionId, nextOrder, now)

    const { title, imported } = await importSessionTail(entry.filePath, id)
    if (title) {
      db.prepare('UPDATE instances SET name = ? WHERE id = ?').run(title.slice(0, 60), id)
    }

    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown>
    const instance = rowToInstance(row)
    broadcastEvent({ type: 'instance:created', payload: instance })

    return { instanceId: id, created: true, imported, cwd, relocated }
  })

  // Request summary via idle agent
  app.post('/sessions/:sessionId/request-summary', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const body = request.body as { instanceId: string; startedBy?: unknown }
    // The UI says 'user'; anything that does not is treated as an agent and surfaces.
    const startedBy = body?.startedBy === 'user' ? 'user' : 'agent'

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

    const entry = await findSessionEntry(sessionId)
    if (!entry) {
      reply.code(404)
      return { error: 'Session file not found' }
    }

    // Send the summary request via the instance's send endpoint
    const { sendMessage } = await import('../services/claude-process.js')
    const prompt = `Please read and summarize the session log file at: ${entry.filePath}\n\nProvide a concise summary of what was done, key decisions made, and any pending work.`

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
        // Same rule as the agent edit session: quiet from the UI, surfaced over HTTP.
        origin: 'summary',
        startedBy,
      })
    } catch (err) {
      reply.code(500)
      return { error: 'Failed to spawn summary process' }
    }

    return { ok: true, instanceId: body.instanceId, sessionId }
  })
}
