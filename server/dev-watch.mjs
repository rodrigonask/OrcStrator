#!/usr/bin/env node
/**
 * Lockfile-gated dev watcher for OrcStrator server.
 * Replaces `tsx watch` to prevent restarts while a chat is running.
 *
 * Behavior:
 * - Spawns `npx tsx src/index.ts`
 * - Watches `server/src/` for file changes
 * - On change: checks <data dir>/dev.lock before restarting. The data dir is
 *   ORCSTRATOR_DATA_DIR when set, else ~/.orcstrator-v2, exactly as the server
 *   resolves it (src/config.ts), so the lock it writes is the lock read here.
 * - If lockfile exists with alive PID: queues restart, polls every 5s
 * - If lockfile exists with dead PID: treats as stale, deletes it, proceeds
 * - If the PID is alive but provably no longer the server that wrote the lock (it is not
 *   a node process, or it started after the lock was written): stale too
 * - 500ms debounce on file changes
 */

import { spawn, execSync, execFileSync } from 'child_process'
import { existsSync, readFileSync, unlinkSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

const DATA_DIR = process.env.ORCSTRATOR_DATA_DIR || join(homedir(), '.orcstrator-v2')
const LOCK_PATH = join(DATA_DIR, 'dev.lock')
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

// The lock's `since` is stamped by the server after it has been running for a while, so a
// genuine owner always started well before it. This slack only absorbs clock rounding.
const START_SLACK_MS = 2_000

/**
 * The program name and start time (ms since epoch) of a live PID, or null when the OS
 * cannot tell us (the lookup failed, access was denied, the PID just exited). Null always
 * means "keep trusting the lock": this decides whether a running chat's server may be
 * killed, so only a positive answer is allowed to unblock a restart.
 */
function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, windowsHide: true }
  try {
    if (process.platform === 'win32') {
      const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.ProcessName + '|' + ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()`
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], opts).trim()
      const sep = out.lastIndexOf('|')
      const name = out.slice(0, sep)
      const startedAt = Number(out.slice(sep + 1))
      return sep > 0 && Number.isFinite(startedAt) && startedAt > 0 ? { name, startedAt } : null
    }
    const name = basename(execFileSync('ps', ['-p', String(pid), '-o', 'comm='], opts).trim())
    const startedAt = Date.parse(execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], opts).trim())
    return name && Number.isFinite(startedAt) ? { name, startedAt } : null
  } catch {
    return null
  }
}

/**
 * A live PID alone does not mean the lock's owner is still running. After a crash
 * the lock stays behind, Windows hands the same PID to some other program, and the old check
 * then blocked every restart until someone deleted the file by hand. Returns why the lock
 * is stale, or null when it must still be honoured (including when we simply cannot tell).
 */
function reusedPidReason(data) {
  const info = processInfo(data.pid)
  if (!info) return null
  // The name test is Windows-only: there the server is always node.exe. Elsewhere a process
  // can rename its own thread (ps then shows that name), so only the start time is trusted.
  if (process.platform === 'win32' && !/node/i.test(info.name)) {
    return `PID ${data.pid} now belongs to "${info.name}", not the server`
  }
  if (typeof data.since === 'number' && info.startedAt > data.since + START_SLACK_MS) {
    return `PID ${data.pid} is a newer process, started after the lock was written`
  }
  return null
}

function isLockActive() {
  if (!existsSync(LOCK_PATH)) return false
  try {
    const data = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'))
    if (data.pid && isProcessAlive(data.pid)) {
      const reused = reusedPidReason(data)
      if (!reused) return true
      console.log(`[dev-watch] Stale lockfile (${reused}), removing`)
      unlinkSync(LOCK_PATH)
      return false
    }
    // Stale lock: PID is dead
    console.log(`[dev-watch] Stale lockfile (PID ${data.pid} dead), removing`)
    unlinkSync(LOCK_PATH)
    return false
  } catch {
    // Corrupt lockfile: remove it
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
    const pid = proc.pid
    let settled = false
    const finish = () => { if (settled) return; settled = true; clearTimeout(timeout); resolve() }

    // On Windows, proc.kill() only signals the `npx`/cmd.exe wrapper, NOT the
    // tsx/node server underneath it, which keeps holding port 3334. The restart
    // then spawns a server that can't bind, so the STALE server keeps serving
    // (edits never apply). Tree-kill the wrapper's whole process tree instead.
    const treeKill = () => {
      if (process.platform === 'win32' && pid) {
        try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }) } catch { /* already gone */ }
      } else {
        try { proc.kill('SIGKILL') } catch { /* ignore */ }
      }
    }

    const timeout = setTimeout(() => {
      console.log('[dev-watch] Force killing server...')
      treeKill()
      finish()
    }, 10_000)

    proc.on('exit', finish)
    treeKill()
  })
}

async function restart() {
  if (isLockActive()) {
    if (!restartQueued) {
      restartQueued = true
      console.warn('[dev-watch] ⚠ Restart BLOCKED: a chat is running (lockfile exists). Polling every 5s...')
      pollTimer = setInterval(async () => {
        if (!isLockActive()) {
          clearInterval(pollTimer)
          pollTimer = null
          restartQueued = false
          console.log('[dev-watch] Lock cleared, proceeding with restart')
          await killServer()
          startServer()
        } else {
          console.log('[dev-watch] Still locked, waiting...')
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

// Watch src/ for changes. We POLL mtimes instead of fs.watch: on Windows, recursive
// fs.watch silently drops events (it missed live server edits for an entire 9h session,
// leaving the server running stale code). Polling is bulletproof and src/ is small.
const watchDir = join(import.meta.dirname, 'src')

function collectMtimes(dir, acc) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) collectMtimes(full, acc)
    else if (e.name.endsWith('.ts') || e.name.endsWith('.json')) {
      try { acc.set(full, statSync(full).mtimeMs) } catch { /* file vanished mid-scan */ }
    }
  }
  return acc
}

let lastMtimes = collectMtimes(watchDir, new Map())
setInterval(() => {
  const now = collectMtimes(watchDir, new Map())
  let changed = null
  for (const [f, m] of now) {
    if (lastMtimes.get(f) !== m) { changed = f; break }   // added or modified
  }
  if (!changed) {
    for (const f of lastMtimes.keys()) { if (!now.has(f)) { changed = f; break } }  // deleted
  }
  lastMtimes = now
  if (changed) onFileChange('change', changed)
}, 600)
console.log(`[dev-watch] Polling ${watchDir} every 600ms for changes (lockfile-gated)`)

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
