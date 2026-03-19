import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import path from 'path'
import { fileURLToPath } from 'url'
import { initDb, db, closeDb } from './db.js'
import { registerWebSocket, broadcastEvent } from './ws/handler.js'
import { setOrchestratorCallback } from './services/claude-process.js'
import { processRegistry, isProcessAlive, setMaxConcurrentProcesses, getMaxConcurrentProcesses } from './services/process-registry.js'
import treeKill from 'tree-kill'
import { orchestrator, type ResumeSnapshot } from './services/orchestrator.js'
import { schedulerService } from './services/scheduler-service.js'
import { startPolling, fetchUsage } from './services/usage-monitor.js'
import { DEFAULT_PORT, ALLOWED_ORIGINS } from './config.js'
import { resetOverdriveForAll } from './services/overdrive.js'
import { cloudSync } from './services/cloud-sync.js'

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
import orchestratorRoutes from './routes/orchestrator.js'
import mcpRoutes from './routes/mcp.js'
import sessionsRoutes from './routes/sessions.js'
import syncRoutes from './routes/sync.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  // Initialize database
  initDb()

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

  // WAL checkpoint to keep DB file size bounded
  const runMaintenance = () => {
    try {
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run()
      console.log('[maintenance] WAL checkpoint complete')
    } catch (err) {
      console.error('[maintenance] WAL checkpoint error:', err)
    }
  }
  runMaintenance()
  setInterval(runMaintenance, 6 * 60 * 60 * 1000)

  // Sweep expired overdrive indicators at startup and every 5 minutes
  try { resetOverdriveForAll() } catch (err) { console.error('[maintenance] Overdrive sweep error:', err) }
  setInterval(() => {
    try {
      resetOverdriveForAll()
    } catch (err) {
      console.error('[maintenance] Overdrive sweep error:', err)
    }
  }, 5 * 60 * 1000)

  // ── Startup audit phase (assignments are locked by default) ──

  // Full state dump BEFORE any changes — critical for post-mortem debugging
  const allInstances = db.prepare("SELECT id, name, state, agent_role, folder_id, session_id, process_pid, orchestrator_managed FROM instances").all() as Record<string, unknown>[]
  console.log(`[startup] ═══ DB STATE DUMP ═══`)
  console.log(`[startup] Instances (${allInstances.length}):`)
  for (const i of allInstances) {
    console.log(`[startup]   ${i.name} | state=${i.state} | role=${i.agent_role || 'none'} | pid=${i.process_pid || 'null'} | session=${i.session_id ? (i.session_id as string).slice(0, 12) + '...' : 'null'} | managed=${i.orchestrator_managed} | id=${(i.id as string).slice(0, 8)}`)
  }
  const lockedTasks = db.prepare("SELECT id, title, \"column\", locked_by, locked_at, project_id FROM pipeline_tasks WHERE locked_by IS NOT NULL").all() as Record<string, unknown>[]
  console.log(`[startup] Locked tasks (${lockedTasks.length}):`)
  for (const t of lockedTasks) {
    const age = t.locked_at ? Math.round((Date.now() - (t.locked_at as number)) / 1000) : '?'
    console.log(`[startup]   "${t.title}" | col=${t.column} | locked_by=${(t.locked_by as string).slice(0, 8)} | locked ${age}s ago`)
  }
  console.log(`[startup] ═══ END STATE DUMP ═══`)

  // Read all instances with non-idle process_state
  const nonIdle = db.prepare(
    "SELECT id, session_id, folder_id, process_pid, process_state FROM instances WHERE process_state != 'idle'"
  ).all() as { id: string; session_id: string | null; folder_id: string; process_pid: number | null; process_state: string }[]

  const adoptedIds = new Set<string>()
  const resumeSnapshots: ResumeSnapshot[] = []

  // Single transaction: classify each non-idle instance as alive or dead
  db.transaction(() => {
    for (const inst of nonIdle) {
      const alive = inst.process_pid != null && isProcessAlive(inst.process_pid)
      if (alive) {
        // Adopt: keep process_state='running' in DB, no ChildProcess handle
        adoptedIds.add(inst.id)
        console.log(`[startup] Adopting alive process PID ${inst.process_pid} → instance ${inst.id}`)
      } else {
        // Dead: collect for resume if it had a session + locked tasks
        if (inst.session_id) {
          const tasks = db.prepare("SELECT id FROM pipeline_tasks WHERE locked_by = ?")
            .all(inst.id) as { id: string }[]
          if (tasks.length > 0) {
            resumeSnapshots.push({
              instanceId: inst.id, sessionId: inst.session_id,
              folderId: inst.folder_id, lockedTaskIds: tasks.map(t => t.id)
            })
          }
        }

        // Reset dead instance to idle
        db.prepare(
          `UPDATE instances SET process_state = 'idle', state = 'idle', process_pid = NULL,
           assigned_task_ids = NULL, is_scheduler_run = 0, scheduler_context = NULL, version = version + 1
           WHERE id = ?`
        ).run(inst.id)

        // Release all locks held by this dead instance
        db.prepare(
          `UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL, lock_version = lock_version + 1, version = version + 1
           WHERE locked_by = ?`
        ).run(inst.id)

        console.log(`[startup] Reset dead instance ${inst.id} (was ${inst.process_state}) to idle`)
      }
    }
  })()

  // Kill orphaned OS processes that are NOT adopted
  const orphanPids: number[] = []
  for (const inst of nonIdle) {
    if (inst.process_pid != null && !adoptedIds.has(inst.id) && isProcessAlive(inst.process_pid)) {
      orphanPids.push(inst.process_pid)
    }
  }
  if (orphanPids.length > 0) {
    console.warn(`[startup] KILLING ${orphanPids.length} orphaned processes: [${orphanPids.join(', ')}]`)
    await Promise.all(orphanPids.map(pid => new Promise<void>(resolve => {
      treeKill(pid, 'SIGKILL', (err) => {
        if (err) console.warn(`[startup] tree-kill error for orphan PID ${pid}:`, err.message)
        else console.log(`[startup] Killed orphan PID ${pid}`)
        resolve()
      })
    })))
  }

  // ── Restart detection: if non-idle instances existed, this is a restart ──
  const isRestart = nonIdle.length > 0
  if (isRestart) {
    // Remember which folders were active before deactivating (so user can reactivate them)
    const prevActiveFolders = (db.prepare('SELECT id FROM folders WHERE orchestrator_active = 1').all() as { id: string }[]).map(f => f.id)
    db.prepare('UPDATE folders SET orchestrator_active = 0').run()
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_restart_at', ?)").run(JSON.stringify(Date.now()))
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('restart_adopted_count', ?)").run(JSON.stringify(adoptedIds.size))
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('restart_deactivated_folders', ?)").run(JSON.stringify(prevActiveFolders))
    console.warn('[startup] ⚠ RESTART DETECTED — all orchestrators DEACTIVATED. Manual reactivation required after 60s cooldown.')
  }

  if (adoptedIds.size > 0) {
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
  const pollMinutes = pollRow ? (JSON.parse(pollRow.value) as number) : 10
  startPolling(pollMinutes)

  // ── Start orchestrator (still locked) ──
  setOrchestratorCallback((instanceId, tokens) => {
    orchestrator.onProcessExit(instanceId, tokens)
    // Refresh usage meter after each session — credits are consumed at session end
    fetchUsage().catch(() => {})
  })
  orchestrator.start()
  schedulerService.start()
  cloudSync.initialize()

  // Resume dead sessions + trigger work — only on clean startup, NOT on restart
  if (!isRestart) {
    if (resumeSnapshots.length > 0) {
      await orchestrator.resumeStaleInstances(resumeSnapshots)
    }
    orchestrator.unlockStartup()
    await orchestrator.triggerAll()
  } else {
    // Restart — just unlock, don't resume or trigger anything
    orchestrator.unlockStartup()
  }

  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 * 20 }) // 20MB to support screenshot attachments

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
    await api.register(orchestratorRoutes)
    await api.register(mcpRoutes)
    await api.register(sessionsRoutes)
    await api.register(syncRoutes)
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
    orchestrator.stop()
    schedulerService.stop()

    // Delete dev lockfile so watcher can restart freely
    orchestrator.clearDevLock()

    // Hard timeout: force exit after 20s
    const forceExit = setTimeout(() => {
      console.error('[server] FORCE EXIT: processes did not terminate in 20s')
      process.exit(1)
    }, 20_000)
    forceExit.unref()

    // Kill all processes and WAIT for them to die
    await processRegistry.killAll()
    console.log('[server] All processes confirmed dead')

    await app.close()
    closeDb()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Start listening
  const port = parseInt(process.env.PORT || String(DEFAULT_PORT), 10)
  try {
    await app.listen({ port, host: '0.0.0.0' })
    console.log(`[server] OrcStrator server listening on http://localhost:${port}`)

    // Broadcast restart event to connected clients after server is ready
    if (isRestart) {
      setTimeout(() => {
        broadcastEvent({
          type: 'server:restart-detected',
          payload: { lastRestartAt: Date.now(), cooldownMs: 60_000 }
        })
      }, 1000)
    }
  } catch (err) {
    console.error('[server] Failed to start:', err)
    process.exit(1)
  }
}

main()
