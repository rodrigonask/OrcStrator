import { execFile } from 'child_process'

// ─────────────────────────────────────────────────────────────────────────────
// A snapshot of the machine's process table: who is whose parent, and when each
// process started. Used by the Stop path to find the programs an agent
// started, and by adoption after a restart to tell the agent that owned
// a PID apart from an unrelated program that was later given the same number.
//
// Windows 11 26200 has no `wmic`, so this asks CIM through PowerShell (~300 ms).
// Everything here is async: nothing on this path may block the event loop.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProcInfo {
  pid: number
  ppid: number
  /** Process creation time, epoch ms. 0 when the OS would not say. */
  createdAt: number
  /** Image name, lower case (claude.exe, node.exe, cmd.exe). */
  name: string
}

/** Run a program with no shell and a hard timeout. Never throws. */
export function runQuiet(file: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise(resolve => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        resolve({ ok: !err, stdout: String(stdout ?? '') })
      })
    } catch {
      resolve({ ok: false, stdout: '' })
    }
  })
}

const PS_SNAPSHOT =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object { " +
  "$c = 0; if ($_.CreationDate) { $c = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; " +
  "'{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $c, $_.Name }"

/**
 * The whole process table, or null when it could not be read in time. Callers must treat
 * null as "unknown", never as "nothing running".
 */
export async function snapshotProcesses(timeoutMs = 5000): Promise<ProcInfo[] | null> {
  if (process.platform === 'win32') {
    const r = await runQuiet('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SNAPSHOT], timeoutMs)
    if (!r.ok) return null
    const out: ProcInfo[] = []
    for (const line of r.stdout.split(/\r?\n/)) {
      const [pid, ppid, created, ...name] = line.trim().split('|')
      if (!pid || !/^\d+$/.test(pid)) continue
      out.push({ pid: Number(pid), ppid: Number(ppid) || 0, createdAt: Number(created) || 0, name: name.join('|').toLowerCase() })
    }
    return out.length > 0 ? out : null
  }
  const r = await runQuiet('ps', ['-eo', 'pid=,ppid=,etimes=,comm='], timeoutMs)
  if (!r.ok) return null
  const now = Date.now()
  const out: ProcInfo[] = []
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), createdAt: now - Number(m[3]) * 1000, name: m[4].trim().toLowerCase() })
  }
  return out.length > 0 ? out : null
}

// Creation times are compared with slack: CIM reports them to the millisecond, but ps only
// to the second, and a parent and the child it spawns can share a timestamp.
const CLOCK_SLACK_MS = 2000

/**
 * Every descendant of `rootPid` in the snapshot, nearest first. A PID is only followed from a
 * parent that is OLDER than it: Windows never re-parents, so a dead parent's number can be
 * reused by an unrelated process, and without this check that stranger's children would be
 * swept up as ours.
 */
/**
 * The process table read AFTER a root was killed, made safe to walk from that root. The root is
 * dead, so a process holding its number now is someone else's: it is replaced by the root as it
 * was. Its direct children count only if they started while it was alive (Windows keeps a dead
 * parent's PID on its children; comparing start times is how a reused PID is told apart).
 */
export function treeAfterRootDied(rootPid: number, rootStartedAt: number, deadAt: number, after: ProcInfo[]): ProcInfo[] {
  // Not after the root died, and not after a new process took its number (that one's children
  // are its own, however soon they came).
  // (A listed process with the root's number and start time is the root itself, still exiting.)
  const listed = after.find(p => p.pid === rootPid)
  const reused = listed && Math.abs(listed.createdAt - rootStartedAt) > CLOCK_SLACK_MS ? listed : undefined
  const until = Math.min(deadAt + CLOCK_SLACK_MS, reused ? reused.createdAt : Infinity)
  return [
    { pid: rootPid, ppid: -1, createdAt: rootStartedAt, name: 'root' },
    ...after.filter(p => p.pid !== rootPid && (p.ppid !== rootPid || (p.createdAt >= rootStartedAt - CLOCK_SLACK_MS && p.createdAt < until))),
  ]
}

export function descendantsOf(rootPid: number, snapshot: ProcInfo[]): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>()
  for (const p of snapshot) {
    if (p.pid === p.ppid) continue
    const list = byParent.get(p.ppid) ?? []
    list.push(p)
    byParent.set(p.ppid, list)
  }
  const root = snapshot.find(p => p.pid === rootPid)
  const out: ProcInfo[] = []
  const seen = new Set<number>([rootPid])
  const queue: Array<{ pid: number; createdAt: number }> = [{ pid: rootPid, createdAt: root?.createdAt ?? 0 }]
  while (queue.length) {
    const parent = queue.shift()!
    for (const child of byParent.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue
      if (parent.createdAt && child.createdAt && child.createdAt + CLOCK_SLACK_MS < parent.createdAt) continue
      seen.add(child.pid)
      out.push(child)
      queue.push({ pid: child.pid, createdAt: child.createdAt })
    }
  }
  return out
}

/** True when `now` describes the same process as `then` (same PID, same start time). */
export function sameProcess(then: Pick<ProcInfo, 'pid' | 'createdAt'>, now: ProcInfo | undefined): boolean {
  if (!now || now.pid !== then.pid) return false
  if (!then.createdAt || !now.createdAt) return false
  return Math.abs(now.createdAt - then.createdAt) <= CLOCK_SLACK_MS
}

/** The agent binary's image name: claude.exe on Windows, claude elsewhere. Nothing else. */
export function isClaudeImage(name: string | undefined): boolean {
  if (!name) return false
  return /^claude(\.exe)?$/i.test(name.trim())
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, we just may not signal it.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** Terminate one PID now (TerminateProcess on Windows, SIGKILL elsewhere). Never throws. */
export function hardKill(pid: number): void {
  try { process.kill(pid, 'SIGKILL') } catch { /* gone, or not ours to kill */ }
}
