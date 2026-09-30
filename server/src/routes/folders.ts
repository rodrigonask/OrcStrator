import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { FolderConfig, PermissionRuleSet } from '@orcstrator/shared'
import { dedupeRules, survivesAutoMode } from '@orcstrator/shared'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { processRegistry } from '../services/process-registry.js'
import { abortShutdown, isShuttingDown } from '../services/turn-gate.js'

const NOT_STOPPED = 'A chat in this project is still working and could not be stopped, so nothing was changed. Try again, or open that chat and use Force reset in its \u2630 menu.'
const chatIdsIn = (folderId: string) => (db.prepare('SELECT id FROM instances WHERE folder_id = ?').all(folderId) as { id: string }[]).map(r => r.id)
const allChatIds = () => (db.prepare('SELECT id FROM instances').all() as { id: string }[]).map(r => r.id)
/** Runs `<sqlPrefix> (?, ?, ...)` over `ids`; nothing when the list is empty. */
function updateByIds(sqlPrefix: string, ids: string[]): void {
  if (ids.length === 0) return
  db.prepare(`${sqlPrefix} (${ids.map(() => '?').join(',')})`).run(...ids)
}
import { canonicalizeCwd } from '../services/canonical-path.js'
import { isNetworkOrDevicePath } from '../services/safe-path.js'
import { clearAwaitingInput } from '../services/awaiting-input.js'
import { parsePermissionRules } from '../services/permission-rule-sets.js'
import { folderRuleChain, readFolderRules, writeFolderRules } from '../services/folder-rules.js'
import { mediaNamesForInstances, releaseMedia } from '../services/message-media.js'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'

function rowToFolder(r: Record<string, unknown>): FolderConfig {
  return {
    id: r.id as string,
    path: r.path as string,
    name: r.name as string,
    displayName: r.display_name as string | undefined,
    emoji: r.emoji as string | undefined,
    client: r.client as string | undefined,
    projectType: r.project_type as FolderConfig['projectType'],
    color: r.color as string | undefined,
    status: (r.status as FolderConfig['status']) || 'active',
    repoUrl: r.repo_url as string | undefined,
    notes: r.notes as string | undefined,
    expanded: Boolean(r.expanded),
    sortOrder: r.sort_order as number,
    createdAt: r.created_at as number,
    stealthMode: Boolean(r.stealth_mode),
    lastSyncedAt: r.last_synced_at as number | undefined,
    hidden: Boolean(r.hidden),
    permissionRules: parsePermissionRules(r.permission_rules),
  }
}

/**
 * A project folder path, cleaned up, or an error for the 400.
 *
 * Absolute, not a bare drive or filesystem root, no `\\?\` device prefix, surrounding spaces
 * and trailing slashes dropped, and on-disk casing applied. Two spellings of one folder
 * (`C:\x` and `C:\x\`, or `C:/x`) used to become two projects.
 */
function cleanFolderPath(input: unknown): { path: string } | { error: string } {
  if (typeof input !== 'string' || !input.trim()) return { error: 'path is required and must be an absolute folder path' }
  let raw = input.trim()
  // Device and NT prefixes (\\?\, \\.\, \??\) reach the same folder by another name.
  if (/^[\\/]{2}[?.][\\/]|^[\\/]\?\?[\\/]/.test(raw)) return { error: 'path must be an ordinary folder path' }
  // A network share is refused outright, before any file call. A chat started
  // there loads that share's settings and hooks, and even checking it exists sends the
  // user's login hash to the host.
  if (isNetworkOrDevicePath(raw)) return { error: 'path must be a folder on this computer, not a network share' }
  if (process.platform === 'win32') {
    // Git Bash spelling from an agent: /c/code/app is C:\code\app, not a folder called "c".
    const gitBash = /^\/([a-zA-Z])(\/.*)?$/.exec(raw)
    if (gitBash) raw = `${gitBash[1].toUpperCase()}:${(gitBash[2] ?? '/').replace(/\//g, '\\')}`
    // No drive letter and not a network share: relative to whatever drive is current.
    if (/^[\\/](?![\\/])/.test(raw)) return { error: 'path must include a drive letter, for example C:\\code\\app' }
    // A colon after the drive is an NTFS stream (folder::$INDEX_ALLOCATION), not a folder name.
    // A network share's host can carry colons of its own (\\[::1]\C$), so shares are exempt.
    if (!/^[\\/]{2}/.test(raw) && raw.slice(2).includes(':')) return { error: 'path must be an ordinary folder path' }
  }
  if (!path.isAbsolute(raw)) return { error: 'path is required and must be an absolute folder path' }
  let p = path.normalize(raw)
  if (process.platform === 'win32') {
    // Windows ignores trailing dots and spaces on a name, so "app." is "app". Strip them so the
    // duplicate check sees one folder.
    p = p.split('\\').map((seg, i) => (i === 0 ? seg : seg.replace(/[. ]+$/, ''))).join('\\')
  }
  const root = path.parse(p).root
  if (p === root || p.replace(/[\\/]+$/, '') === root.replace(/[\\/]+$/, '')) return { error: 'path cannot be the root of a drive' }
  p = p.replace(/[\\/]+$/, '')
  // The folder must exist. Safe to ask now: network paths were refused above.
  try {
    if (!fs.statSync(p).isDirectory()) return { error: 'path must be a folder, not a file' }
  } catch {
    return { error: 'That folder does not exist on this computer' }
  }
  return { path: canonicalizeCwd(p) }
}

/** Host names that mean "this computer" in a \\host\C$ admin share. */
function localHostNames(): Set<string> {
  const h = os.hostname().toLowerCase()
  return new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0--1.ipv6-literal.net', h, `${h}.`, 'localhost.'])
}

/**
 * The real, on-disk form of a path that may not exist yet: the longest existing ancestor through
 * realpath (which turns an 8.3 short name into the long one), plus the parts that do not exist.
 * Remote shares are left as spelled: resolving an offline one can block for seconds.
 */
function resolveThroughExisting(p: string): string {
  if (/^[\\/]{2}/.test(p)) return p
  let head = p
  const tail: string[] = []
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync.native(head)
      return tail.length ? path.join(real, ...tail) : real
    } catch {
      const parent = path.dirname(head)
      if (parent === head) return p
      tail.unshift(path.basename(head))
      head = parent
    }
  }
  return p
}

/**
 * The same folder, however it is spelled: a Git Bash `/c/...` spelling (legacy
 * rows were stored that way), an admin share of this computer (`\\localhost\C$\x` is `C:\x`),
 * an 8.3 short name, and a folder that does not exist yet under any of those. Windows compares
 * without case; POSIX does not.
 */
function folderKey(p: string): string {
  let x = p
  if (process.platform === 'win32') {
    const gitBash = /^[\\/]([a-zA-Z])([\\/].*)?$/.exec(x)
    if (gitBash) x = `${gitBash[1]}:${gitBash[2] ?? '\\'}`
    const share = /^[\\/]{2}([^\\/]+)[\\/]([a-zA-Z])\$([\\/].*)?$/.exec(x)
    if (share && localHostNames().has(share[1].toLowerCase())) x = `${share[2]}:${share[3] ?? '\\'}`
  }
  const real = resolveThroughExisting(x)
  const n = real.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? n.toLowerCase() : n
}

/** The project that already owns this folder, spelled any way, or undefined. */
function folderOwning(p: string, exceptId?: string): { id: string; hidden: number } | undefined {
  const want = folderKey(p)
  const rows = db.prepare('SELECT id, path, hidden FROM folders').all() as Array<{ id: string; path: string | null; hidden: number }>
  return rows.find(r => r.id !== exceptId && r.path != null && folderKey(r.path) === want)
}

const FOLDER_TEXT_FIELDS = ['name', 'displayName', 'emoji', 'client', 'projectType', 'color', 'status', 'repoUrl', 'notes'] as const

/** Counts for the delete confirmation, or null when the project does not exist. */
function deleteSummary(id: string): { id: string; name: string; cards: number; routines: number; comments: number; chats: number; messages: number } | null {
  const folder = db.prepare('SELECT id, name, display_name FROM folders WHERE id = ?').get(id) as
    | { id: string; name: string | null; display_name: string | null }
    | undefined
  if (!folder) return null
  const count = (sql: string) => (db.prepare(sql).get(id) as { n: number }).n
  return {
    id,
    name: folder.display_name || folder.name || '',
    cards: count("SELECT COUNT(*) AS n FROM pipeline_tasks WHERE project_id = ? AND (schedule_kind IS NULL OR schedule_kind = '')"),
    routines: count("SELECT COUNT(*) AS n FROM pipeline_tasks WHERE project_id = ? AND schedule_kind IS NOT NULL AND schedule_kind != ''"),
    comments: count('SELECT COUNT(*) AS n FROM task_comments WHERE task_id IN (SELECT id FROM pipeline_tasks WHERE project_id = ?)'),
    chats: count('SELECT COUNT(*) AS n FROM instances WHERE folder_id = ?'),
    messages: count('SELECT COUNT(*) AS n FROM messages WHERE instance_id IN (SELECT id FROM instances WHERE folder_id = ?)'),
  }
}

export default async function folderRoutes(app: FastifyInstance): Promise<void> {
  /**
   * PROJECT permission rules: the middle scope behind "Allow always".
   *
   * Read returns two things, because the modal has to show both and the difference matters: `own`
   * is what THIS folder grants and is the only part that can be removed from here, and `chain` is
   * every folder from the outermost one down, so a chat in a sub-folder can see where an inherited
   * grant actually lives instead of wondering why it has a rule nobody set on it.
   */
  app.get('/folders/:id/permission-rules', async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = db.prepare('SELECT id FROM folders WHERE id = ?').get(id)
    if (!row) return reply.code(404).send({ error: 'Folder not found' })
    return { own: readFolderRules(id) ?? null, chain: folderRuleChain(id) }
  })

  /**
   * Add or remove project allow rules.
   *
   * A PATCH that appends and subtracts rather than a PUT that replaces, for the same reason the
   * app-wide route works that way: a tab that loaded an hour ago would otherwise wipe every rule
   * saved since, and a project's rules are exactly the kind a second chat adds to while the first
   * one's tab sits open.
   *
   * `add` refuses any rule auto mode drops. Saving one of those is the loop this whole feature was
   * built to end: the rule is stored, the CLI throws it away at spawn, the retry is refused again,
   * and the operator clicks Allow always a second time for nothing. The buttons never offer such a
   * rule; this is the backstop for anything else that calls the route.
   */
  app.patch('/folders/:id/permission-rules', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { add?: unknown; remove?: unknown } | undefined
    const row = db.prepare('SELECT id FROM folders WHERE id = ?').get(id)
    if (!row) return reply.code(404).send({ error: 'Folder not found' })

    const add = Array.isArray(body?.add) ? dedupeRules(body.add) : []
    const remove = Array.isArray(body?.remove) ? dedupeRules(body.remove) : []
    if (add.length === 0 && remove.length === 0) {
      reply.code(400)
      return { ok: false, error: 'Nothing to add or remove' }
    }
    const refused = add.filter(rule => !survivesAutoMode(rule))
    if (refused.length > 0) {
      reply.code(422)
      return { ok: false, error: 'auto-mode-would-drop', refused }
    }

    const current: PermissionRuleSet = readFolderRules(id) ?? {}
    const allow = dedupeRules([...(current.allow ?? []), ...add]).filter(rule => !remove.includes(rule))
    const next = writeFolderRules(id, { ...current, allow })
    return { ok: true, permissionRules: next ?? null }
  })

  // Create folder
  app.post('/folders', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    // A project without a real path is not a project, and a NULL path used to crash the
    // sidebar sort on every load. Refuse it here, with a message a script can act on.
    const cleaned = cleanFolderPath(body.path)
    if ('error' in cleaned) return reply.code(400).send({ error: cleaned.error })
    const owner = folderOwning(cleaned.path)
    if (owner) return reply.code(409).send({ error: 'A project for this folder already exists', id: owner.id, hidden: !!owner.hidden })
    for (const key of FOLDER_TEXT_FIELDS) {
      if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') {
        return reply.code(400).send({ error: `${key} must be text` })
      }
    }
    if (body.sortOrder !== undefined && typeof body.sortOrder !== 'number') {
      return reply.code(400).send({ error: 'sortOrder must be a number' })
    }
    const id = crypto.randomUUID()
    const now = Date.now()

    db.prepare(`
      INSERT INTO folders (id, path, name, display_name, emoji, client, project_type, color, status, repo_url, notes, expanded, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      cleaned.path,
      body.name as string || '',
      body.displayName as string || null,
      body.emoji as string || null,
      body.client as string || null,
      body.projectType as string || 'other',
      body.color as string || null,
      body.status as string || 'active',
      body.repoUrl as string || null,
      body.notes as string || null,
      body.expanded !== undefined ? (body.expanded ? 1 : 0) : 1,
      body.sortOrder as number ?? 0,
      now
    )

    const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Record<string, unknown>
    const folder = rowToFolder(row)
    broadcastEvent({ type: 'folder:created', payload: folder })
    reply.code(201)
    return folder
  })

  // Update folder
  app.put('/folders/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = { ...((request.body ?? {}) as Record<string, unknown>) }
    if (!db.prepare('SELECT id FROM folders WHERE id = ?').get(id)) return reply.code(404).send({ error: 'Folder not found' })
    if (body.path !== undefined) {
      const cleaned = cleanFolderPath(body.path)
      if ('error' in cleaned) return reply.code(400).send({ error: cleaned.error })
      if (folderOwning(cleaned.path, id)) return reply.code(409).send({ error: 'Another project already uses this folder' })
      body.path = cleaned.path
    }
    for (const key of FOLDER_TEXT_FIELDS) {
      if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') {
        return reply.code(400).send({ error: `${key} must be text` })
      }
    }
    if (body.sortOrder !== undefined && (typeof body.sortOrder !== 'number' || !Number.isFinite(body.sortOrder))) {
      return reply.code(400).send({ error: 'sortOrder must be a number' })
    }

    const sets: string[] = []
    const params: unknown[] = []

    const fieldMap: Record<string, string> = {
      path: 'path', name: 'name', displayName: 'display_name',
      emoji: 'emoji', client: 'client', projectType: 'project_type',
      color: 'color', status: 'status', repoUrl: 'repo_url',
      notes: 'notes', expanded: 'expanded', sortOrder: 'sort_order',
      stealthMode: 'stealth_mode'
    }

    const boolFields = new Set(['expanded', 'stealthMode'])
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (body[jsKey] !== undefined) {
        sets.push(`${dbKey} = ?`)
        params.push(boolFields.has(jsKey) ? (body[jsKey] ? 1 : 0) : body[jsKey])
      }
    }

    if (sets.length === 0) return { ok: true }

    params.push(id)
    db.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).run(...params)

    const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Record<string, unknown>
    const folder = rowToFolder(row)
    broadcastEvent({ type: 'folder:updated', payload: folder })
    return folder
  })

  // Hide and unhide. These flip ONE column and touch nothing else: no card, routine,
  // comment, chat or process is affected, and a hidden project's routines keep firing.
  // "Hide Project" used to call the delete route below; it must never reach it.
  const setHidden = (hidden: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const res = db.prepare('UPDATE folders SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id)
    if (res.changes === 0) return reply.code(404).send({ error: 'Folder not found' })
    const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Record<string, unknown>
    const folder = rowToFolder(row)
    broadcastEvent({ type: 'folder:updated', payload: folder })
    return folder
  }
  app.post('/folders/:id/hide', setHidden(true))
  app.post('/folders/:id/unhide', setHidden(false))

  /** What a delete would remove, so the confirmation can name it before anything is lost. */
  app.get('/folders/:id/delete-summary', async (request, reply) => {
    const { id } = request.params as { id: string }
    const summary = deleteSummary(id)
    if (!summary) return reply.code(404).send({ error: 'Folder not found' })
    return summary
  })

  // Delete folder, permanently. Separate from hide on purpose, and it refuses to run unless
  // the caller repeats the project id in `?confirm=`: a bare DELETE (a stray script, an old
  // client build still wired to the Hide button) gets a 400 and deletes nothing.
  app.delete('/folders/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { confirm } = (request.query ?? {}) as { confirm?: string }
    const summary = deleteSummary(id)
    if (!summary) return reply.code(404).send({ error: 'Folder not found' })
    if (confirm !== id) {
      return reply.code(400).send({
        error: 'Deleting a project is permanent. Repeat the project id in ?confirm= to go ahead.',
        wouldDelete: summary,
      })
    }

    // Stop the project's chats first, so nothing keeps running with no tab to stop it. A chat that
    // will not stop blocks the delete: deleting its row would leave a live agent with no chat.
    const { ids: instanceIds, failed } = await processRegistry.stopAll(() => chatIdsIn(id))
    if (failed.length) return reply.code(409).send({ error: NOT_STOPPED })

    const media = mediaNamesForInstances(instanceIds)
    const deleteTx = db.transaction(() => {
      const taskIds = 'SELECT id FROM pipeline_tasks WHERE project_id = ?'
      db.prepare(`DELETE FROM task_runs WHERE task_id IN (${taskIds})`).run(id)
      db.prepare(`DELETE FROM task_comments WHERE task_id IN (${taskIds})`).run(id)
      db.prepare('DELETE FROM pipeline_tasks WHERE project_id = ?').run(id)
      // Messages and wake-ups go with their chat (ON DELETE CASCADE).
      db.prepare('DELETE FROM instances WHERE folder_id = ?').run(id)
      db.prepare('DELETE FROM folders WHERE id = ?').run(id)
    })
    deleteTx()
    releaseMedia(media) // the project's chats' stored screenshots go with them
    for (const iid of instanceIds) {
      clearAwaitingInput(iid)
      broadcastEvent({ type: 'instance:deleted', payload: { id: iid } })
    }
    broadcastEvent({ type: 'folder:deleted', payload: { id } })
    return { ok: true, deleted: summary }
  })

  // Reorder folders
  app.put('/folders/reorder', async (request, reply) => {
    const { ids } = (request.body ?? {}) as { ids: string[] }
    // A list of ids, or a 400 (no body used to be a raw 500).
    if (!Array.isArray(ids) || ids.some(x => typeof x !== 'string')) return reply.code(400).send({ error: 'ids must be a list of ids' })
    const stmt = db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?')
    const transaction = db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        stmt.run(i, ids[i])
      }
    })
    transaction()
    broadcastEvent({ type: 'folders:reordered', payload: { ids } })
    return { ok: true }
  })

  // Open folder in OS file explorer
  app.post('/folders/:id/open', async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = db.prepare('SELECT path FROM folders WHERE id = ?').get(id) as { path: string } | undefined
    if (!row) return reply.code(404).send({ error: 'Folder not found' })

    const folderPath = row.path
    const platform = process.platform

    // Never through a shell. PowerShell also treats the typographic quotes
    // U+2018 to U+201B as quote marks, so a folder named with one broke out of the old
    // escaped string and ran whatever followed. explorer.exe takes the path as one argv
    // entry, the same as /fs/open; a network path is refused before any of it.
    if (isNetworkOrDevicePath(folderPath)) return reply.code(400).send({ error: 'This project is on a network path, which OrcStrator will not open.' })
    if (platform === 'win32') {
      const child = spawn('explorer.exe', [folderPath], { windowsHide: true, detached: true, stdio: 'ignore' })
      child.on('error', () => { /* no file manager */ })
      child.unref()
    } else {
      const bin = platform === 'darwin' ? 'open' : 'xdg-open'
      spawn(bin, [folderPath], { detached: true, stdio: 'ignore', shell: false }).unref()
    }

    return { ok: true, path: folderPath }
  })

  // Pause all running instances in a folder
  app.post('/folders/:id/pause-all', async (request) => {
    const { id: folderId } = request.params as { id: string }
    // By the list that was stopped, never by folder: a chat that would not stop keeps its state,
    // and one opened after the stop is not touched.
    const { ids, failed } = await processRegistry.stopAll(() => chatIdsIn(folderId))
    const stopped = ids.filter(i => !failed.includes(i))
    updateByIds("UPDATE instances SET state = 'idle' WHERE id IN", stopped)
    for (const iid of stopped) clearAwaitingInput(iid)

    for (const iid of stopped) {
      broadcastEvent({ type: 'instance:updated', payload: { id: iid, state: 'idle' } })
    }

    return { paused: stopped.length, notStopped: failed }
  })

  // Release all sessions in a folder (clears session IDs)
  app.post('/folders/:id/release-all', async (request) => {
    const { id: folderId } = request.params as { id: string }
    const { ids, failed } = await processRegistry.stopAll(() => chatIdsIn(folderId))
    const instanceIds = ids.filter(i => !failed.includes(i))
    updateByIds("UPDATE instances SET state = 'idle', session_id = NULL WHERE id IN", instanceIds)
    for (const iid of instanceIds) clearAwaitingInput(iid)

    for (const iid of instanceIds) {
      broadcastEvent({ type: 'instance:updated', payload: { id: iid, state: 'idle', sessionId: null } })
    }

    return { released: instanceIds.length, instanceIds, notStopped: failed }
  })

  // Close All — kill all processes and delete all instances in the folder
  app.post('/folders/:id/close-all', async (request, reply) => {
    const { id: folderId } = request.params as { id: string }
    const { ids: instanceIds, failed } = await processRegistry.stopAll(() => chatIdsIn(folderId))
    if (failed.length) return reply.code(409).send({ error: NOT_STOPPED })

    const media = mediaNamesForInstances(instanceIds)
    updateByIds('DELETE FROM instances WHERE id IN', instanceIds)
    releaseMedia(media)

    for (const id of instanceIds) {
      broadcastEvent({ type: 'instance:deleted', payload: { id } })
    }

    return { closed: instanceIds.length, instanceIds }
  })

  // Renew — kill all processes, clear sessions, release locked tasks, warm up fresh sessions
  app.post('/folders/:id/renew', async (request, reply) => {
    const { id: folderId } = request.params as { id: string }
    // No body is a legal call (a script, an agent). It used to throw halfway through, after
    // the chats were deleted and before any were recreated.
    const body = (request.body ?? {}) as { newNames?: unknown }
    if (body.newNames !== undefined && (!Array.isArray(body.newNames) || body.newNames.some(n => typeof n !== 'string'))) {
      return reply.code(400).send({ error: 'newNames must be a list of names' })
    }
    const newNames = (body.newNames ?? []) as string[]
    // 1. Kill all running processes. If one survives, stop here: deleting its chat would leave a
    // live agent with no chat to stop it from (the orphan the kill order exists to prevent).
    const { failed } = await processRegistry.stopAll(() => chatIdsIn(folderId))
    if (failed.length) {
      return reply.code(409).send({ error: 'A chat in this project could not be stopped, so nothing was renewed. Try again, or use Force Reset on that chat.' })
    }
    // Read after the stop, which also stopped any chat opened while it ran.
    const instances = db.prepare('SELECT * FROM instances WHERE folder_id = ? ORDER BY sort_order ASC').all(folderId) as Record<string, unknown>[]

    const oldInstanceIds = instances.map(i => i.id as string)

    // 2-4 in ONE transaction: clear the old chats' history, delete them, and create the fresh
    // ones. Either all of it happens or none of it does, so a failure can never leave the
    // project with its chats gone and nothing in their place.
    const now = Date.now()
    const newInstances: Record<string, unknown>[] = []
    const renewMedia = mediaNamesForInstances(oldInstanceIds)
    const renewTx = db.transaction(() => {
      if (oldInstanceIds.length > 0) {
        const ph = oldInstanceIds.map(() => '?').join(',')
        db.prepare(`DELETE FROM messages WHERE instance_id IN (${ph})`).run(...oldInstanceIds)
      }
      db.prepare('DELETE FROM instances WHERE folder_id = ?').run(folderId)
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i]
        const newId = crypto.randomUUID()
        const newName = newNames[i]?.trim() || (inst.name as string)
        db.prepare(`
          INSERT INTO instances (id, folder_id, name, cwd, session_id, state, process_state, agent_id, idle_restart_minutes, sort_order, created_at)
          VALUES (?, ?, ?, ?, NULL, 'idle', 'idle', ?, ?, ?, ?)
        `).run(
          newId, folderId, newName, inst.cwd as string,
          (inst.agent_id as string) ?? null,
          (inst.idle_restart_minutes as number) ?? 0,
          (inst.sort_order as number) ?? i,
          now + i
        )
        newInstances.push(db.prepare('SELECT * FROM instances WHERE id = ?').get(newId) as Record<string, unknown>)
      }
    })
    renewTx()
    releaseMedia(renewMedia) // renew clears history, and the stored screenshots with it

    return { renewed: instances.length, oldInstanceIds, newInstances }
  })

  // Global shutdown — kill every running session across all folders
  app.post('/shutdown', async () => {
    const { ids, failed } = await processRegistry.stopAll(() => allChatIds())
    const instanceIds = ids.filter(i => !failed.includes(i))

    // Sessions are gone, so no question survives this. Only for the chats that were stopped: one
    // that would not stop keeps its state, and one opened after this ran is not touched.
    updateByIds("UPDATE instances SET state = 'idle', session_id = NULL WHERE id IN", instanceIds)
    // Unlike /terminate, shutdown leaves the SERVER AND THE CLIENT ALIVE, so a silent bulk
    // clear would leave amber chips on screen for questions the DB says are gone. Clear it
    // per instance so each one broadcasts.
    for (const iid of instanceIds) clearAwaitingInput(iid)

    for (const iid of instanceIds) {
      broadcastEvent({ type: 'instance:updated', payload: { id: iid, state: 'idle', sessionId: null } })
    }

    return { killed: instanceIds.length, instanceIds, notStopped: failed }
  })

  // Terminate — kill everything then shut down the server process
  app.post('/terminate', async () => {
    // The server is going away: every start being set up gives up, none may begin, then every
    // chat is stopped. The flag is lifted again only if something below throws, since the server
    // then stays up and must accept starts.
    let instanceIds: string[]
    const startedHere = !isShuttingDown()
    try {
      await processRegistry.shutdownAgents()
      // Not appClosing: this also wipes every session below, so a wake-up kept for the next start
      // would fire into an empty conversation. Every chat is stopped as by the user (its pending
      // wake-ups cancelled); only a plain restart (SIGINT, dev reload) keeps them.
      const { ids, failed } = await processRegistry.stopAll(() => allChatIds())
      instanceIds = ids.filter(i => !failed.includes(i))
      // Sessions are gone, so no question survives this. One statement, not a per-instance
      // broadcast loop: the client is going away anyway.
      updateByIds("UPDATE instances SET state = 'idle', session_id = NULL, awaiting_input = NULL, awaiting_input_at = NULL WHERE id IN", instanceIds)
    } catch (err) {
      if (startedHere) abortShutdown()
      throw err
    }

    for (const iid of instanceIds) {
      broadcastEvent({ type: 'instance:updated', payload: { id: iid, state: 'idle', sessionId: null } })
    }

    // Exit after response is sent
    setTimeout(() => process.exit(0), 500)

    return { ok: true, killed: instanceIds.length, instanceIds }
  })
}
