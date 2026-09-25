// Close-time worktree orphan check.
//
// A session that creates a git worktree and is then closed takes with it the only
// context that knows what the worktree was FOR. The directory survives, the branch
// survives, and months later it is an unmergeable pile nobody can explain. This finds
// them BEFORE the close, deterministically, without asking the agent to remember.
//
// The chain is entirely on disk:
//   instances.session_id  ->  ~/.claude/projects/<cwd-slug>/<session_id>.jsonl
//   the transcript records every EnterWorktree/ExitWorktree tool RESULT verbatim
//   created minus removed  =  what this session is about to abandon
//
// The slug is the cwd with every : \ / . turned into a dash, but the file also moves
// when a session writes from inside a worktree, so the derived path is only a fast
// path and a full scan of the projects directory is the fallback.
import fs from 'fs'
import path from 'path'
import os from 'os'
import readline from 'readline'
import { execFile } from 'child_process'

export interface WorktreeOrphan {
  /** Absolute path of the worktree directory, as the transcript recorded it. */
  path: string
  name: string
  branch: string
  /** Still registered in `git worktree list` (false = husk directory git forgot). */
  registered: boolean
  /** Uncommitted files inside it. */
  dirty: number
  /** Commits not on its upstream. -1 when it has no upstream at all, which is worse. */
  unpushed: number
}

export interface WorktreeOrphanScan {
  /** false = no transcript to read, so the check says nothing rather than guessing. */
  checked: boolean
  orphans: WorktreeOrphan[]
}

const EMPTY: WorktreeOrphanScan = { checked: false, orphans: [] }

/** Windows path + JSON escaping: the transcript stores C:\\code\\x for C:\code\x. */
function unescapeJsonPath(s: string): string {
  return s.replace(/\\\\/g, '\\').replace(/\\"/g, '"').trim()
}

function slugForCwd(cwd: string): string {
  return cwd.replace(/[:\\/.]/g, '-')
}

/** The transcript for a session id, or null. Derived path first, full scan second. */
function findTranscript(cwd: string, sessionId: string): string | null {
  const root = path.join(os.homedir(), '.claude', 'projects')
  const direct = path.join(root, slugForCwd(cwd), `${sessionId}.jsonl`)
  if (fs.existsSync(direct)) return direct
  let dirs: string[]
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return null
  }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`)
    if (fs.existsSync(p)) return p
  }
  return null
}

const CREATED = /Created worktree at (.+?) on branch ([^\s\\"]+)/
// The removal line continues "... <path>. Discarded 1 commit." or "... <path>. Session is
// now back in ...", so the path ends at the first dot followed by one of those two words.
// A plain non-greedy dot would stop inside ".claude".
const REMOVED = /Exited and removed worktree at (.+?)\.(?: Discarded| Session)/

async function readTranscriptWorktrees(file: string): Promise<{ created: Map<string, string>; removed: Set<string> }> {
  const created = new Map<string, string>()   // path -> branch
  const removed = new Set<string>()
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of rl) {
      // Substring guard first: parsing or regexing every line of a multi-megabyte
      // transcript is the difference between 40ms and several seconds.
      if (line.indexOf('worktree at ') === -1) continue
      const c = CREATED.exec(line)
      // "on branch <name>. The session is now..." so the sentence's full stop rides
      // along. A ref cannot end in a dot, so stripping it is always right.
      if (c) created.set(unescapeJsonPath(c[1]), c[2].replace(/\.+$/, ''))
      const r = REMOVED.exec(line)
      if (r) removed.add(unescapeJsonPath(r[1]))
    }
  } finally {
    rl.close()
  }
  return { created, removed }
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

async function registeredWorktrees(cwd: string): Promise<Set<string>> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain'])
  const set = new Set<string>()
  if (!out) return set
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) set.add(path.resolve(line.slice(9).trim()).toLowerCase())
  }
  return set
}

/**
 * Worktrees this session created and did not remove, that are still on disk.
 *
 * Reports only. Never removes anything, and never looks at worktrees another session
 * created: the transcript is the attribution, so a sibling's worktree is invisible here.
 */
export async function scanWorktreeOrphans(cwd: string, sessionId: string | null): Promise<WorktreeOrphanScan> {
  if (!cwd || !sessionId) return EMPTY
  const file = findTranscript(cwd, sessionId)
  if (!file) return EMPTY

  let created: Map<string, string>
  let removed: Set<string>
  try {
    ({ created, removed } = await readTranscriptWorktrees(file))
  } catch {
    return EMPTY
  }
  if (created.size === 0) return { checked: true, orphans: [] }

  const registered = await registeredWorktrees(cwd)
  const orphans: WorktreeOrphan[] = []

  for (const [wtPath, branch] of created) {
    if (removed.has(wtPath)) continue
    // Gone from disk entirely: the harness cleaned it, or it never survived. Nothing
    // to warn about, because there is nothing left to forget.
    if (!fs.existsSync(wtPath)) continue

    const status = await git(wtPath, ['status', '--porcelain'])
    const dirty = status === null ? 0 : status.split('\n').filter(l => l.trim()).length
    const ahead = await git(wtPath, ['rev-list', '--count', '@{u}..HEAD'])
    const unpushed = ahead === null ? -1 : parseInt(ahead.trim(), 10) || 0

    orphans.push({
      path: wtPath,
      name: path.basename(wtPath),
      branch,
      registered: registered.has(path.resolve(wtPath).toLowerCase()),
      dirty,
      unpushed,
    })
  }

  return { checked: true, orphans }
}
