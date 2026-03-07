import type { ChildProcess } from 'child_process'
import { execSync } from 'child_process'
import treeKill from 'tree-kill'
import { db } from '../db.js'

const MAX_CONCURRENT_PROCESSES = parseInt(process.env.ORCSTRATOR_MAX_PROCESSES || '8', 10)

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
  private registry = new Map<string, TrackedProcess>()
  private folderLocks = new Map<string, Promise<void>>()
  private adoptedPids = new Map<string, number>()  // instanceId → pid (from previous server run)
  private reservations = new Set<string>()  // instanceIds with reserved spawn slots

  registerProcess(instanceId: string, child: ChildProcess): void {
    // If somehow already tracked (shouldn't happen), clean up first
    const existing = this.registry.get(instanceId)
    if (existing) {
      console.warn(`[process-registry] registerProcess: instance ${instanceId} already tracked (PID ${existing.pid}), replacing`)
      if (existing.timeoutTimer) clearTimeout(existing.timeoutTimer)
    }

    this.reservations.delete(instanceId) // reservation fulfilled
    console.log(`[process-registry] REGISTER instance ${instanceId} PID ${child.pid} | active=${this.registry.size + 1} adopted=${this.adoptedPids.size}`)
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
      console.log(`[process-registry] UNREGISTER instance ${instanceId} PID ${tracked.pid} | active=${this.registry.size - 1} adopted=${this.adoptedPids.size}`)
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

  adoptProcess(instanceId: string, pid: number): void {
    console.log(`[process-registry] ADOPT instance ${instanceId} PID ${pid} | active=${this.registry.size} adopted=${this.adoptedPids.size + 1}`)
    this.adoptedPids.set(instanceId, pid)
  }

  isAdopted(instanceId: string): boolean {
    return this.adoptedPids.has(instanceId)
  }

  sweepAdopted(): string[] {
    if (this.adoptedPids.size === 0) return []
    const dead: string[] = []
    for (const [instanceId, pid] of this.adoptedPids) {
      const alive = isProcessAlive(pid)
      if (!alive) {
        console.log(`[process-registry] ADOPTED DEAD: instance ${instanceId} PID ${pid} no longer alive`)
        this.adoptedPids.delete(instanceId)
        dead.push(instanceId)
      }
    }
    if (this.adoptedPids.size > 0) {
      console.log(`[process-registry] sweepAdopted: ${this.adoptedPids.size} still alive, ${dead.length} dead`)
    }
    return dead
  }

  isRunning(instanceId: string): boolean {
    return this.registry.has(instanceId) || this.adoptedPids.has(instanceId)
  }

  getActiveCount(): number {
    return this.registry.size + this.adoptedPids.size + this.reservations.size
  }

  canSpawn(): boolean {
    const total = this.registry.size + this.adoptedPids.size + this.reservations.size
    const can = total < MAX_CONCURRENT_PROCESSES
    if (!can) {
      console.warn(`[process-registry] canSpawn=false: ${total}/${MAX_CONCURRENT_PROCESSES} (registry=${this.registry.size} adopted=${this.adoptedPids.size} reserved=${this.reservations.size})`)
    }
    return can
  }

  reserveSlot(instanceId: string): boolean {
    const total = this.registry.size + this.adoptedPids.size + this.reservations.size
    if (total >= MAX_CONCURRENT_PROCESSES) {
      console.warn(`[process-registry] reserveSlot DENIED for ${instanceId}: ${total}/${MAX_CONCURRENT_PROCESSES}`)
      return false
    }
    this.reservations.add(instanceId)
    console.log(`[process-registry] reserveSlot OK for ${instanceId} | reserved=${this.reservations.size}`)
    return true
  }

  releaseSlot(instanceId: string): void {
    if (this.reservations.delete(instanceId)) {
      console.log(`[process-registry] releaseSlot for ${instanceId} | reserved=${this.reservations.size}`)
    }
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

  /**
   * Find instances marked 'running' in DB but with no tracked process — zombies.
   */
  detectZombies(): string[] {
    try {
      const running = db.prepare("SELECT id FROM instances WHERE state = 'running'").all() as { id: string }[]
      return running.filter(r => !this.registry.has(r.id) && !this.adoptedPids.has(r.id)).map(r => r.id)
    } catch {
      return []
    }
  }

  /**
   * Promise-chain mutex per folder. Prevents concurrent assignWork calls for the same folder.
   */
  async acquireFolderLock(folderId: string): Promise<() => void> {
    const existing = this.folderLocks.get(folderId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    // Timeout guard to prevent deadlock (60s)
    const timedNext = Promise.race([
      next,
      new Promise<void>(resolve => setTimeout(() => {
        console.error(`[process-registry] Folder lock timeout for ${folderId}`)
        resolve()
      }, 60_000))
    ])
    this.folderLocks.set(folderId, timedNext)
    await existing
    return release
  }

  private cleanup(instanceId: string): void {
    const tracked = this.registry.get(instanceId)
    if (tracked?.timeoutTimer) clearTimeout(tracked.timeoutTimer)
    this.registry.delete(instanceId)
  }
}

export const processRegistry = new ProcessRegistry()
