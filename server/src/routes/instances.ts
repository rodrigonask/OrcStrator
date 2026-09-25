import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { sendMessage, respondToToolUse, compactInstance, queueBtwNote, takePendingBtwNotes } from '../services/claude-process.js'
import { processRegistry } from '../services/process-registry.js'
import { preprocessImages, detectMediaType } from '../services/image-processor.js'
import { getLastAssistantMessage } from '../services/session-sync.js'
import { dispatchCommand, isValidCommand, getAllCommands } from '../services/command-registry.js'
import { sanitizeSurrogates, clearDeadWorktreeState } from '../services/session-sanitizer.js'
import { scrubSessionSecrets } from '../services/secret-scrubber.js'
import { cancelWakeup, getPendingForInstance } from '../services/wakeup-scheduler.js'
import { releaseLocksForInstance, setIgnoreWindow, getCloseGitStatus, getInstanceDirtyCount } from '../services/file-locks.js'
import { autoNameInstance } from '../services/instance-namer.js'
import { captureForSummary, shouldSummarize, summarizeInBackground } from '../services/session-summarizer.js'
import { applyCloseStatus } from '../services/task-runner.js'
import { scanWorktreeOrphans } from '../services/worktree-orphans.js'
import * as taskManager from '../services/task-manager.js'
import { canonicalizeCwd } from '../services/canonical-path.js'
import { clearAwaitingInput } from '../services/awaiting-input.js'
import { ackSurface, setSurfaceSilent } from '../services/surface.js'
import { resolveModelId, dedupeRules, isPermissionUpdate, DEFAULT_MODEL_ID, DEFAULT_EFFORT } from '@orcstrator/shared'
import { resolvePermissionRequest, isPermissionRequestPending } from '../services/pending-permissions.js'
import { spendAskOnceFor } from '../services/ask-once.js'
import { normalisePermissionRules, parsePermissionRules } from '../services/permission-rule-sets.js'
import crypto from 'crypto'

export default async function instanceRoutes(app: FastifyInstance): Promise<void> {
  // Create instance
  app.post('/instances', async (request, reply) => {
    const body = request.body as Record<string, unknown>
    const id = crypto.randomUUID()
    const now = Date.now()

    db.prepare(`
      INSERT INTO instances (id, folder_id, name, cwd, session_id, state, agent_id, idle_restart_minutes, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.folderId as string,
      body.name as string || 'Instance',
      canonicalizeCwd(body.cwd as string || ''),
      null,
      'idle',
      body.agentId as string || null,
      body.idleRestartMinutes as number ?? 0,
      body.sortOrder as number ?? 0,
      now
    )

    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown>
    const instance = rowToInstance(row)
    broadcastEvent({ type: 'instance:created', payload: instance })
    reply.code(201)
    return instance
  })

  // Update instance
  app.put('/instances/:id', async (request) => {
    const { id } = request.params as { id: string }
    const body = request.body as Record<string, unknown>

    const sets: string[] = []
    const params: unknown[] = []

    const fieldMap: Record<string, string> = {
      name: 'name', cwd: 'cwd', sessionId: 'session_id',
      state: 'state', agentId: 'agent_id',
      idleRestartMinutes: 'idle_restart_minutes', sortOrder: 'sort_order',
      // Per-chat Claude CLI overrides. Send '' (or null) to go back to inheriting
      // the app-wide setting: the spawn treats blank as "not overridden".
      outputStyle: 'output_style', language: 'language',
    }

    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (body[jsKey] !== undefined) {
        sets.push(`${dbKey} = ?`)
        params.push(body[jsKey])
      }
    }

    // permissionRules is a JSON blob, so it cannot ride the plain field map above. It is
    // normalised rather than stored as sent: the spawn path reads this at process start,
    // where a malformed value would cost the chat its rules silently, and the CLI drops a
    // whole settings block that fails to parse. An all-empty set stores NULL, which is how
    // a chat goes back to inheriting without a separate "clear" call.
    if (body.permissionRules !== undefined) {
      sets.push('permission_rules = ?')
      params.push(normalisePermissionRules(body.permissionRules))
    }

    if (sets.length === 0) return { ok: true }

    params.push(id)
    db.prepare(`UPDATE instances SET ${sets.join(', ')} WHERE id = ?`).run(...params)

    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown>
    const instance = rowToInstance(row)
    // This is the only route that changes permission_rules, and the client copies the field
    // only when the key is present. JSON.stringify drops an undefined key, so a chat cleared
    // back to NULL would broadcast with no key at all and every other tab would keep the old
    // rules. Send null instead: the client's `?? undefined` turns it back into "none".
    broadcastEvent({ type: 'instance:updated', payload: { ...instance, permissionRules: instance.permissionRules ?? null } })

    return instance
  })

  // Delete instance
  app.delete('/instances/:id', async (request) => {
    const { id } = request.params as { id: string }
    await processRegistry.killProcess(id)
    db.prepare('DELETE FROM instances WHERE id = ?').run(id)
    releaseLocksForInstance(id)
    broadcastEvent({ type: 'instance:deleted', payload: { id } })
    return { ok: true }
  })

  // Secure close - same as deleting an instance, but first permanently scrubs any
  // API keys / passwords from the on-disk transcript .jsonl (the DB rows get
  // cascade-deleted, so only the file needs cleaning). The close always proceeds,
  // even if the scrub hits an error - a close must always close.
  app.post('/instances/:id/secure-close', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { taskStatus?: 'done' | 'inbox' }
    const inst = db.prepare('SELECT cwd, session_id FROM instances WHERE id = ?')
      .get(id) as { cwd: string; session_id: string | null } | undefined
    if (!inst) { reply.code(404); return { error: 'Not found' } }

    // ORDER MATTERS AND IS NOT AN IMPLEMENTATION DETAIL.
    //
    // Everything below the DELETE is gone: `messages` is ON DELETE CASCADE from
    // `instances`, and the scrub rewrites the on-disk session file. So:
    //   1. capture the transcript tail and the native task list, while they still exist
    //   2. write the task status, synchronously and durably
    //   3. only then scrub, kill, delete, broadcast, and return so the tab closes at once
    //   4. summarize in the background off the in-memory copy
    // Step 2 before step 3 is what makes a failed summary unable to lose a status.
    const captured = captureForSummary(id)

    if (body.taskStatus && captured?.taskId) {
      applyCloseStatus(captured.taskId, body.taskStatus)
    }

    const scrub = await scrubSessionSecrets(inst.cwd, inst.session_id)

    await processRegistry.killProcess(id)
    db.prepare('DELETE FROM instances WHERE id = ?').run(id)
    releaseLocksForInstance(id)
    broadcastEvent({ type: 'instance:deleted', payload: { id } })

    // Fire-and-forget: the response below is already on its way out.
    const summarizing = shouldSummarize(captured)
    if (summarizing && captured) void summarizeInBackground(captured)

    return { ...scrub, summarizing, taskId: captured?.taskId ?? null }
  })

  // The pipeline task this instance is linked to, if any. The close dialog asks for it
  // before it can decide whether to demand a status. Mirrors captureForSummary's
  // resolution: active_task_id is cleared the moment a turn completes, but
  // pipeline_tasks.instance_id survives, so a finished task still resolves.
  app.get('/instances/:id/task', async (request, reply) => {
    const { id } = request.params as { id: string }
    const inst = db.prepare('SELECT active_task_id FROM instances WHERE id = ?').get(id) as
      | { active_task_id: string | null } | undefined
    if (!inst) { reply.code(404); return { error: 'Not found' } }
    let taskId = inst.active_task_id
    if (!taskId) {
      const row = db.prepare('SELECT id FROM pipeline_tasks WHERE instance_id = ? ORDER BY updated_at DESC LIMIT 1')
        .get(id) as { id: string } | undefined
      taskId = row?.id ?? null
    }
    return { task: taskId ? taskManager.getTask(taskId) ?? null : null }
  })

  // Lift file-lock conflict enforcement for 30 minutes (danger button)
  app.post('/conflicts/ignore', async () => {
    return { ignoreUntil: setIgnoreWindow() }
  })

  // Uncommitted-work scan for an instance's working tree - drives the close guard.
  // Includes untracked files (a brand-new uncommitted file is real work to orphan) and
  // splits "yours" (files this instance holds edit-locks on) from "others" in the
  // shared working tree, so the warning never blames this session for a sibling's edits.
  app.get('/instances/:id/git-status', async (request, reply) => {
    const { id } = request.params as { id: string }
    const inst = db.prepare('SELECT cwd FROM instances WHERE id = ?').get(id) as { cwd: string } | undefined
    if (!inst) { reply.code(404); return { error: 'Not found' } }
    return getCloseGitStatus(inst.cwd, id)
  })

  // Worktree orphan scan, the FIRST thing the close flow asks. Reads this session's own
  // transcript for the worktrees it created and never removed, so it holds even when the
  // agent has forgotten or the session died mid-run. See services/worktree-orphans.ts.
  app.get('/instances/:id/worktree-orphans', async (request, reply) => {
    const { id } = request.params as { id: string }
    const inst = db.prepare('SELECT cwd, session_id FROM instances WHERE id = ?').get(id) as
      | { cwd: string; session_id: string | null } | undefined
    if (!inst) { reply.code(404); return { error: 'Not found' } }
    return scanWorktreeOrphans(inst.cwd, inst.session_id)
  })

  // Compact an idle session's context on demand - offer-only lever for the cold-start /
  // quota features. Shrinks the next turn's prompt so a cold restart re-reads less.
  app.post('/instances/:id/compact', async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await compactInstance(id)
    if (!result.ok) {
      reply.code(result.error === 'not-found' ? 404 : 409)
      return result
    }
    return result
  })

  // Toggle keep-warm for a session (the 🔥 chip). When on, the cache advisor fires a
  // minimal keep-alive turn before the prompt cache expires so it never goes cold.
  app.post('/instances/:id/keep-warm', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { enabled?: unknown }
    const enabled = body?.enabled === true || body?.enabled === 1
    const row = db.prepare('SELECT id FROM instances WHERE id = ?').get(id) as { id: string } | undefined
    if (!row) { reply.code(404); return { error: 'Not found' } }
    db.prepare('UPDATE instances SET keep_warm = ? WHERE id = ?').run(enabled ? 1 : 0, id)
    broadcastEvent({ type: 'instance:updated', payload: { id, keepWarm: enabled } })
    return { ok: true, keepWarm: enabled }
  })

  // The chat surfaced by a scheduled fire has been looked at: drop the bright status. The
  // client calls this when the tile is focused or the chat is selected. Idempotent, and a
  // 404 is deliberately not raised for an unknown id: this fires on every focus and a chat
  // that was just closed is not an error worth a console line.
  app.post('/instances/:id/surface-ack', async (request) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { surfacedAt?: unknown }
    const at = typeof body.surfacedAt === 'number' && Number.isFinite(body.surfacedAt) ? body.surfacedAt : undefined
    const cleared = ackSurface(id, at)
    return { ok: true, cleared }
  })

  // Send message to instance
  app.post('/instances/:id/send', async (request) => {
    const { id } = request.params as { id: string }
    const body = request.body as { text: string; images?: string[]; flags?: string[] }

    const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!instance) {
      throw { statusCode: 404, message: 'Instance not found' }
    }

    // Guard: reject if already running to prevent duplicate spawns from rapid clicks
    if (processRegistry.isTracked(id)) {
      throw { statusCode: 409, message: 'Instance already running' }
    }

    // A message typed by hand ends any silent chain: the chat is the user's again, so a wake-up
    // the user's own turn schedules must surface. Without this a silent routine that once fired
    // on a chat would mute every later wake-up in it, for good.
    setSurfaceSilent(id, false)

    // First user message? (checked before this one is inserted) - drives AI session naming.
    const priorUserMessages = (db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE instance_id = ? AND role = 'user'"
    ).get(id) as { c: number }).c
    const isFirstUserMessage = priorUserMessages === 0

    // Load settings for global flags
    const flagRows = db.prepare("SELECT value FROM settings WHERE key = 'globalFlags'").get() as { value: string } | undefined
    let globalFlags: string[] = flagRows ? JSON.parse(flagRows.value) : []

    // If the message-level flags include a permission mode, strip any conflicting
    // permission flags from globalFlags so the message-level flag wins
    const bodyFlags = body.flags || []
    if (bodyFlags.some(f => f.startsWith('--permission-mode'))) {
      globalFlags = globalFlags.filter(f =>
        !f.startsWith('--permission-mode') && f !== '--dangerously-skip-permissions'
      )
    }

    // Inject --model and --effort unless this turn already named one. An unset
    // setting means the app default (DEFAULT_MODEL_ID / DEFAULT_EFFORT), not "say
    // nothing and let the CLI decide".
    const defaultModelRow = db.prepare("SELECT value FROM settings WHERE key = 'defaultModel'").get() as { value: string } | undefined
    // A stored JSON null (written by a server older than the null-deletes PUT) is unset too.
    const unsetIfNull = (v: string | undefined) => (v === 'null' ? '' : v)
    const defaultModel = unsetIfNull(defaultModelRow?.value)?.replace(/^"|"$/g, '') || 'default'
    const allFlags = [...globalFlags, ...bodyFlags]
    if (!allFlags.some(f => f.startsWith('--model'))) {
      globalFlags.push(`--model=${defaultModel !== 'default' ? resolveModelId(defaultModel) : DEFAULT_MODEL_ID}`)
    }
    const defaultEffortRow = db.prepare("SELECT value FROM settings WHERE key = 'defaultEffort'").get() as { value: string } | undefined
    const defaultEffort = unsetIfNull(defaultEffortRow?.value)?.replace(/^"|"$/g, '') || ''
    if (!allFlags.some(f => f.startsWith('--effort'))) {
      globalFlags.push(`--effort=${defaultEffort || DEFAULT_EFFORT}`)
    }

    // Load agent prompt if assigned
    let agentPrompt: string | undefined
    if (instance.agent_id) {
      const agent = db.prepare('SELECT content FROM agents WHERE id = ?').get(instance.agent_id) as { content: string } | undefined
      if (agent?.content) {
        agentPrompt = agent.content
      }
    }

    // Stealth mode: prepend no-memory instruction if folder has stealth_mode enabled
    const folderRow = db.prepare('SELECT stealth_mode FROM folders WHERE id = (SELECT folder_id FROM instances WHERE id = ?)').get(id) as { stealth_mode: number } | undefined
    if (folderRow?.stealth_mode) {
      const stealthNote = 'STEALTH MODE: Do not use the Memory tool. Do not create or update any CLAUDE.md memory files. Do not persist any context between conversations.'
      agentPrompt = agentPrompt ? `${stealthNote}\n\n${agentPrompt}` : stealthNote
    }

    // Detect media types and preprocess images (compress, tile, stitch as needed)
    let processedImages: Array<{ base64: string; mediaType: string }> | undefined
    let imageTextPrefix = ''
    if (body.images && body.images.length > 0) {
      const rawImages = body.images.map(b64 => ({ base64: b64, mediaType: detectMediaType(b64) }))
      const preprocessed = await preprocessImages(rawImages)
      processedImages = preprocessed.images
      imageTextPrefix = preprocessed.textPrefix
    }

    // Save user message to DB (original images for display)
    const msgId = crypto.randomUUID()
    const now = Date.now()
    const content: Array<Record<string, unknown>> = []
    if (body.text) content.push({ type: 'text', text: body.text })
    if (body.images) {
      for (const img of body.images) {
        content.push({ type: 'image', base64: img, mediaType: detectMediaType(img) })
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: '' })

    db.prepare(`
      INSERT INTO messages (id, instance_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(msgId, id, 'user', JSON.stringify(content), now)

    const result = await sendMessage({
      instanceId: id,
      text: (imageTextPrefix + body.text) || (processedImages?.length ? '[Attached image(s)]' : body.text),
      images: processedImages,
      cwd: instance.cwd as string,
      sessionId: instance.session_id as string | undefined,
      flags: [...globalFlags, ...(body.flags || [])],
      agentPrompt,
      origin: 'user',
    })

    // AI session naming: on the very first user message, name the chat from it via a
    // cheap Haiku call. Fire-and-forget - runs alongside the turn, never blocks the send,
    // and silently no-ops unless AI naming is enabled with an API key set.
    // A slash command can now be the first message (e.g. "/goal <the goal>"), so name the
    // chat from the text AFTER the command token - "/goal" itself says nothing about the
    // topic and would drag Haiku toward titles like "Goal Setting Command".
    if (isFirstUserMessage && body.text && body.text.trim()) {
      const nameSource = body.text.trim().replace(/^\/[a-z0-9_-]+\s+/i, '') || body.text
      void autoNameInstance(id, nameSource)
    }

    return { sessionId: result.sessionId }
  })

  // Send a CLI slash command - dispatched through the command registry
  // Each command is routed to the appropriate strategy handler (skill, native, client-only, etc.)
  app.post('/instances/:id/command', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { command: rawCommand, flags } = request.body as { command: string; flags?: string[] }
    if (!rawCommand) { reply.code(400); return { error: 'Missing command' } }

    const instance = db.prepare('SELECT session_id, cwd FROM instances WHERE id = ?').get(id) as { session_id: string | null; cwd: string } | undefined
    if (!instance) { reply.code(404); return { error: 'Not found' } }

    // Commands that run as a real turn (/goal, /compact, skills) need the composer's
    // model / effort / permission picks - the server can't see localStorage.
    const ctx = {
      instanceId: id,
      sessionId: instance.session_id,
      cwd: instance.cwd,
      args: '',
      flags: Array.isArray(flags) ? flags.filter(f => typeof f === 'string') : [],
    }

    // Known command â†’ dispatch normally; unknown â†’ fall back to skill pass-through
    const baseCmd = rawCommand.split(/\s/)[0].toLowerCase()
    if (isValidCommand(baseCmd)) {
      return dispatchCommand(rawCommand, ctx)
    }
    return dispatchCommand(rawCommand, ctx, 'skill')
  })

  // List all available commands (for client command palette)
  app.get('/instances/commands', async () => {
    return { commands: getAllCommands() }
  })

  // List pending auto-scheduled wake-ups for an instance (used by client banner on load).
  app.get('/instances/:id/wakeups', async (request) => {
    const { id } = request.params as { id: string }
    return { wakeups: getPendingForInstance(id) }
  })

  // Cancel a specific pending wake-up.
  app.delete('/instances/:id/wakeups/:wakeupId', async (request, reply) => {
    const { wakeupId } = request.params as { id: string; wakeupId: string }
    const ok = cancelWakeup(wakeupId)
    if (!ok) { reply.code(404); return { ok: false, error: 'Wake-up not found or not pending' } }
    return { ok: true }
  })

  // Sanitize unpaired surrogate escapes in session JSONL - recovers from
  // "invalid_request_error: no low surrogate" 400s caused by mid-codepoint paste truncation.
  app.post('/instances/:id/sanitize-surrogates', async (request, reply) => {
    const { id } = request.params as { id: string }
    const instance = db.prepare('SELECT session_id, cwd FROM instances WHERE id = ?').get(id) as { session_id: string | null; cwd: string } | undefined
    if (!instance) { reply.code(404); return { ok: false, error: 'Instance not found' } }
    if (!instance.session_id) { reply.code(400); return { ok: false, error: 'No session yet - send a message first' } }
    return sanitizeSurrogates(instance.cwd, instance.session_id)
  })

  // Unpin a session from an isolation worktree that no longer exists. Without this the tab is
  // permanently dead: every --resume re-enters the removed worktree, the CLI refuses because
  // git resolves it to the parent checkout, and it exits 1 before the turn starts.
  app.post('/instances/:id/repair-worktree', async (request, reply) => {
    const { id } = request.params as { id: string }
    const instance = db.prepare('SELECT session_id, cwd FROM instances WHERE id = ?').get(id) as { session_id: string | null; cwd: string } | undefined
    if (!instance) { reply.code(404); return { ok: false, error: 'Instance not found' } }
    if (!instance.session_id) { reply.code(400); return { ok: false, error: 'No session yet - send a message first' } }
    const result = await clearDeadWorktreeState(instance.cwd, instance.session_id)
    if (result.ok && !result.alreadyClear) {
      console.log(`[worktree-repair] ${id.slice(0, 8)} unpinned from dead worktree ${result.worktreePath} (${result.repairedFiles?.length} session file(s))`)
    }
    return result
  })

  // Write data to a running process's stdin (for responding to CLI prompts like login/permissions)
  app.post('/instances/:id/stdin', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { data } = request.body as { data: string }
    if (typeof data !== 'string') { reply.code(400); return { error: 'Missing data' } }
    if (!processRegistry.isTracked(id)) { reply.code(404); return { error: 'No running process for this instance' } }
    const ok = processRegistry.writeStdin(id, data)
    return { ok }
  })

  // Respond to a can_use_tool permission request over the control protocol
  // (--permission-prompt-tool stdio). Writes a control_response onto the existing
  // stream-json stdin pipe; the blocked turn resumes and the process stays alive.
  // VERIFIED (CLI 2.1.181 probe): the allow branch REQUIRES updatedInput (a record) -
  // the client echoes the original tool input back so the tool runs unchanged.
  //
  // `updatedPermissions` is the banner's "Allow always": an `addRules` update with
  // destination `session`, so the running process stops asking about the same thing this turn.
  // Verified against the real CLI 2.1.272: the CLI logs "Adding 1
  // allow rule(s) to destination 'session'" and the next identical call runs with no request. It does
  // NOT get past an ask rule (asked again), which is why the banner never offers it for a
  // request an ask rule raised. Entries that are not PermissionUpdate-shaped are dropped here.
  app.post('/instances/:id/control-response', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { requestId?: unknown; behavior?: unknown; input?: unknown; updatedPermissions?: unknown; message?: unknown; interrupt?: unknown }
    const requestId = typeof body.requestId === 'string' ? body.requestId : ''
    const behavior = body.behavior === 'allow' ? 'allow' : body.behavior === 'deny' ? 'deny' : null
    if (!requestId || !behavior) { reply.code(400); return { ok: false, error: 'Missing requestId or behavior (allow|deny)' } }
    // The queue is the truth about what can still be answered. A request that is not in it was
    // already answered, withdrawn by the CLI, or belonged to a process that has since gone: writing
    // its id to stdin would either answer twice or hand a stale id to the chat's NEXT process, which
    // reports success while nothing runs.
    if (!isPermissionRequestPending(id, requestId)) {
      reply.code(409); return { ok: false, error: 'request-gone' }
    }
    if (!processRegistry.isTracked(id)) {
      // Nothing can take this answer, so the request is dead: drop it here and in every tab, or the
      // card comes back on every reload.
      if (resolvePermissionRequest(id, requestId)) {
        broadcastEvent({ type: 'permission:resolved', payload: { instanceId: id, requestId } })
      }
      reply.code(409); return { ok: false, error: 'process-not-running' }
    }

    const updatedPermissions = behavior === 'allow' && Array.isArray(body.updatedPermissions)
      ? body.updatedPermissions.filter(isPermissionUpdate)
      : []
    const inner: Record<string, unknown> = behavior === 'allow'
      ? {
          behavior: 'allow',
          updatedInput: (body.input && typeof body.input === 'object') ? body.input : {},
          ...(updatedPermissions.length > 0 ? { updatedPermissions } : {}),
        }
      : { behavior: 'deny', message: (typeof body.message === 'string' && body.message) ? body.message : 'Denied by user', ...(body.interrupt === true ? { interrupt: true } : {}) }

    // Envelope subtype is the control-protocol status ("success"), NOT the allow/deny decision.
    const envelope = { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: inner } }
    const ok = processRegistry.writeStdin(id, JSON.stringify(envelope) + '\n')   // writeStdin writes raw, append \n
    if (!ok) {
      // The pipe is gone or the process is being killed: this request dies with it, so drop it
      // rather than leave a card that can never be answered.
      if (resolvePermissionRequest(id, requestId)) {
        broadcastEvent({ type: 'permission:resolved', payload: { instanceId: id, requestId } })
      }
      reply.code(409); return { ok: false, error: 'process-not-running' }
    }

    // Answered: off the queue a reloaded tab would be shown, off every other open tab, and any
    // one-time question it was raised by is spent (ask-once.ts).
    const answered = resolvePermissionRequest(id, requestId)
    broadcastEvent({ type: 'permission:resolved', payload: { instanceId: id, requestId } })
    if (answered) spendAskOnceFor(id, answered)
    return { ok: true }
  })

  // Answer an AskUserQuestion tool call - writes a tool_result back to stdin.
  // Deliver a follow-up as a NEW user turn through the full /send pipeline.
  // Live-protocol finding (verified against the real CLI): in print mode the CLI
  // auto-fails AskUserQuestion/plan tool calls instantly - there is no waiting
  // tool_result channel. The only working delivery is a fresh resumed turn.
  async function injectUserTurn(id: string, text: string, flags?: string[]): Promise<{ ok: boolean; error?: string }> {
    // The user often answers while the asking turn is still finishing its last
    // tokens - wait briefly for the process to go idle before resuming.
    for (let i = 0; i < 20 && processRegistry.isTracked(id); i++) {
      await new Promise(r => setTimeout(r, 1000))
    }
    const resp = await app.inject({
      method: 'POST',
      url: `/api/instances/${id}/send`,
      payload: { text, flags: flags ?? [] }
    })
    if (resp.statusCode >= 400) {
      return { ok: false, error: `send failed: HTTP ${resp.statusCode} ${resp.body?.slice(0, 120)}` }
    }
    return { ok: true }
  }

  app.post('/instances/:id/answer-question', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { toolUseId?: unknown; answer?: unknown }
    const toolUseId = typeof body?.toolUseId === 'string' ? body.toolUseId : ''
    const answer = typeof body?.answer === 'string' ? body.answer : ''
    if (!toolUseId) { reply.code(400); return { ok: false, error: 'Missing toolUseId' } }
    if (!answer) { reply.code(400); return { ok: false, error: 'Missing answer' } }
    const res = await injectUserTurn(id, answer)
    if (!res.ok) { reply.code(409); return res }
    return { ok: true }
  })

  // "By the way" - a steering note the user can send WHILE a turn is running.
  //   running → queue it; it auto-runs as a fresh follow-up turn the instant the
  //             current turn ends (server-modeled, never dropped - see claude-process).
  //   idle    → just run it now as a normal turn.
  app.post('/instances/:id/btw', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { text?: unknown; flags?: unknown }
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    const flags = Array.isArray(body?.flags) ? (body.flags as unknown[]).filter((f): f is string => typeof f === 'string') : []
    if (!text) { reply.code(400); return { ok: false, error: 'Missing text' } }

    const inst = db.prepare('SELECT id, cwd, session_id FROM instances WHERE id = ?').get(id) as { id: string; cwd: string; session_id: string | null } | undefined
    if (!inst) { reply.code(404); return { ok: false, error: 'Not found' } }

    if (processRegistry.isTracked(id)) {
      // Park the note and persist it now so it shows in chat immediately. The current
      // turn's exit handler flushes the queue as a fresh follow-up turn.
      // An identical note already waiting is not queued or stored twice (see queueBtwNote).
      const added = queueBtwNote(id, text)
      if (!added) return { ok: true, queued: true, duplicate: true }
      try {
        db.prepare('INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), id, 'user', JSON.stringify([{ type: 'text', text }]), Date.now())
      } catch (err) {
        console.warn(`[instances] /btw persist failed for ${id}:`, (err as Error).message)
      }
      // Race: the turn may have ended between the isTracked check and the queue write.
      // If it's already idle, flush right now so the note isn't left waiting.
      if (!processRegistry.isTracked(id)) {
        const notes = takePendingBtwNotes(id)
        if (notes.length) {
          await sendMessage({ instanceId: id, text: notes.join('\n\n'), cwd: inst.cwd, sessionId: inst.session_id || undefined, flags, origin: 'btw' })
        }
      }
      return { ok: true, queued: true }
    }

    // Idle → run it now. /send persists the note + applies global flags.
    const resp = await app.inject({ method: 'POST', url: `/api/instances/${id}/send`, payload: { text, flags } })
    if (resp.statusCode >= 400) {
      reply.code(resp.statusCode)
      return { ok: false, error: `send failed: HTTP ${resp.statusCode}` }
    }
    return { ok: true, queued: false }
  })

  // Approve or reject a plan presented via ExitPlanMode. Approval resumes the
  // session WITH execution permissions; rejection resumes still in plan mode.
  app.post('/instances/:id/decide-plan', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { toolUseId?: unknown; decision?: unknown; feedback?: unknown }
    const toolUseId = typeof body?.toolUseId === 'string' ? body.toolUseId : ''
    const decision = body?.decision === 'approve' || body?.decision === 'reject' ? body.decision : ''
    const feedback = typeof body?.feedback === 'string' ? body.feedback : ''
    if (!toolUseId) { reply.code(400); return { ok: false, error: 'Missing toolUseId' } }
    if (!decision) { reply.code(400); return { ok: false, error: 'Missing decision (approve|reject)' } }

    // Approving a plan has to leave plan mode - but it must not DOWNGRADE a user who
    // deliberately chose something more permissive. This used to hardcode acceptEdits,
    // which silently overrode the composer's setting for the entire life of the resumed
    // process: an instance set to Bypass would prompt on every Bash while the UI kept
    // showing "Bypass", with nothing to explain the mismatch.
    //
    // The mode lives in client localStorage, so the client sends it. Absent or invalid
    // (older client, or a caller that doesn't know about it) falls back to the previous
    // acceptEdits behaviour, so this stays backward-compatible.
    const VALID_PERMISSION_MODES = new Set([
      'default', 'plan', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions',
    ])
    const requestedMode = typeof (body as { permissionMode?: unknown })?.permissionMode === 'string'
      ? (body as { permissionMode: string }).permissionMode
      : ''
    const approveMode = VALID_PERMISSION_MODES.has(requestedMode) && requestedMode !== 'plan'
      ? requestedMode
      : 'acceptEdits'
    const res = decision === 'approve'
      ? await injectUserTurn(id, 'Plan approved - proceed with the implementation.', [`--permission-mode=${approveMode}`])
      : await injectUserTurn(id, `Plan rejected. Feedback: ${feedback || 'please revise the plan.'}`, ['--permission-mode=plan'])
    if (!res.ok) { reply.code(409); return res }
    return { ok: true }
  })

  // Kill instance process (stops Claude, resets to idle - does not delete instance)
  app.post('/instances/:id/kill', async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = db.prepare('SELECT id FROM instances WHERE id = ?').get(id) as { id: string } | undefined
    if (!row) { reply.code(404); return { error: 'Not found' } }
    const wasRunning = processRegistry.isTracked(id)
    const killed = await processRegistry.killProcess(id)
    if (!killed) {
      // The process survived the kill - do NOT mark it idle (that would lie:
      // the agent is still running). Surface the failure so the user can retry
      // or Force Reset.
      reply.code(500)
      return { error: 'kill-failed', message: 'Process survived the kill and is still running. Try again, or use Force Reset.' }
    }
    db.prepare("UPDATE instances SET state = 'idle', process_state = 'idle', process_pid = NULL, version = version + 1 WHERE id = ?").run(id)
    // Stopping withdraws the question: nothing is waiting on the user any more.
    clearAwaitingInput(id)
    broadcastEvent({ type: 'instance:state', payload: { instanceId: id, state: 'idle' } })
    return { killed: wasRunning }
  })

  // Force reset - escape hatch for instances wedged in 'running'.
  // Kills any tracked process, resets process_state/state to idle, clears assigned
  // task metadata, and broadcasts the full updated instance so all clients un-wedge.
  app.post('/instances/:id/force-reset', async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = db.prepare('SELECT id FROM instances WHERE id = ?').get(id) as { id: string } | undefined
    if (!row) { reply.code(404); return { error: 'Not found' } }
    const wasTracked = processRegistry.isTracked(id)
    await processRegistry.killProcess(id)
    db.prepare(
      "UPDATE instances SET state = 'idle', process_state = 'idle', process_pid = NULL, version = version + 1 WHERE id = ?"
    ).run(id)
    // Force Reset is the un-wedge escape hatch, so it must clear this too, otherwise an
    // instance stuck amber could never be cleared from the UI at all.
    clearAwaitingInput(id)
    const updated = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown>
    broadcastEvent({ type: 'instance:updated', payload: rowToInstance(updated) })
    broadcastEvent({ type: 'instance:state', payload: { instanceId: id, state: 'idle' } })
    return { ok: true, killed: wasTracked }
  })

  // Pause instance
  app.post('/instances/:id/pause', async (request, reply) => {
    const { id } = request.params as { id: string }
    const killed = await processRegistry.killProcess(id)
    if (!killed) {
      // Could not actually stop the process - keep the instance marked running
      // rather than falsely showing it paused while the agent keeps going.
      reply.code(500)
      return { ok: false, error: 'kill-failed', message: 'Could not stop the run: the process is still running. Try again, or use Force Reset.' }
    }
    db.prepare("UPDATE instances SET state = 'paused', process_state = 'idle', process_pid = NULL, version = version + 1 WHERE id = ?").run(id)
    clearAwaitingInput(id)
    broadcastEvent({ type: 'instance:state', payload: { instanceId: id, state: 'paused' } })
    return { ok: true }
  })

  // Resume instance
  app.post('/instances/:id/resume', async (request) => {
    const { id } = request.params as { id: string }
    db.prepare("UPDATE instances SET state = 'idle' WHERE id = ?").run(id)
    // Belt and braces: pause already clears the flag, so an awaiting+paused instance is
    // hard to reach. Clearing here too means no ordering of pause/resume can strand one.
    clearAwaitingInput(id)
    broadcastEvent({ type: 'instance:state', payload: { instanceId: id, state: 'idle' } })
    return { ok: true }
  })

  // Sync session - read last assistant message from session JSONL
  app.post('/instances/:id/sync-session', async (request) => {
    const { id } = request.params as { id: string }
    const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!instance) {
      throw { statusCode: 404, message: 'Instance not found' }
    }

    if (!instance.session_id || !instance.cwd) {
      return { message: null }
    }

    const message = getLastAssistantMessage(instance.cwd as string, instance.session_id as string)
    return { message }
  })

  // Reorder instances
  app.put('/instances/reorder', async (request) => {
    const { ids } = request.body as { ids: string[] }
    const stmt = db.prepare('UPDATE instances SET sort_order = ? WHERE id = ?')
    const transaction = db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        stmt.run(i, ids[i])
      }
    })
    transaction()
    broadcastEvent({ type: 'instances:reordered', payload: { ids } })
    return { ok: true }
  })
}

export function rowToInstance(r: Record<string, unknown>) {
  return {
    id: r.id as string,
    folderId: r.folder_id as string,
    name: r.name as string,
    cwd: r.cwd as string,
    sessionId: r.session_id as string | undefined,
    state: (r.state as string) || 'idle',
    agentId: r.agent_id as string | undefined,
    idleRestartMinutes: r.idle_restart_minutes as number,
    sortOrder: r.sort_order as number,
    createdAt: r.created_at as number,
    overdriveTasks: (r.overdrive_tasks as number) ?? 0,
    overdriveStartedAt: r.overdrive_started_at as number | undefined,
    lastTaskAt: r.last_task_at as number | undefined,
    keepWarm: Boolean(r.keep_warm),
    lastTurnMs: (r.last_turn_ms as number) || undefined,
    maxTurnMs: (r.max_turn_ms as number) || undefined,
    dirtyCount: getInstanceDirtyCount(r.id as string),
    awaitingInput: (r.awaiting_input as string) || undefined,
    awaitingInputAt: (r.awaiting_input_at as number) || undefined,
    outputStyle: (r.output_style as string) || undefined,
    language: (r.language as string) || undefined,
    permissionRules: parsePermissionRules(r.permission_rules),
  }
}

// The rule-set parser and normaliser live in services/permission-rule-sets.ts:
// folders carry the same blob now (migration049) and a service cannot import a route to read it.
// Re-exported here so routes/state.ts and anything else that already imports them keep working.
export { normalisePermissionRules, parsePermissionRules }
