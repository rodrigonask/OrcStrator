import fs from 'fs'
import path from 'path'
import { snapshotProcesses, isPidAlive } from './services/process-tree.js'

// ─────────────────────────────────────────────────────────────────────────────
// One server per data dir.
//
// Nothing stopped a second server (a stray `npm run dev`, a second installed copy, a script
// that boots the app) from opening the same database. Two servers double-fire routines,
// fight over running cost totals and each believe they own every chat's process.
//
// The lock is a file created exclusively in the data dir, holding the owner's PID and start
// time. A lock whose PID is dead, or whose PID now belongs to a different process (same
// number, different start time), is stale and taken over. A live owner is waited for briefly
// (dev-watch kills the old server and starts the new one back to back), then refused.
// ─────────────────────────────────────────────────────────────────────────────

export const LOCK_FILE = 'server.lock'

interface LockBody { pid: number; startedAt: number; port?: number; at: number }

export class DataDirLockedError extends Error {
  constructor(public holderPid: number, lockPath: string) {
    super(`Another OrcStrator server (PID ${holderPid}) is already using this data folder (${path.dirname(lockPath)}). Close it first, or point this one at a different folder with ORCSTRATOR_DATA_DIR.`)
  }
}

/** This process's start time, epoch ms. */
function ownStart(): number {
  return Math.round(Date.now() - process.uptime() * 1000)
}

let held: string | null = null

function readLock(lockPath: string): LockBody | null {
  try {
    const b = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockBody
    return typeof b.pid === 'number' ? b : null
  } catch {
    return null
  }
}

/** Is the lock's owner the live process it names? Fails towards "yes" when it cannot tell. */
async function ownerAlive(body: LockBody): Promise<boolean> {
  if (!isPidAlive(body.pid)) return false
  const snap = await snapshotProcesses()
  if (!snap) return true
  const p = snap.find(x => x.pid === body.pid)
  if (!p) return false
  // A PID reused by another program after a crash: same number, a different start.
  if (body.startedAt && p.createdAt && Math.abs(p.createdAt - body.startedAt) > 5000) return false
  return true
}

function tryCreate(lockPath: string, port?: number): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx')
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: ownStart(), port, at: Date.now() } satisfies LockBody))
    fs.closeSync(fd)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/**
 * Remove the stale lock `seen` IF this process wins the takeover mutex (server.lock.takeover,
 * exclusive create) and the lock is still exactly that stale file. Returns true when it removed
 * it; the caller then competes for a fresh lock with the ordinary exclusive create. A mutex
 * left by a process that crashed mid-takeover is itself cleared after 10 s.
 */
function takeStale(lockPath: string, seen: LockBody | null): boolean {
  const mutex = `${lockPath}.takeover`
  let fd: number
  const mine = `${process.pid}:${Date.now()}:${Math.random()}`
  try {
    fd = fs.openSync(mutex, 'wx')
    fs.writeSync(fd, mine)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    try { if (Date.now() - fs.statSync(mutex).mtimeMs > 10_000) fs.unlinkSync(mutex) } catch { /* gone */ }
    return false
  }
  try {
    const now = readLock(lockPath)
    // An unreadable lock only counts as stale while it is still old: a fresh one may be another
    // server between creating the file and writing its PID into it.
    let old = true
    if (!seen) { try { old = Date.now() - fs.statSync(lockPath).mtimeMs >= 3000 } catch { return false } }
    const same = seen ? (now !== null && now.pid === seen.pid && now.at === seen.at) : (now === null && old)
    if (!same) return false
    try { fs.unlinkSync(lockPath) } catch { return false }
    return true
  } finally {
    fs.closeSync(fd)
    // Only our own mutex: if a slow process cleared ours as abandoned and made its own, that
    // one is not ours to remove.
    try { if (fs.readFileSync(mutex, 'utf8') === mine) fs.unlinkSync(mutex) } catch { /* gone */ }
  }
}

/**
 * Take the data dir's lock or throw DataDirLockedError. Idempotent within one process.
 * `waitMs`: how long a live owner is given to exit (a dev-watch restart) before refusing.
 */
export async function acquireDataDirLock(dataDir: string, opts: { port?: number; waitMs?: number } = {}): Promise<void> {
  const lockPath = path.join(dataDir, LOCK_FILE)
  if (held === lockPath) return
  const waitMs = opts.waitMs ?? Number(process.env.ORCSTRATOR_LOCK_WAIT_MS ?? 10_000)
  const deadline = Date.now() + waitMs
  // A stale lock that cannot be removed (permissions, a folder in its place) must end in an
  // error, not a boot that spins for ever.
  const staleDeadline = Date.now() + Math.max(waitMs, 10_000) + 20_000
  for (;;) {
    if (tryCreate(lockPath, opts.port)) break
    const body = readLock(lockPath)
    // Our own lock only if it also started when we did. A crashed server's lock can carry our
    // PID after a reuse; adopting it as-is kept the dead server's start time in the file, and
    // the next server then judged our live lock stale and took it.
    if (body?.pid === process.pid && Math.abs((body.startedAt ?? 0) - ownStart()) <= 5000) break
    if (Date.now() > staleDeadline) {
      throw new Error(`Could not take over the lock file ${lockPath}, left by a server that is no longer running. Close OrcStrator, delete that file, and start it again.`)
    }
    if (!body) {
      // Unreadable: either a crashed half-write or another server between creating the file
      // and writing its PID. Give a fresh file a moment before calling it stale.
      let age = Infinity
      try { age = Date.now() - fs.statSync(lockPath).mtimeMs } catch { continue }
      if (age < 3000) { await new Promise(r => setTimeout(r, 200)); continue }
    }
    if (!body || !(await ownerAlive(body))) {
      // Stale: the owner is gone. Two servers can find the same stale file at once, and a
      // read-then-delete lets the slower one delete the faster one's fresh lock, after which
      // both own the folder. So the takeover itself is done under a second exclusive file:
      // only its holder may remove the stale lock, and only while it is still that stale file.
      if (takeStale(lockPath, body)) console.warn(`[lock] ${lockPath} was left by an earlier server (PID ${body?.pid ?? '?'}) that is no longer running; taken over`)
      else await new Promise(r => setTimeout(r, 100 + Math.random() * 150))
      continue
    }
    if (Date.now() >= deadline) throw new DataDirLockedError(body.pid, lockPath)
    await new Promise(r => setTimeout(r, 500))
  }
  held = lockPath
  const releaseOnExit = () => releaseDataDirLock()
  process.once('exit', releaseOnExit)
}

/** Remove the lock if this process holds it. */
export function releaseDataDirLock(): void {
  if (!held) return
  const lockPath = held
  held = null
  try {
    const body = readLock(lockPath)
    if (body?.pid === process.pid) fs.unlinkSync(lockPath)
  } catch { /* best effort */ }
}

/** For scripts: is a live server holding this data dir right now? */
export async function dataDirLockHolder(dataDir: string): Promise<number | null> {
  const body = readLock(path.join(dataDir, LOCK_FILE))
  if (!body || body.pid === process.pid) return null
  return (await ownerAlive(body)) ? body.pid : null
}
