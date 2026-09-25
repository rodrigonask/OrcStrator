import type { ChildProcess } from 'child_process'
import { execSync } from 'child_process'
import { existsSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import treeKill from 'tree-kill'
import { db } from '../db.js'
import { DATA_DIR } from '../config.js'

let MAX_CONCURRENT_PROCESSES = parseInt(process.env.ORCSTRATOR_MAX_PROCESSES || '8', 10)

// dev-watch.mjs reads this lockfile and refuses to restart the dev server while
// it exists with a live PID — so an in-flight chat turn isn't tree-killed by a
// source edit. The previous writer lived in the (since-removed) orchestrator
// service; the registry is now the single chokepoint that knows when any chat
// process is alive, so it owns the lock. Harmless in prod (no watcher reads it).
const DEV_LOCK_PATH = join(DATA_DIR, 'dev.lock')

type ProcessState = 'spawning' | 'running' | 'killing'

interface TrackedProcess {
  instanceId: string
  child: ChildProcess
  pid: number
  state: ProcessState
  spawnedAt: number
  timeoutTimer: ReturnType<typeof setTimeout> | null
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Force-kill a process tree on Windows, ROOT FIRST. `taskkill /F /PID` on the
 * root claude.exe is unblockable and stops the agent in <1s even when a child
 * (e.g. an MCP server holding a Chrome handle) is slow to die. `taskkill /F /T`
 * by contrast kills children first and can be aborted by its own timeout before
 * it ever reaches the root — orphaning a live agent. So: kill the root directly,
 * THEN sweep descendants. Errors are swallowed; killProcess's verify loop is the
 * source of truth on whether the process actually died.
 */
function forceKillWindows(pid: number): void {
  try { execSync(`taskkill /F /PID ${pid}`, { timeout: 4000, stdio: 'ignore' }) } catch { /* verified by caller */ }
  try { execSync(`taskkill /F /T /PID ${pid}`, { timeout: 4000, stdio: 'ignore' }) } catch { /* best-effort child sweep */ }
}

/**
 * PID-reuse guard for bare-PID kills: true only when the PID's image name looks
 * like an agent process (claude/node). Fail-open on lookup errors — a kill
 * attempt on a stale agent beats silently leaving one running.
 */
function looksLikeAgentProcess(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { timeout: 4000 }).toString()
      const image = (out.split(',')[0] || '').replace(/"/g, '').toLowerCase()
      return image.includes('claude') || image.includes('node')
    }
    const out = execSync(`ps -p ${pid} -o comm=`, { timeout: 4000 }).toString().toLowerCase()
    return out.includes('claude') || out.includes('node')
  } catch {
    return true
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.killed) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, timeoutMs)

    function onExit() {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

class ProcessRegistry {
  // In-memory registry: ChildProcess handles can't be stored in DB
  private registry = new Map<string, TrackedProcess>()

  /**
   * Keep ~/.orcstrator-v2/dev.lock in sync with whether any chat process is
   * live. Present (with this server's PID) ⇒ dev-watch blocks restarts; absent
   * ⇒ restarts proceed. Called after every registry size change. Best-effort —
   * a failed write just means a restart isn't blocked, never a crash.
   */
  private syncDevLock(): void {
    try {
      if (this.registry.size > 0) {
        if (!existsSync(DEV_LOCK_PATH)) {
          writeFileSync(DEV_LOCK_PATH, JSON.stringify({ pid: process.pid, since: Date.now() }))
          console.log('[process-registry] dev.lock created — dev-server restart blocked while chats run')
        }
      } else if (existsSync(DEV_LOCK_PATH)) {
        unlinkSync(DEV_LOCK_PATH)
        console.log('[process-registry] dev.lock removed — no chats running, restart allowed')
      }
    } catch (err) {
      console.warn('[process-registry] dev.lock sync error:', (err as Error).message)
    }
  }

  registerProcess(instanceId: string, child: ChildProcess): void {
    const existing = this.registry.get(instanceId)
    if (existing) {
      console.warn(`[process-registry] registerProcess: instance ${instanceId} already tracked (PID ${existing.pid}), replacing`)
      if (existing.timeoutTimer) clearTimeout(existing.timeoutTimer)
    }

    console.log(`[process-registry] REGISTER instance ${instanceId} PID ${child.pid} | tracked=${this.registry.size + 1}`)
    this.registry.set(instanceId, {
      instanceId,
      child,
      pid: child.pid!,
      state: 'running',
      spawnedAt: Date.now(),
      timeoutTimer: null,
    })
    this.syncDevLock()
  }

  unregisterProcess(instanceId: string): void {
    const tracked = this.registry.get(instanceId)
    if (tracked) {
      console.log(`[process-registry] UNREGISTER instance ${instanceId} PID ${tracked.pid} | tracked=${this.registry.size - 1}`)
      if (tracked.timeoutTimer) clearTimeout(tracked.timeoutTimer)
    } else {
      console.warn(`[process-registry] unregisterProcess: instance ${instanceId} not tracked`)
    }
    this.registry.delete(instanceId)
    this.syncDevLock()
  }

  setTimeoutTimer(instanceId: string, timer: ReturnType<typeof setTimeout>): void {
    const tracked = this.registry.get(instanceId)
    if (tracked) tracked.timeoutTimer = timer
  }

  /** Write data to a running process's stdin (for interactive prompts like login/permissions) */
  writeStdin(instanceId: string, data: string): boolean {
    const tracked = this.registry.get(instanceId)
    if (!tracked || tracked.state === 'killing') return false
    try {
      tracked.child.stdin?.write(data)
      return true
    } catch (err) {
      console.warn(`[process-registry] writeStdin error [${instanceId.slice(0, 8)}]:`, (err as Error).message)
      return false
    }
  }

  /**
   * Kill an instance's process tree and CONFIRM the root is dead before
   * returning. Returns true if confirmed terminated, false if it somehow
   * survived every attempt — in which case the caller MUST NOT mark the
   * instance stopped (see /pause, /kill), because the agent is still running.
   */
  async killProcess(instanceId: string): Promise<boolean> {
    const tracked = this.registry.get(instanceId)
    if (!tracked) {
      // Adopted process: the DB says it's running (startup reconciliation found the
      // PID alive after a server restart) but there's no ChildProcess handle here.
      // Returning true unconditionally — as this path used to — made /kill mark the
      // instance idle while the real claude.exe kept running and billing. Kill by
      // bare PID and report the truth instead.
      return this.killAdoptedByPid(instanceId)
    }
    if (tracked.state === 'killing') {
      console.log(`[process-registry] killProcess: instance ${instanceId} PID ${tracked.pid} already being killed, waiting`)
      await waitForExit(tracked.child, 15_000)
      return !isProcessAlive(tracked.pid)
    }
    console.log(`[process-registry] KILLING instance ${instanceId} PID ${tracked.pid}`)
    tracked.state = 'killing'

    if (tracked.timeoutTimer) {
      clearTimeout(tracked.timeoutTimer)
      tracked.timeoutTimer = null
    }

    const { child, pid } = tracked

    // Verified kill loop. Each round force-kills (root-first on Windows) then
    // confirms via isProcessAlive — NOT just the Node 'exit' event, which can be
    // missed under a busy event loop. The first round almost always wins;
    // retries cover children that spawned after a prior sweep enumerated the tree.
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (!isProcessAlive(pid)) break
      if (process.platform === 'win32') {
        forceKillWindows(pid)
      } else {
        treeKill(pid, 'SIGKILL', () => {})
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }
      await waitForExit(child, 1200)
      if (!isProcessAlive(pid)) break
      await delay(300)
    }

    const confirmedDead = !isProcessAlive(pid)
    if (confirmedDead) {
      this.cleanup(instanceId)
    } else {
      // Previously this logged CRITICAL, then cleanup()'d and let the caller mark
      // the instance idle — orphaning a live claude.exe while the UI said
      // "stopped" (the "stop button does nothing" bug). Instead keep it tracked
      // and running so the UI stays truthful and a retry / force-reset can act.
      tracked.state = 'running'
      console.error(`[process-registry] CRITICAL: PID ${pid} (instance ${instanceId}) survived kill — left tracked, NOT marked idle`)
    }
    return confirmedDead
  }

  /**
   * Kill an adopted process we only know by its DB-recorded PID (no ChildProcess
   * handle — it was spawned by a previous server run). Guards against PID reuse:
   * if the PID's image name isn't a claude/node process, the agent is already
   * gone and something unrelated now holds that PID — report dead, kill nothing.
   */
  private async killAdoptedByPid(instanceId: string): Promise<boolean> {
    let pid: number | null = null
    try {
      const row = db.prepare('SELECT process_pid FROM instances WHERE id = ?').get(instanceId) as { process_pid: number | null } | undefined
      pid = row?.process_pid ?? null
    } catch { /* fall through — no PID means nothing to kill */ }

    if (!pid || !isProcessAlive(pid)) {
      console.log(`[process-registry] killProcess: instance ${instanceId} not tracked, no live PID — nothing to kill`)
      return true
    }
    if (!looksLikeAgentProcess(pid)) {
      console.warn(`[process-registry] killProcess: PID ${pid} (instance ${instanceId}) is alive but not a claude/node process — PID reused, agent already dead`)
      return true
    }

    console.log(`[process-registry] KILLING adopted instance ${instanceId} PID ${pid} (no handle — bare-PID kill)`)
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (!isProcessAlive(pid)) break
      if (process.platform === 'win32') {
        forceKillWindows(pid)
      } else {
        treeKill(pid, 'SIGKILL', () => {})
      }
      await delay(500)
    }

    const confirmedDead = !isProcessAlive(pid)
    if (!confirmedDead) {
      console.error(`[process-registry] CRITICAL: adopted PID ${pid} (instance ${instanceId}) survived kill — NOT marked idle`)
    }
    return confirmedDead
  }

  async killAll(): Promise<void> {
    const ids = [...this.registry.keys()]
    await Promise.all(ids.map(id => this.killProcess(id)))
  }

  /** Check if an instance has an active ChildProcess handle in the in-memory registry */
  isTracked(instanceId: string): boolean {
    return this.registry.has(instanceId)
  }

  /** Count of active processes (from DB — single source of truth) */
  getActiveCount(): number {
    try {
      const row = db.prepare(
        "SELECT COUNT(*) as count FROM instances WHERE process_state IN ('reserved', 'spawning', 'running')"
      ).get() as { count: number }
      return row.count
    } catch {
      return this.registry.size // fallback
    }
  }

  /** Check if we can spawn another process (DB-based count) */
  canSpawn(): boolean {
    const total = this.getActiveCount()
    const can = total < MAX_CONCURRENT_PROCESSES
    if (!can) {
      console.warn(`[process-registry] canSpawn=false: ${total}/${MAX_CONCURRENT_PROCESSES}`)
    }
    return can
  }

  /**
   * Return snapshot of all tracked processes for monitoring UI.
   */
  getProcessInfo(): Array<{ instanceId: string; pid: number; state: ProcessState; spawnedAt: number; runningSec: number }> {
    const now = Date.now()
    return [...this.registry.values()].map(t => ({
      instanceId: t.instanceId,
      pid: t.pid,
      state: t.state,
      spawnedAt: t.spawnedAt,
      runningSec: Math.round((now - t.spawnedAt) / 1000),
    }))
  }

  private cleanup(instanceId: string): void {
    const tracked = this.registry.get(instanceId)
    if (tracked?.timeoutTimer) clearTimeout(tracked.timeoutTimer)
    this.registry.delete(instanceId)
    this.syncDevLock()
  }
}

export const processRegistry = new ProcessRegistry()

export function setMaxConcurrentProcesses(n: number): void {
  MAX_CONCURRENT_PROCESSES = Math.max(1, Math.min(n, 20))
  console.log(`[process-registry] Max concurrent processes set to ${MAX_CONCURRENT_PROCESSES}`)
}

export function getMaxConcurrentProcesses(): number {
  return MAX_CONCURRENT_PROCESSES
}
