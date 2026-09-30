import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { initDb, db, closeDb, dbReadOnlyReason } from './db.js'
import { DataDirLockedError } from './data-dir-lock.js'
import { snapshotProcesses } from './services/process-tree.js'
import { warnIfApiKeyInherited } from './services/agent-env.js'
import { safeJsonParse } from './services/task-manager.js'
import { registerWebSocket, broadcastEvent } from './ws/handler.js'
import { onTurnComplete, scheduleBtwFlush } from './services/claude-process.js'
import { buildTurnFlags } from './services/turn-flags.js'
import { resolveClaudeBinary, probeClaudeVersion } from './services/claude-binary.js'
import { processRegistry, isProcessAlive, setMaxConcurrentProcesses, getMaxConcurrentProcesses, verifyAgentIdentity, setAgentLimitEnforced } from './services/process-registry.js'
import { startWakeupScheduler, stopWakeupScheduler } from './services/wakeup-scheduler.js'
import { startTaskRunner, stopTaskRunner } from './services/task-runner.js'
import { initFileLocks } from './services/file-locks.js'
import { startTaskScheduler, stopTaskScheduler } from './services/task-scheduler.js'
import { startCacheAdvisor, stopCacheAdvisor } from './services/cache-advisor.js'
import { startPolling, fetchUsage } from './services/usage-monitor.js'
import { PORT, ALLOWED_ORIGINS, BIND_HOST } from './config.js'
import { installSecurityHooks } from './security.js'
import { installErrorHandler } from './error-handler.js'
import { serverOptions } from './app-options.js'
import { getScriptToken } from './services/api-auth.js'
import { reencryptLegacySecrets } from './services/secret-box.js'
import { runRetention } from './services/data-retention.js'
import { ingestCompactionLog } from './services/compaction-savings.js'
import { resetOverdriveForAll } from './services/overdrive.js'
import { startNativeTaskWatcher } from './services/native-tasks.js'

// Route modules
import stateRoutes from './routes/state.js'
import folderRoutes from './routes/folders.js'
import instanceRoutes from './routes/instances.js'
import historyRoutes from './routes/history.js'
import pipelineRoutes from './routes/pipeline.js'
import settingsRoutes from './routes/settings.js'
import usageRoutes from './routes/usage.js'
import profileRoutes from './routes/profile.js'
import agentRoutes from './routes/agents.js'
import skillRoutes from './routes/skills.js'
import fsRoutes from './routes/fs.js'
import sessionsRoutes from './routes/sessions.js'
import activityRoutes from './routes/activity.js'
import authRoutes from './routes/auth.js'
import { backfillClosedInstanceNames } from './services/closed-instance-backfill.js'
import { installProcessErrorHandlers } from './services/process-errors.js'
import { sweepUnreferencedMedia } from './services/message-media.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  // Initialize database. Takes the data dir's single-owner lock first: a second
  // server on the same folder stops here with a plain message instead of sharing the DB.
  try {
    await initDb({ port: PORT })
  } catch (err) {
    if (err instanceof DataDirLockedError) {
      console.error(`[server] ${err.message}`)
      process.exit(1)
    }
    throw err
  }
  warnIfApiKeyInherited()

  // The pre-migration backup failed, so the database is open read-only and was not updated.
  // Serve the app so the user can see their chats and the reason, refuse every
  // write, and start nothing that writes (no schedulers, no startup repairs).
  if (dbReadOnlyReason) {
    await startReadOnly(dbReadOnlyReason)
    return
  }

  // Read max concurrent processes from settings (env var overrides)
  if (!process.env.ORCSTRATOR_MAX_PROCESSES) {
    try {
      const maxRow = db.prepare("SELECT value FROM settings WHERE key = 'maxConcurrentProcesses'").get() as { value: string } | undefined
      if (maxRow) {
        const n = JSON.parse(maxRow.value) as number
        if (n > 0) setMaxConcurrentProcesses(n)
      }
    } catch { /* use default */ }
  }
  // Enforced only when switched on in Settings. Absent means off.
  try {
    const onRow = db.prepare("SELECT value FROM settings WHERE key = 'maxConcurrentLimitOn'").get() as { value: string } | undefined
    if (onRow && JSON.parse(onRow.value) === true) setAgentLimitEnforced(true)
  } catch { /* off */ }

  // WAL checkpoint to keep DB file size bounded
  const runMaintenance = () => {
    try {
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run()
      console.log('[maintenance] WAL checkpoint complete')
    } catch (err) {
      console.error('[maintenance] WAL checkpoint error:', err)
    }
    // Hand free pages back to the disk a few at a time. Only does anything once
    // scripts/vacuum-db.mjs has switched the database to incremental auto-vacuum; a no-op before.
    try {
      if (db.pragma('auto_vacuum', { simple: true }) === 2) db.pragma('incremental_vacuum(2000)')
    } catch (err) {
      console.error('[maintenance] incremental vacuum error:', err)
    }
  }
  runMaintenance()
  setInterval(runMaintenance, 6 * 60 * 60 * 1000)
  // Stored screenshots no message points at any more (a path that deleted rows without releasing
  // them), older than an hour so an image mid-paste is never taken. At boot and then
  // with the rest of the maintenance.
  try { sweepUnreferencedMedia() } catch (err) { console.error('[maintenance] media sweep error:', err) }
  setInterval(() => { try { sweepUnreferencedMedia() } catch { /* logged inside */ } }, 6 * 60 * 60 * 1000)

  // Sweep expired overdrive indicators at startup and every 5 minutes
  try { resetOverdriveForAll() } catch (err) { console.error('[maintenance] Overdrive sweep error:', err) }
  setInterval(() => {
    try {
      resetOverdriveForAll()
    } catch (err) {
      console.error('[maintenance] Overdrive sweep error:', err)
    }
  }, 5 * 60 * 1000)

  // Watch Claude Code's own task files (~/.claude/tasks) so the task panel updates live.
  // Read-only and non-fatal: if this fails, /state still hydrates the panel on load.
  startNativeTaskWatcher()

  // ── Startup audit phase ──

  /**
   * An instance died mid-turn while working a pipeline task. Release the task so it does
   * not sit in in_progress forever waiting for a hand-off that can never arrive, and clear
   * the instance -> task pointer so an unrelated later turn is not misattributed to it.
   *
   * The task keeps its column: it is left where the human last saw it rather than being
   * moved under them. It gains the `stuck` label, which the board already renders as a
   * prominent STUCK badge, plus a comment saying why. Returns the task id, or null.
   */
  function releaseStrandedTask(instanceId: string): string | null {
    try {
      const row = db.prepare('SELECT active_task_id FROM instances WHERE id = ?').get(instanceId) as
        | { active_task_id: string | null } | undefined
      const taskId = row?.active_task_id
      if (!taskId) return null

      db.prepare('UPDATE instances SET active_task_id = NULL WHERE id = ?').run(instanceId)

      const task = db.prepare('SELECT labels, history FROM pipeline_tasks WHERE id = ?').get(taskId) as
        | { labels: string; history: string } | undefined
      if (!task) return taskId // task already deleted; clearing the pointer was the point

      const labels: string[] = safeJsonParse(task.labels, [])
      if (!labels.includes('stuck')) labels.push('stuck')
      const history: Array<Record<string, unknown>> = safeJsonParse(task.history, [])
      history.push({ action: 'blocked', timestamp: Date.now(), agent: 'orcstrator', note: 'Run interrupted by a server restart' })

      db.prepare('UPDATE pipeline_tasks SET labels = ?, history = ?, updated_at = ?, version = version + 1 WHERE id = ?')
        .run(JSON.stringify(labels), JSON.stringify(history), Date.now(), taskId)
      db.prepare('INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), taskId, 'orcstrator',
          'The instance working this task was interrupted by a server restart, so no hand-off was recorded. Start it again when ready.',
          Date.now())
      return taskId
    } catch (err) {
      console.error('[startup] releaseStrandedTask failed:', err)
      return null
    }
  }

  // Full state dump BEFORE any changes — critical for post-mortem debugging
  const allInstances = db.prepare("SELECT id, name, state, folder_id, session_id, process_pid FROM instances").all() as Record<string, unknown>[]
  console.log(`[startup] ═══ DB STATE DUMP ═══`)
  console.log(`[startup] Instances (${allInstances.length}):`)
  for (const i of allInstances) {
    console.log(`[startup]   ${i.name} | state=${i.state} | pid=${i.process_pid || 'null'} | session=${i.session_id ? (i.session_id as string).slice(0, 12) + '...' : 'null'} | id=${(i.id as string).slice(0, 8)}`)
  }
  console.log(`[startup] ═══ END STATE DUMP ═══`)

  // Read all instances with non-idle process_state
  const nonIdle = db.prepare(
    "SELECT id, session_id, folder_id, process_pid, process_started_at, process_state FROM instances WHERE process_state != 'idle'"
  ).all() as { id: string; session_id: string | null; folder_id: string; process_pid: number | null; process_started_at: number | null; process_state: string }[]

  const adoptedIds = new Set<string>()

  // A live PID is only this chat's agent if it is claude and started when the
  // chat's process did. After a reboot the same number can belong to anything (VS Code, a dev
  // server), which used to be adopted, shown as "running" for ever, and killed by Stop.
  const snapshot = nonIdle.some(i => i.process_pid != null && isProcessAlive(i.process_pid)) ? await snapshotProcesses() : null

  // Single transaction: classify each non-idle instance as alive or dead
  db.transaction(() => {
    for (const inst of nonIdle) {
      const alive = inst.process_pid != null && isProcessAlive(inst.process_pid)
      // 'unknown' (the process table could not be read) is adopted: it may be a live agent,
      // and starting a second one next to it is the worse mistake. Stop re-checks before it
      // kills anything, and refuses when it still cannot tell.
      const identity = alive ? verifyAgentIdentity(inst.process_pid!, inst.process_started_at, snapshot) : 'stranger'
      if (alive && identity !== 'stranger') {
        // Adopt: keep process_state='running' in DB, no ChildProcess handle
        adoptedIds.add(inst.id)
        console.log(`[startup] Adopting alive process PID ${inst.process_pid} → instance ${inst.id}${identity === 'unknown' ? ' (identity unverified)' : ''}`)
      } else {
        if (alive) console.warn(`[startup] PID ${inst.process_pid} of instance ${inst.id} now belongs to another program; not adopted, not killed`)
        // Reset dead instance to idle. If it was mid-way through a pipeline task, the task
        // has to be released too: the in_review hand-off only ever fires from
        // onTurnComplete, and that process died with the server, so the task would sit in
        // in_progress forever. Worse, leaving active_task_id set means the NEXT turn on
        // this instance (any unrelated chat message) satisfies handleTurnComplete's check
        // and posts its output as this task's hand-off comment.
        //
        // Deliberately does NOT touch awaiting_input: an instance that hard-stopped on a
        // question and then outlived the server is still waiting for an answer, and clearing
        // it here would silently drop it out of the active strip on every restart.
        const strandedTaskId = releaseStrandedTask(inst.id)
        db.prepare(
          `UPDATE instances SET process_state = 'idle', state = 'idle', process_pid = NULL, version = version + 1
           WHERE id = ?`
        ).run(inst.id)
        console.log(
          `[startup] Reset dead instance ${inst.id} (was ${inst.process_state}) to idle` +
          (strandedTaskId ? ` and released stranded task ${strandedTaskId.slice(0, 8)}` : '')
        )
      }
    }
  })()

  // (A non-adopted PID that is still alive belongs to another program by now, see above, so
  // nothing here kills it. The old tree-kill of "orphans" at this point could only ever hit
  // a stranger that had been given a dead agent's number.)
  if (adoptedIds.size > 0) {
    // No ChildProcess handle means no 'exit' event: watch them, and hand the chat back when
    // the agent finishes, instead of it reading "running" until the next restart.
    for (const inst of nonIdle) {
      if (!adoptedIds.has(inst.id)) continue
      processRegistry.watchAdopted(inst.id, inst.process_pid!, inst.process_started_at, (id) => {
        const strandedTaskId = releaseStrandedTask(id)
        db.prepare(
          "UPDATE instances SET process_state = 'idle', state = 'idle', process_pid = NULL, version = version + 1 WHERE id = ? AND process_pid = ?"
        ).run(id, inst.process_pid)
        broadcastEvent({ type: 'instance:state', payload: { instanceId: id, state: 'idle' } })
        console.log(`[startup] adopted agent PID ${inst.process_pid} of instance ${id.slice(0, 8)} has exited; chat is idle${strandedTaskId ? `, task ${strandedTaskId.slice(0, 8)} released` : ''}`)
        // A /btw sent while it was running waited for it; send it now as its own turn.
        const row = db.prepare('SELECT cwd, session_id FROM instances WHERE id = ?').get(id) as { cwd: string; session_id: string | null } | undefined
        if (row) scheduleBtwFlush(id, row.cwd, row.session_id ?? undefined, buildTurnFlags({}))
      })
    }
    console.log(`[startup] ${adoptedIds.size} agents still running — leaving undisturbed`)
  }

  // ── Token Reconciliation: fix pipeline_tasks with un-accumulated tokens from crashes ──
  try {
    const orphaned = db.prepare(`
      SELECT tu.task_id,
             SUM(tu.input_tokens) as sum_input,
             SUM(tu.output_tokens) as sum_output,
             SUM(tu.cost_usd) as sum_cost,
             pt.total_input_tokens as task_input,
             pt.total_output_tokens as task_output,
             pt.total_cost_usd as task_cost,
             pt.title
      FROM token_usage tu
      JOIN pipeline_tasks pt ON tu.task_id = pt.id
      WHERE tu.input_tokens > 0 OR tu.output_tokens > 0
      GROUP BY tu.task_id
      HAVING sum_input > COALESCE(pt.total_input_tokens, 0)
          OR sum_output > COALESCE(pt.total_output_tokens, 0)
    `).all() as Array<{ task_id: string; sum_input: number; sum_output: number; sum_cost: number; task_input: number; task_output: number; task_cost: number; title: string }>

    if (orphaned.length > 0) {
      console.log(`[startup] TOKEN RECONCILIATION: ${orphaned.length} tasks with un-accumulated tokens`)
      for (const row of orphaned) {
        db.prepare(
          'UPDATE pipeline_tasks SET total_input_tokens = ?, total_output_tokens = ?, total_cost_usd = ? WHERE id = ?'
        ).run(row.sum_input, row.sum_output, +(row.sum_cost).toFixed(6), row.task_id)
        const diff = +(row.sum_cost - (row.task_cost || 0)).toFixed(4)
        console.log(`[startup]   Reconciled "${row.title}": +$${diff} (now $${(+row.sum_cost).toFixed(4)})`)
      }
    } else {
      console.log('[startup] Token reconciliation: all totals consistent')
    }
  } catch (err) {
    console.error('[startup] Token reconciliation error:', err)
  }

  // Resume usage polling if tokens are already stored from a previous session
  const pollRow = db.prepare("SELECT value FROM settings WHERE key = 'usagePollMinutes'").get() as { value: string } | undefined
  const pollMinutes = pollRow ? (JSON.parse(pollRow.value) as number) : 1
  startPolling(pollMinutes)

  // Refresh the usage meter after each finished turn — credits are consumed at session end
  onTurnComplete(() => { fetchUsage().catch(() => {}) })

  startWakeupScheduler()
  startTaskScheduler()
  startTaskRunner()
  startCacheAdvisor()
  await initFileLocks()
  // Create <data dir>/agent-token now, so a script can read it before any chat has run.
  getScriptToken()
  // Old stored tool outputs, orphan settings files and an oversized compaction
  // log are cleared at boot and once a day after.
  runRetention(ingestCompactionLog)
  setInterval(() => runRetention(ingestCompactionLog), 24 * 60 * 60 * 1000).unref()
  // Stored secrets still in the old hostname-keyed format are rewritten under the
  // new key, once. Idempotent; a failure leaves them readable through the old path.
  try {
    const n = reencryptLegacySecrets(db)
    if (n > 0) console.log(`[startup] re-encrypted ${n} stored secret(s) under the new key`)
  } catch (err) {
    console.warn('[startup] secret re-encryption skipped:', (err as Error).message)
  }

  await serve(null)
}

/** The app with its database opened read-only: see initDb and serve. */
async function startReadOnly(reason: string): Promise<void> {
  await serve(reason)
}

/**
 * Build the HTTP/WS server and listen. With `readOnlyReason` set, every write to the API is
 * refused with that reason (503), so the UI shows why instead of failing piecemeal.
 */
async function serve(readOnlyReason: string | null): Promise<void> {
  // 1 MB bodies by default and no per-request log lines (app-options.ts).
  const app = Fastify(serverOptions())
  installErrorHandler(app)
  if (readOnlyReason) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return
      // The page's own token handshake writes nothing, and without it the app cannot even
      // connect to show the user why it is read-only.
      if (request.url.split('?')[0] === '/api/auth/session') return
      return reply.code(503).send({
        error: 'read-only',
        message: `OrcStrator opened its database read-only, so nothing can be changed right now. ${readOnlyReason}`,
      })
    })
  }

  // Anti-DNS-rebinding + cross-origin guard. Runs before EVERY request, including
  // the /ws upgrade, and before any route logic touches the DB or spawns anything.
  //
  // CORS alone is not enough: it only stops a page from READING a cross-origin
  // response — a state-changing POST still executes server-side. And DNS rebinding
  // sidesteps origin checks entirely by making the attacker's page same-origin with
  // us. Validating Host closes that: a rebound request still carries the attacker's
  // hostname, which is not in ALLOWED_HOSTS. See config.ts for the full rationale.
  //
  // On top of that: the cross-site GET block and the API token. security.ts.
  installSecurityHooks(app)

  // Register plugins
  await app.register(fastifyCors, {
    origin: ALLOWED_ORIGINS,
    credentials: true
  })

  await app.register(fastifyWebsocket)

  // Register WebSocket handler
  registerWebSocket(app)

  // Register all API routes under /api prefix
  await app.register(async (api) => {
    await api.register(stateRoutes)
    await api.register(folderRoutes)
    await api.register(instanceRoutes)
    await api.register(historyRoutes)
    await api.register(pipelineRoutes)
    await api.register(settingsRoutes)
    await api.register(usageRoutes)
    await api.register(profileRoutes)
    await api.register(agentRoutes)
    await api.register(skillRoutes)
    await api.register(fsRoutes)
    await api.register(sessionsRoutes)
    await api.register(activityRoutes)
    await api.register(authRoutes)
  }, { prefix: '/api' })

  // In production, serve the client build as static files
  const isProduction = process.env.NODE_ENV === 'production'
  if (isProduction) {
    const clientDist = path.resolve(__dirname, '../../client/dist')
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: '/'
    })

    // SPA fallback: serve index.html for non-API, non-WS routes
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
        reply.code(404).send({ error: 'Not found' })
      } else {
        reply.sendFile('index.html')
      }
    })
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[server] Shutting down...')
    stopWakeupScheduler()
    stopTaskScheduler()
    stopTaskRunner()
    stopCacheAdvisor()

    // Hard timeout: force exit after 20s
    const forceExit = setTimeout(() => {
      console.error('[server] FORCE EXIT: processes did not terminate in 20s')
      process.exit(1)
    }, 20_000)
    forceExit.unref()

    // Kill all processes and WAIT for them to die, including a /compact, which runs outside
    // the registry
    await processRegistry.shutdownAgents()
    console.log('[server] All processes confirmed dead')

    await app.close()
    closeDb()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // A stray rejection or exception is logged and shown to the user, and the server keeps
  // running. The reasoning, and why that is the right call here, is in
  // services/process-errors.ts.
  installProcessErrorHandlers()

  // Probe the native claude binary once before listening. We never block startup on
  // this — if claude is missing, chats will fail loudly, but the server stays up so
  // the UI can render the error and the install hint.
  try {
    const { path: claudePath, hint } = resolveClaudeBinary()
    if (claudePath) {
      const version = await probeClaudeVersion(claudePath)
      if (version) {
        console.log(`[claude] Using native binary: ${claudePath} (${version})`)
      } else {
        console.warn(`[claude] Resolved binary at ${claudePath} but --version probe failed (timeout or non-zero exit).`)
      }
    } else {
      console.warn('')
      console.warn('================================================================')
      console.warn('[claude] ⚠ Native claude CLI not found on PATH or in ~/.local/bin')
      console.warn(`[claude] ${hint}`)
      console.warn('[claude] Server will keep running, but chat turns will fail until')
      console.warn('[claude] the binary is installed. Set ORCSTRATOR_CLAUDE_PATH to')
      console.warn('[claude] override the lookup.')
      console.warn('================================================================')
      console.warn('')
    }
  } catch (err) {
    console.warn('[claude] Binary probe threw:', err)
  }

  // Start listening
  const port = PORT
  try {
    // Loopback by default — this server spawns agents with full filesystem access and
    // must not be reachable from the LAN. Override via ORCSTRATOR_BIND_HOST only if you
    // genuinely intend to expose it (and add auth first).
    await app.listen({ port, host: BIND_HOST })
    console.log(`[server] OrcStrator server listening on http://localhost:${port}`)
  } catch (err) {
    console.error('[server] Failed to start:', err)
    process.exit(1)
  }

  // After listening, never before: this walks transcripts on disk and must not add
  // latency to boot. One-shot and self-guarding — it writes a tombstone for every
  // orphan it inspects, so subsequent boots find nothing to do and return immediately.
  void backfillClosedInstanceNames().catch(err => {
    console.warn('[backfill] closed-chat names failed (usage history keeps the old fallback):', err)
  })
}

main()
