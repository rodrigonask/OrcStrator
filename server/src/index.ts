import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import path from 'path'
import { fileURLToPath } from 'url'
import { initDb, db, closeDb } from './db.js'
import { registerWebSocket } from './ws/handler.js'
import { setOrchestratorCallback } from './services/claude-process.js'
import { processRegistry, isProcessAlive } from './services/process-registry.js'
import { orchestrator, type ResumeSnapshot } from './services/orchestrator.js'
import { schedulerService } from './services/scheduler-service.js'
import { startPolling, fetchUsage } from './services/usage-monitor.js'
import { DEFAULT_PORT, ALLOWED_ORIGINS } from './config.js'
import { resetOverdriveForAll } from './services/overdrive.js'

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

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  // Initialize database
  initDb()

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

  // Read all instances that were running before restart
  const staleRunning = db.prepare(
    "SELECT id, session_id, folder_id, process_pid FROM instances WHERE state = 'running'"
  ).all() as { id: string; session_id: string | null; folder_id: string; process_pid: number | null }[]

  const adoptedIds = new Set<string>()
  const resumeSnapshots: ResumeSnapshot[] = []

  for (const inst of staleRunning) {
    const alive = inst.process_pid != null && isProcessAlive(inst.process_pid)
    if (alive) {
      adoptedIds.add(inst.id)
      processRegistry.adoptProcess(inst.id, inst.process_pid!)
      console.log(`[startup] Adopting alive process PID ${inst.process_pid} → instance ${inst.id}`)
    } else {
      // Dead — collect for resume if it had a session + locked tasks
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
    }
  }

  // Only reset DEAD instances (adopted ones stay 'running')
  if (staleRunning.length > 0) {
    const excluded = [...adoptedIds]
    if (excluded.length > 0) {
      const placeholders = excluded.map(() => '?').join(',')
      const resetCount = db.prepare(
        `UPDATE instances SET state = 'idle', process_pid = NULL
         WHERE state = 'running' AND id NOT IN (${placeholders})`
      ).run(...excluded).changes
      if (resetCount > 0) console.log(`[startup] Reset ${resetCount} dead instances to idle`)

      const unlockCount = db.prepare(
        `UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL
         WHERE locked_by IS NOT NULL AND locked_by NOT IN (${placeholders})`
      ).run(...excluded).changes
      if (unlockCount > 0) console.log(`[startup] Released ${unlockCount} stale task locks`)
    } else {
      // No adopted processes — reset everything
      const resetCount = db.prepare("UPDATE instances SET state = 'idle', process_pid = NULL WHERE state = 'running'").run().changes
      if (resetCount > 0) console.log(`[startup] Reset ${resetCount} dead instances to idle`)

      const unlockCount = db.prepare("UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL WHERE locked_by IS NOT NULL").run().changes
      if (unlockCount > 0) console.log(`[startup] Released ${unlockCount} stale task locks`)
    }
  }

  if (adoptedIds.size > 0) {
    console.log(`[startup] ${adoptedIds.size} agents still running — leaving undisturbed`)
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

  // Resume dead sessions, then unlock assignments
  if (resumeSnapshots.length > 0) {
    await orchestrator.resumeStaleInstances(resumeSnapshots)
  }
  orchestrator.unlockStartup()  // NOW assignments can proceed
  await orchestrator.triggerAll()

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
  } catch (err) {
    console.error('[server] Failed to start:', err)
    process.exit(1)
  }
}

main()
