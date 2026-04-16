import type { ChildProcess } from 'child_process'
import { execSync } from 'child_process'
import treeKill from 'tree-kill'
import { db } from '../db.js'

let MAX_CONCURRENT_PROCESSES = parseInt(process.env.ORCSTRATOR_MAX_PROCESSES || '8', 10)

type ProcessState = 'spawning' | 'running' | 'killing'

interface TrackedProcess {
  instanceId: string
  child: ChildProcess
  pid: number
  state: ProcessState
  spawnedAt: number
  timeoutTimer: ReturnType<typeof setTimeout> | null
}

function killProcessTree(child: ChildProcess, signal: string = 'SIGTERM'): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    treeKill(child.pid, signal, (err) => {
      if (err) console.warn(`[process-registry] tree-kill error for pid ${child.pid}:`, err.message)
    })
  } else {
    try { child.kill(signal as NodeJS.Signals) } catch { /* ignore */ }
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

  async killProcess(instanceId: string): Promise<void> {
    const tracked = this.registry.get(instanceId)
    if (!tracked) {
      console.log(`[process-registry] killProcess: instance ${instanceId} not tracked, skipping`)
      return
    }
    if (tracked.state === 'killing') {
      console.log(`[process-registry] killProcess: instance ${instanceId} PID ${tracked.pid} already being killed, waiting`)
      await waitForExit(tracked.child, 15_000)
      return
    }
    console.log(`[process-registry] KILLING instance ${instanceId} PID ${tracked.pid}`)
    tracked.state = 'killing'

    if (tracked.timeoutTimer) {
      clearTimeout(tracked.timeoutTimer)
      tracked.timeoutTimer = null
    }

    const { child, pid } = tracked

    // Attempt 1: SIGTERM via tree-kill
    killProcessTree(child, 'SIGTERM')
    if (await waitForExit(child, 5000)) { this.cleanup(instanceId); return }

    // Attempt 2: SIGKILL via tree-kill
    killProcessTree(child, 'SIGKILL')
    if (await waitForExit(child, 5000)) { this.cleanup(instanceId); return }

    // Attempt 3: Direct taskkill (Windows fallback)
    if (process.platform === 'win32') {
      try { execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000, stdio: 'ignore' }) } catch { /* ignore */ }
      if (await waitForExit(child, 3000)) { this.cleanup(instanceId); return }
    }

    // Attempt 4: Check if already dead (exit event not yet fired)
    if (!isProcessAlive(pid)) { this.cleanup(instanceId); return }

    // Give up — mark dead anyway, log CRITICAL
    console.error(`[process-registry] CRITICAL: PID ${pid} (instance ${instanceId}) unkillable after 15s`)
    this.cleanup(instanceId)
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
