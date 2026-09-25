import fs from 'fs'
import path from 'path'

/**
 * Resolve a path to its true on-disk casing.
 *
 * Windows filesystems are case-insensitive but case-PRESERVING, so `C:\Code\foo` and
 * `C:\code\foo` open the same directory while comparing as different strings. Claude
 * Code's worktree guard compares the worktree path it recorded at EnterWorktree time
 * against the path git resolves, and git always reports the real casing. A cwd stored with
 * the wrong case therefore makes every later `--resume` fail with:
 *
 *   cannot resume into worktree <recorded>: git resolves its working tree to <real>
 *   (a core.worktree redirect ...). This session was not started.
 *
 * The CLI exits 1 before emitting a result event, so the turn dies silently and the chat
 * looks frozen. See the exit handler in
 * claude-process.ts, which now persists a message row so this can never be invisible again.
 *
 * CASE-ONLY BY DESIGN: realpath also resolves junctions and symlinks. A code folder is typically full
 * of `node_modules` junctions, and silently rewriting a path to a junction TARGET would
 * relocate a session (or a delete) somewhere the user never named. So when realpath differs
 * by anything more than case, the original string is returned untouched.
 */
const cache = new Map<string, string>()

export function canonicalizeCwd(input: string): string {
  if (!input || typeof input !== 'string') return input
  const hit = cache.get(input)
  if (hit !== undefined) return hit

  const result = resolve(input)
  cache.set(input, result)
  return result
}

function resolve(input: string): string {
  // Walk up to the longest ancestor that exists on disk, canonicalize that, then re-append
  // the segments that don't exist yet (a not-yet-created worktree dir, say).
  let head = input
  const tail: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync.native(head)
      // More than a case difference (junction/symlink) — leave the caller's path alone.
      if (real.toLowerCase() !== head.toLowerCase()) return input
      return tail.length ? path.join(real, ...tail) : real
    } catch {
      const parent = path.dirname(head)
      if (parent === head) return input // reached the root without finding anything real
      tail.unshift(path.basename(head))
      head = parent
    }
  }
}
