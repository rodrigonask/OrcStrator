#!/usr/bin/env node
/**
 * Lockfile-gated dev watcher for OrcStrator server.
 * Replaces `tsx watch` to prevent restarts while orchestrator agents are active.
 *
 * Behavior:
 * - Spawns `npx tsx src/index.ts`
 * - Watches `server/src/` for file changes
 * - On change: checks ~/.orcstrator/dev.lock before restarting
 * - If lockfile exists with alive PID: queues restart, polls every 5s
 * - If lockfile exists with dead PID: treats as stale, deletes it, proceeds
 * - 500ms debounce on file changes
 */

import { spawn } from 'child_process'
import { watch, existsSync, readFileSync, unlinkSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const LOCK_PATH = join(homedir(), '.orcstrator', 'dev.lock')
const DEBOUNCE_MS = 500
const POLL_INTERVAL_MS = 5_000

let serverProcess = null
let debounceTimer = null
let pollTimer = null
let restartQueued = false

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isLockActive() {
  if (!existsSync(LOCK_PATH)) return false
  try {
    const data = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'))
    if (data.pid && isProcessAlive(data.pid)) {
      return true
    }
    // Stale lock — PID is dead
    console.log(`[dev-watch] Stale lockfile (PID ${data.pid} dead) — removing`)
    unlinkSync(LOCK_PATH)
    return false
  } catch {
    // Corrupt lockfile — remove it
    try { unlinkSync(LOCK_PATH) } catch { /* ignore */ }
    return false
  }
}

function startServer() {
  console.log('[dev-watch] Starting server...')
  serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
    stdio: 'inherit',
    shell: true,
    cwd: import.meta.dirname,
  })

  serverProcess.on('exit', (code, signal) => {
    console.log(`[dev-watch] Server exited (code=${code}, signal=${signal})`)
    serverProcess = null
  })
}

function killServer() {
  return new Promise((resolve) => {
    if (!serverProcess) {
      resolve()
      return
    }
    console.log('[dev-watch] Killing server...')
    const proc = serverProcess
    const timeout = setTimeout(() => {
      console.log('[dev-watch] Force killing server...')
      proc.kill('SIGKILL')
      resolve()
    }, 10_000)

    proc.on('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    proc.kill('SIGTERM')
  })
}

async function restart() {
  if (isLockActive()) {
    if (!restartQueued) {
      restartQueued = true
      console.warn('[dev-watch] ⚠ Restart BLOCKED — orchestrator active (lockfile exists). Polling every 5s...')
      pollTimer = setInterval(async () => {
        if (!isLockActive()) {
          clearInterval(pollTimer)
          pollTimer = null
          restartQueued = false
          console.log('[dev-watch] Lock cleared — proceeding with restart')
          await killServer()
          startServer()
        } else {
          console.log('[dev-watch] Still locked — waiting...')
        }
      }, POLL_INTERVAL_MS)
    }
    return
  }

  restartQueued = false
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  await killServer()
  startServer()
}

function onFileChange(eventType, filename) {
  if (!filename) return
  // Ignore non-ts files and common noise
  if (!filename.endsWith('.ts') && !filename.endsWith('.json')) return

  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    console.log(`[dev-watch] File changed: ${filename}`)
    restart()
  }, DEBOUNCE_MS)
}

// Start the server immediately
startServer()

// Watch src/ directory recursively
const watchDir = join(import.meta.dirname, 'src')
try {
  watch(watchDir, { recursive: true }, onFileChange)
  console.log(`[dev-watch] Watching ${watchDir} for changes (lockfile-gated)`)
} catch (err) {
  console.error('[dev-watch] Failed to watch directory:', err)
}

// Forward SIGINT/SIGTERM to clean shutdown
async function shutdown() {
  console.log('[dev-watch] Shutting down...')
  if (debounceTimer) clearTimeout(debounceTimer)
  if (pollTimer) clearInterval(pollTimer)
  await killServer()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
