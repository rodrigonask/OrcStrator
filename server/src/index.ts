import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import path from 'path'
import { fileURLToPath } from 'url'
import { initDb, db, closeDb } from './db.js'
import { registerWebSocket } from './ws/handler.js'
import { killAll, setOrchestratorCallback } from './services/claude-process.js'
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

  // Sweep expired overdrive indicators every 5 minutes
  setInterval(() => {
    try {
      resetOverdriveForAll()
    } catch (err) {
      console.error('[maintenance] Overdrive sweep error:', err)
    }
  }, 5 * 60 * 1000)

  // Snapshot running instances BEFORE any resets — session IDs are wiped by the reset below
  const staleRunning = db.prepare(
    "SELECT id, session_id, folder_id FROM instances WHERE state = 'running' AND session_id IS NOT NULL"
  ).all() as { id: string; session_id: string; folder_id: string }[]

  const resumeSnapshots: ResumeSnapshot[] = staleRunning.map(i => {
    const tasks = db.prepare(
      "SELECT id FROM pipeline_tasks WHERE locked_by = ?"
    ).all(i.id) as { id: string }[]
    return {
      instanceId: i.id,
      sessionId: i.session_id,
      folderId: i.folder_id,
      lockedTaskIds: tasks.map(t => t.id)
    }
  }).filter(s => s.lockedTaskIds.length > 0)

  // Reset stale running instances — on restart no Claude processes exist
  const resetCount = db.prepare("UPDATE instances SET state = 'idle' WHERE state = 'running'").run().changes
  if (resetCount > 0) {
    console.log(`[startup] Reset ${resetCount} stale running instances to idle`)
  }

  // Release stale task locks — locked tasks from the previous session would never be claimed
  const unlockCount = db.prepare("UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL WHERE locked_by IS NOT NULL").run().changes
  if (unlockCount > 0) {
    console.log(`[startup] Released ${unlockCount} stale task locks`)
  }

  // Resume usage polling if tokens are already stored from a previous session
  const pollRow = db.prepare("SELECT value FROM settings WHERE key = 'usagePollMinutes'").get() as { value: string } | undefined
  const pollMinutes = pollRow ? (JSON.parse(pollRow.value) as number) : 10
  startPolling(pollMinutes)

  // Wire orchestrator callback (event-driven dispatch)
  setOrchestratorCallback((instanceId, tokens) => {
    orchestrator.onProcessExit(instanceId, tokens)
    // Refresh usage meter after each session — credits are consumed at session end
    fetchUsage().catch(() => {})
  })
  orchestrator.start()
  schedulerService.start()
  if (resumeSnapshots.length > 0) {
    orchestrator.resumeStaleInstances(resumeSnapshots)
  } else {
    orchestrator.triggerAll()
  }

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 * 20 }) // 20MB to support screenshot attachments

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
    killAll()
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
