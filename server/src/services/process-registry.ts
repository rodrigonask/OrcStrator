import type { ChildProcess } from 'child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { db } from '../db.js'
import { DATA_DIR } from '../config.js'
import { runQuiet, snapshotProcesses, descendantsOf, sameProcess, isClaudeImage, isPidAlive, hardKill, type ProcInfo, treeAfterRootDied } from './process-tree.js'
import { claimKind, killClaimChild, chatKey, chatsStarting, requestCancel, holds, spawnOf, beginStop, endStop, beginShutdown, killAllClaimChildren } from './turn-gate.js'

const ADOPTED_POLL_MS = Number(process.env.ORCSTRATOR_ADOPTED_POLL_MS) || 5000

// How far the OS's record of a process's start may sit from the moment this server saw it
// spawn. The spawn event fires within milliseconds of creation; 10 s absorbs a loaded machine.
const START_MATCH_SLACK_MS = 10_000

/**
 * Is `pid` still the agent a chat started? 'agent' only when the image is claude and,
 * where the spawn time was recorded, the process started at that time. 'stranger' when the PID
 * is now some other program. 'unknown' when the process table could not be read, which callers
 * must treat as "do not touch it".
 */
export function verifyAgentIdentity(pid: number, startedAt: number | null, snapshot: ProcInfo[] | null): 'agent' | 'stranger' | 'unknown' {
  if (!snapshot) return 'unknown'
  const p = snapshot.find(x => x.pid === pid)
  if (!p) return 'stranger'
  if (!isClaudeImage(p.name)) return 'stranger'
  if (startedAt != null && p.createdAt > 0 && Math.abs(p.createdAt - startedAt) > START_MATCH_SLACK_MS) return 'stranger'
  return 'agent'
}

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

/**
 * The order the kill path acted in, newest last, bounded. Read by the tests that hold the
 * mechanic to ROOT FIRST: 'root-dead' must come before any 'sweep-kill' of the same kill.
 */
export const killTrace: Array<{ step: 'snapshot' | 'root-dead' | 'root-survived' | 'sweep-kill'; pid: number; at: number }> = []
function trace(step: (typeof killTrace)[number]['step'], pid: number): void {
  killTrace.push({ step, pid, at: Date.now() })
  if (killTrace.length > 500) killTrace.splice(0, killTrace.length - 500)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Force-kill a process on Windows, ROOT FIRST. `taskkill /F /PID` on the
 * root claude.exe is unblockable and stops the agent in <1s even when a child
 * (e.g. an MCP server holding a Chrome handle) is slow to die. `taskkill /F /T`
 * by contrast kills children first and can be aborted by its own timeout before
 * it ever reaches the root — orphaning a live agent. So: kill the root directly,
 * THEN sweep descendants. Errors are swallowed; killProcess's verify loop is the
 * source of truth on whether the process actually died.
 *
 * Async: a stubborn kill used to hold the whole server, every chat's
 * streaming included, for up to 8 s per round.
 */
async function forceKillWindows(pid: number): Promise<void> {
  await runQuiet('taskkill', ['/F', '/PID', String(pid)], 4000)
  // No `/T` after it: TerminateProcess is asynchronous, so a `/T` straight after
  // could still reach the tree while the root was exiting, and kill, for an internal kill, the
  // detached jobs the agent is told survive. A user's Stop sweeps them from a snapshot instead.
}

export function isProcessAlive(pid: number): boolean {
  return isPidAlive(pid)
}

/**
 * The programs an agent started outlive it. `taskkill /T` after the root is dead
 * finds nothing ("root gone"), and a grandchild (a dev server or watcher the agent's shell
 * launched) is not in the root's kill-on-close job, so it keeps running, holding files and
 * ports. The tree is therefore read BEFORE the root is killed, and swept only AFTER the root
 * is confirmed dead. The order never changes: the root dying is what stops the agent, and
 * nothing here may delay or replace it.
 *
 * Only processes that are still the SAME process (same PID and same start time as in the
 * snapshot) are killed, plus anything they started after the snapshot was taken. Returns the
 * PIDs still alive afterwards (normally none).
 */
async function sweepDescendants(rootPid: number, before: ProcInfo[] | null, label: string, rootStartedAt?: number): Promise<number[]> {
  if (!before) {
    // The tree could not be read before the kill (a slow or failing process table). Read it now:
    // on Windows the programs the root started keep its PID as their parent after it dies. Only
    // those that started after the root did, so a program that inherited a recycled parent number
    // from some older process is never taken for one of ours.
    // With no start time for the root there is no telling ours from a stranger's: sweep nothing.
    const deadAt = Date.now()
    const after = rootStartedAt == null ? null : await snapshotProcesses()
    if (!after || rootStartedAt == null) {
      console.warn(`[process-registry] ${label}: no process snapshot before the kill${rootStartedAt == null ? ' and no start time for the agent' : ', and none after it'}; only the agent itself was stopped`)
      return []
    }
    before = treeAfterRootDied(rootPid, rootStartedAt, deadAt, after)
    console.warn(`[process-registry] ${label}: no snapshot before the kill, sweeping from one taken after it`)
  }
  const planned = descendantsOf(rootPid, before)
  if (planned.length === 0) return []
  const leftovers: number[] = []
  for (let round = 1; round <= 3; round++) {
    const now = await snapshotProcesses()
    if (!now) break
    const byPid = new Map(now.map(p => [p.pid, p]))
    // Still-running members of the planned set, then anything they started since.
    const targets = planned.filter(p => sameProcess(p, byPid.get(p.pid)))
    for (const t of targets) {
      for (const d of descendantsOf(t.pid, now)) if (!targets.some(x => x.pid === d.pid)) targets.push(d)
    }
    if (targets.length === 0) return []
    if (round === 1) console.log(`[process-registry] ${label}: sweeping ${targets.length} program(s) the agent started: ${targets.map(t => `${t.name}:${t.pid}`).join(', ')}`)
    for (const t of targets) { trace('sweep-kill', t.pid); hardKill(t.pid) }
    await delay(400)
    leftovers.length = 0
    for (const t of targets) if (isPidAlive(t.pid)) leftovers.push(t.pid)
    if (leftovers.length === 0) return []
    for (const t of targets) planned.includes(t) || planned.push(t)
  }
  if (leftovers.length) console.warn(`[process-registry] ${label}: ${leftovers.length} program(s) the agent started survived the sweep: ${leftovers.join(', ')}`)
  return leftovers
}

/** Kill the root PID and wait until it is gone. Root only; never the tree first. */
async function killRootAndVerify(pid: number, child: ChildProcess | null): Promise<boolean> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (!isProcessAlive(pid)) break
    if (process.platform === 'win32') {
      await forceKillWindows(pid)
    } else {
      hardKill(pid)
      try { child?.kill('SIGKILL') } catch { /* ignore */ }
    }
    if (child) await waitForExit(child, 1200)
    else await delay(500)
    if (!isProcessAlive(pid)) break
    await delay(300)
  }
  const dead = !isProcessAlive(pid)
  trace(dead ? 'root-dead' : 'root-survived', pid)
  return dead
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
  /** The PID the lock names, or null when there is no lock or it cannot be read. */
  private devLockOwner(): number | null {
    try {
      if (!existsSync(DEV_LOCK_PATH)) return null
      const pid = (JSON.parse(readFileSync(DEV_LOCK_PATH, 'utf8')) as { pid?: unknown }).pid
      return typeof pid === 'number' ? pid : null
    } catch { return null }
  }

  private syncDevLock(): void {
    try {
      if (this.registry.size > 0) {
        // A lock left by an earlier server (a crash skips the unlink) names a dead PID, which
        // dev-watch treats as stale and ignores: it is rewritten with this server's PID, or
        // chats running now would not hold a restart off. A lock
        // whose owner is still alive (a second server on the same data dir) is left alone: taking
        // it over would hand the watcher a dead PID the moment this server crashed.
        const owner = this.devLockOwner()
        if (owner === null || (owner !== process.pid && !isPidAlive(owner))) {
          writeFileSync(DEV_LOCK_PATH, JSON.stringify({ pid: process.pid, since: Date.now() }))
          console.log('[process-registry] dev.lock created — dev-server restart blocked while chats run')
        }
      } else if (existsSync(DEV_LOCK_PATH) && this.devLockOwner() === process.pid) {
        // Only this server's own lock: another live server's chats still hold theirs.
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

  /**
   * `child`: the process whose exit is being handled. When given, a DIFFERENT process now
   * registered for the chat is left alone: an old turn's late 'exit' used to
   * unregister the new turn that replaced it, leaving a live agent untracked.
   */
  unregisterProcess(instanceId: string, child?: ChildProcess): void {
    const tracked = this.registry.get(instanceId)
    if (tracked && child && tracked.child !== child) {
      console.log(`[process-registry] unregisterProcess: instance ${instanceId} now runs PID ${tracked.pid}, not exiting PID ${child.pid}; kept`)
      return
    }
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
  /**
   * `opts.sweep`: also end the programs the agent started. Only for a stop the USER
   * asked for (Stop, Pause, Force Reset, Renew, closing the chat, shutting the app). An
   * internal kill (the question hard stop, the idle timeout, a replaced turn) leaves them: the
   * agent is told that a detached job it launched survives the end of its turn.
   */
  private userStopHooks: Array<(instanceId: string) => void> = []

  /** Called on every stop the USER asked for (Stop, Pause, Reset, close, delete, shutdown). */
  onUserStop(fn: (instanceId: string) => void): void {
    this.userStopHooks.push(fn)
  }

  /**
   * `opts.appClosing`: the stop is the app shutting down or restarting, not the user stopping this
   * chat. The chat's own schedules (a pending wake-up) are kept for the next start, which re-arms
   * them; only the in-memory stop mark is set, and it dies with the process.
   */
  async killProcess(instanceId: string, opts: { sweep?: boolean; appClosing?: boolean } = {}): Promise<boolean> {
    if (!opts.sweep) return this.killProcessInner(instanceId, opts)
    // No new start may claim the chat while it is being stopped (see turn-gate beginStop).
    beginStop(chatKey(instanceId))
    try { return await this.killProcessInner(instanceId, opts) } finally { endStop(chatKey(instanceId)) }
  }

  /**
   * Stop these chats (a user's stop: Stop, Pause, Reset, close, delete) and run `then`, the
   * caller's own state writes, before any new start may claim them. Without the hold, a message
   * sent in between could start an agent that `then` marked idle or paused, or deleted the row of.
   */
  async stopThen<T>(ids: string[], then: (killed: boolean[]) => T | Promise<T>): Promise<T> {
    const keys = ids.map(chatKey)
    keys.forEach(beginStop)
    try {
      const killed = await Promise.all(ids.map(id => this.killProcess(id, { sweep: true })))
      return await then(killed)
    } finally {
      keys.forEach(endStop)
    }
  }

  /**
   * A user's stop of these chats, for callers that write the chats' state straight after it (no
   * await in between): the chats stay closed to new starts until that synchronous code has run.
   */
  async stopChats(ids: string[]): Promise<boolean[]> {
    const keys = ids.map(chatKey)
    keys.forEach(beginStop)
    try {
      return await Promise.all(ids.map(id => this.killProcess(id, { sweep: true })))
    } finally {
      // After the caller's continuation (a microtask), before any new request is read (I/O).
      setImmediate(() => keys.forEach(endStop))
    }
  }

  /**
   * Stop every chat `select()` returns (a project's, or all of them) for a bulk action that then
   * writes or deletes by that list. A chat created while the stop ran (a scheduled card opens a
   * new one) is stopped too, so the list the caller gets is complete at the moment it gets it,
   * and every chat on it stays closed to new starts until the caller's synchronous writes are
   * done. `failed`: chats on the list that could not be confirmed stopped (leave them alone).
   */
  async stopAll(select: () => string[], opts: { appClosing?: boolean } = {}): Promise<{ ids: string[]; failed: string[] }> {
    const held = new Set<string>()
    const failed = new Set<string>()
    try {
      for (let round = 0; round < 5; round++) {
        const fresh = select().filter(id => !held.has(id))
        if (fresh.length === 0) break
        for (const id of fresh) { held.add(id); beginStop(chatKey(id)) }
        const res = await Promise.all(fresh.map(id => this.killProcess(id, { sweep: true, appClosing: opts.appClosing })))
        fresh.forEach((id, i) => { if (!res[i]) failed.add(id) })
      }
      const ids = select()
      for (const id of ids) if (!held.has(id)) failed.add(id)
      return { ids, failed: [...failed].filter(id => ids.includes(id)) }
    } finally {
      setImmediate(() => held.forEach(id => endStop(chatKey(id))))
    }
  }

  private async killProcessInner(instanceId: string, opts: { sweep?: boolean; appClosing?: boolean }): Promise<boolean> {
    if (opts.sweep) {
      // The user stopped this chat: nothing may start it again on its own (queued /btw notes,
      // a pending wake-up, an automatic retry) until the user does.
      this.userStopped.set(instanceId, Date.now())
      if (!opts.appClosing) for (const fn of this.userStopHooks) { try { fn(instanceId) } catch (err) { console.error('[process-registry] user-stop hook failed:', err) } }
      // A turn being set up (claimed): cancel it, whether or not an older process is still
      // registered. With nothing registered, wait until the start has given up or registered
      // its process, which is then killed below. Without this a Stop in that window found
      // nothing, the chat was marked idle, and the spawn went ahead.
      if (claimKind(chatKey(instanceId)) === 'turn') {
        const key = chatKey(instanceId)
        const older = this.registry.get(instanceId)?.child
        const cancelled = requestCancel(key)
        // A pre-turn /compact runs under the turn's claim: end it so the start reaches its cancel check.
        await killClaimChild(key)
        // Wait on THIS start only. A message sent after it gave up is a new start the user
        // made after pressing Stop, and must not be killed by that earlier Stop.
        for (let i = 0; i < 300 && holds(key, cancelled) && !this.registry.has(instanceId); i++) await delay(100)
        if (!this.registry.has(instanceId) && holds(key, cancelled)) {
          console.error(`[process-registry] killProcess: the start on instance ${instanceId} did not give up in 30 s; NOT reported stopped`)
          return false
        }
        // Only this Stop's targets: the process the cancelled start registered, else the one
        // that was already running. A process registered by a later start is left alone.
        const target = spawnOf(cancelled) ?? older
        const now = this.registry.get(instanceId)
        if (now && now.child !== target) {
          console.log(`[process-registry] killProcess: instance ${instanceId} now runs PID ${now.pid}, started after this Stop; left running`)
          return false
        }
      }
    }
    const tracked = this.registry.get(instanceId)
    // A /compact runs outside the registry, under the chat's claim. Stop reaches it.
    if (!tracked && claimKind(chatKey(instanceId)) === 'compact') {
      const gone = await killClaimChild(chatKey(instanceId))
      console.log(`[process-registry] killProcess: stopped the /compact running on instance ${instanceId} (${gone ? 'confirmed dead' : 'SURVIVED'})`)
      if (!gone) return false
    }
    if (!tracked) {
      // Adopted process: the DB says it's running (startup reconciliation found the
      // PID alive after a server restart) but there's no ChildProcess handle here.
      // Returning true unconditionally — as this path used to — made /kill mark the
      // instance idle while the real claude.exe kept running and billing. Kill by
      // bare PID and report the truth instead.
      return this.killAdoptedByPid(instanceId, opts.sweep === true)
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
    // Its exit is the app's doing (Stop, a timeout, a replaced turn), not a CLI failure: the exit
    // handler must not tell the user the CLI "exited without starting a turn".
    this.stoppedByApp.add(child)

    // 1. For a user's Stop, read the process tree while the root is still alive, so
    //    the programs it started can be found after it is gone. This costs a few hundred ms
    //    before step 2 (bounded at 3 s); a failure only means no sweep, never no kill.
    const tree = opts.sweep && isProcessAlive(pid) ? await snapshotProcesses(3000) : null
    if (opts.sweep) trace('snapshot', pid)

    // 2. Verified kill loop, ROOT FIRST. Each round force-kills the root then confirms via
    //    isProcessAlive, NOT just the Node 'exit' event, which can be missed under a busy
    //    event loop.
    const confirmedDead = await killRootAndVerify(pid, child)
    if (confirmedDead) {
      // 3. Only now, with the agent confirmed dead, the programs it left behind.
      if (opts.sweep) await sweepDescendants(pid, tree, `instance ${instanceId.slice(0, 8)}`, tracked.spawnedAt)
      this.cleanup(instanceId, child)
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
  private async killAdoptedByPid(instanceId: string, sweep: boolean): Promise<boolean> {
    let pid: number | null = null
    let startedAt: number | null = null
    try {
      const row = db.prepare('SELECT process_pid, process_started_at FROM instances WHERE id = ?').get(instanceId) as { process_pid: number | null; process_started_at: number | null } | undefined
      pid = row?.process_pid ?? null
      startedAt = row?.process_started_at ?? null
    } catch { /* fall through — no PID means nothing to kill */ }

    if (!pid || !isProcessAlive(pid)) {
      console.log(`[process-registry] killProcess: instance ${instanceId} not tracked, no live PID — nothing to kill`)
      this.unwatchAdopted(instanceId)
      return true
    }

    // Is this PID still OUR agent, or a program that got the same number after
    // a reboot? Checked against the image name (claude only, never any node.exe) and the
    // start time recorded at spawn. Fails CLOSED: if the process table cannot be read,
    // nothing is killed and the chat is not marked stopped.
    const tree = await snapshotProcesses()
    const identity = verifyAgentIdentity(pid, startedAt, tree)
    if (identity === 'unknown') {
      console.warn(`[process-registry] killProcess: could not verify PID ${pid} (instance ${instanceId}) is our agent, NOT killing it`)
      return false
    }
    if (identity === 'stranger') {
      console.warn(`[process-registry] killProcess: PID ${pid} (instance ${instanceId}) now belongs to another program, agent already dead, killing nothing`)
      this.unwatchAdopted(instanceId)
      return true
    }

    console.log(`[process-registry] KILLING adopted instance ${instanceId} PID ${pid} (no handle — bare-PID kill)`)
    const confirmedDead = await killRootAndVerify(pid, null)
    if (!confirmedDead) {
      console.error(`[process-registry] CRITICAL: adopted PID ${pid} (instance ${instanceId}) survived kill — NOT marked idle`)
      return false
    }
    if (sweep) await sweepDescendants(pid, tree, `adopted instance ${instanceId.slice(0, 8)}`, startedAt ?? undefined)
    this.unwatchAdopted(instanceId)
    return true
  }

  // ── Adopted processes ──────────────────────────────────────────────
  // A process the previous server run started and this one found alive at boot. There is no
  // ChildProcess handle, so no 'exit' event: without a watcher the chat showed "running"
  // for ever after the agent finished. Polled; reset to idle when it is gone.
  private adopted = new Map<string, { pid: number; startedAt: number | null }>()
  private adoptedTimer: ReturnType<typeof setInterval> | null = null

  watchAdopted(instanceId: string, pid: number, startedAt: number | null, onGone: (instanceId: string) => void): void {
    this.adopted.set(instanceId, { pid, startedAt })
    if (this.adoptedTimer) return
    this.adoptedTimer = setInterval(() => {
      for (const [id, a] of [...this.adopted]) {
        if (isProcessAlive(a.pid)) continue
        this.adopted.delete(id)
        try { onGone(id) } catch (err) { console.error('[process-registry] adopted exit handler failed:', err) }
      }
      if (this.adopted.size === 0 && this.adoptedTimer) {
        clearInterval(this.adoptedTimer)
        this.adoptedTimer = null
      }
    }, ADOPTED_POLL_MS)
    this.adoptedTimer.unref?.()
  }

  unwatchAdopted(instanceId: string): void {
    this.adopted.delete(instanceId)
  }

  isAdopted(instanceId: string): boolean {
    return this.adopted.has(instanceId)
  }

  adoptedIds(): string[] {
    return [...this.adopted.keys()]
  }

  /**
   * The app is closing: every agent, including one still being set up. Such a start is not in the
   * registry yet, so killAll alone missed it and it spawned after "all processes confirmed dead".
   * It is cancelled, new starts are refused, and each start is
   * waited for until it gives up or registers its process, which killAll then reaches.
   */
  async shutdownAgents(): Promise<void> {
    beginShutdown()
    for (let i = 0; i < 150 && chatsStarting().length > 0; i++) await delay(100)
    if (chatsStarting().length > 0) console.warn(`[process-registry] shutdown: starts still pending on ${chatsStarting().join(', ')}`)
    await this.killAll()
    await killAllClaimChildren()
  }

  async killAll(): Promise<void> {
    const ids = [...this.registry.keys()]
    await Promise.all(ids.map(id => this.killProcess(id, { sweep: true, appClosing: true })))
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

  private stoppedByApp = new WeakSet<ChildProcess>()
  // Chats the USER stopped since their last start, and when. Queued /btw notes wait for the next
  // start the user makes, instead of starting a turn on their own right after a Stop. A wake-up or
  // retry armed BEFORE the stop is held; one armed after it (by a routine's own turn, say) is not.
  private userStopped = new Map<string, number>()

  wasStoppedByUser(instanceId: string): boolean {
    return this.userStopped.has(instanceId)
  }

  /** Was this chat stopped by the user at or after `since` (epoch ms)? */
  stoppedByUserSince(instanceId: string, since: number): boolean {
    const at = this.userStopped.get(instanceId)
    return at != null && at >= since
  }

  /** A new start by the user (or on the user's behalf) ends the "stopped" state. */
  clearUserStop(instanceId: string): void {
    this.userStopped.delete(instanceId)
  }

  /** Was this process stopped by the app (killProcess), rather than exiting on its own? */
  wasStoppedByApp(child: ChildProcess): boolean {
    return this.stoppedByApp.has(child)
  }

  /** Is `child` the process currently registered for this chat? */
  isCurrent(instanceId: string, child: ChildProcess): boolean {
    return this.registry.get(instanceId)?.child === child
  }

  private cleanup(instanceId: string, child?: ChildProcess): void {
    const tracked = this.registry.get(instanceId)
    if (tracked && child && tracked.child !== child) return
    if (tracked?.timeoutTimer) clearTimeout(tracked.timeoutTimer)
    this.registry.delete(instanceId)
    this.syncDevLock()
  }
}

export const processRegistry = new ProcessRegistry()

// ── The agent limit ─────────────────────────────────────────────────────────────
// "Max concurrent agents" had not been enforced since the orchestration layer was removed:
// canSpawn() existed and nothing called it. It is enforced now, but ONLY when the user turns
// the limit on (`maxConcurrentLimitOn`). Off is the default, for new and existing installs
// alike, so nothing that runs today starts queueing because of this change.
let LIMIT_ENFORCED = false

export function setAgentLimitEnforced(on: boolean): void {
  LIMIT_ENFORCED = on
  console.log(`[process-registry] Agent limit ${on ? `ON (${MAX_CONCURRENT_PROCESSES})` : 'off'}`)
}

export function isAgentLimitEnforced(): boolean {
  return LIMIT_ENFORCED
}

/**
 * May a turn start on `instanceId` now? Counts running agents (tracked and adopted) and turns
 * that are starting (claimed in turn-gate, not yet registered), leaving out `instanceId`
 * itself: a new turn on a chat replaces the one it runs, it does not add to it.
 */
export function agentSlot(instanceId: string): { ok: boolean; inUse: number; max: number } {
  if (!LIMIT_ENFORCED) return { ok: true, inUse: 0, max: MAX_CONCURRENT_PROCESSES }
  const busy = new Set<string>()
  for (const t of processRegistry.getProcessInfo()) busy.add(t.instanceId)
  for (const id of processRegistry.adoptedIds()) busy.add(id)
  for (const id of chatsStarting()) busy.add(id)
  busy.delete(instanceId)
  return { ok: busy.size < MAX_CONCURRENT_PROCESSES, inUse: busy.size, max: MAX_CONCURRENT_PROCESSES }
}

export class AgentLimitError extends Error {
  statusCode = 409
  constructor(inUse: number, max: number) {
    super(`${inUse} chats are already working, which is your limit of ${max}. Wait for one to finish, or raise the limit in Settings > Capacity.`)
  }
}

export function setMaxConcurrentProcesses(n: number): void {
  MAX_CONCURRENT_PROCESSES = Math.max(1, Math.min(n, 20))
  console.log(`[process-registry] Max concurrent processes set to ${MAX_CONCURRENT_PROCESSES}`)
}

export function getMaxConcurrentProcesses(): number {
  return MAX_CONCURRENT_PROCESSES
}
