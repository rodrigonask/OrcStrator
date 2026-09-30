/**
 * Resolves the path to the native `claude` binary (the official Claude Code CLI).
 *
 * Resolution order:
 *   1. `process.env.ORCSTRATOR_CLAUDE_PATH` — explicit override (must point to an existing file).
 *   2. PATH lookup (scans `process.env.PATH` for `claude.exe` / `claude`).
 *   3. Native-installer default fallback location:
 *       - Windows: `%USERPROFILE%\.local\bin\claude.exe`
 *       - macOS/Linux: `~/.local/bin/claude`
 *
 * The legacy npm-global shim (`claude.cmd` under `%APPDATA%\npm`) is NOT preferred.
 * If only that shim is on PATH the resolver will still return it (we don't filter),
 * but the install hint nudges the user toward the native installer.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'

let cached: { path: string | null; hint: string } | null = null

const INSTALL_HINT = process.platform === 'win32'
  ? 'Install with: irm https://claude.ai/install.ps1 | iex'
  : 'Install with: curl -fsSL https://claude.ai/install.sh | bash'

function existsAsFile(p: string): boolean {
  try {
    const st = fs.statSync(p)
    return st.isFile()
  } catch {
    return false
  }
}

/**
 * The first `claude` on PATH that can actually be spawned.
 *
 * On Windows that means `claude.exe`, searched across EVERY PATH directory before anything else.
 * The old loop was directory-first and took `claude.cmd` whenever its directory came earlier, and
 * Node 22 refuses to spawn a `.cmd` without a shell (EINVAL), so a user with the npm-installed
 * Claude earlier on PATH got a failure on every chat. A `.cmd` shim is never returned: if that is
 * all there is, the caller falls through to the native install location, and then to the install
 * hint, which is a clear message instead of a broken spawn.
 *
 * Pure (PATH, platform and the file check are parameters) so the order can be tested.
 */
export function findClaudeOnPath(
  pathEnv: string,
  platform: NodeJS.Platform,
  isFile: (p: string) => boolean,
): string | null {
  const sep = platform === 'win32' ? ';' : ':'
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  const name = platform === 'win32' ? 'claude.exe' : 'claude'
  for (const dir of pathEnv.split(sep)) {
    const d = dir.trim()
    if (!d) continue
    const full = join(d, name)
    if (isFile(full)) return full
  }
  return null
}

function searchPath(): string | null {
  return findClaudeOnPath(process.env.PATH || process.env.Path || '', process.platform, existsAsFile)
}

function fallbackLocation(): string {
  const home = os.homedir()
  return process.platform === 'win32'
    ? path.join(home, '.local', 'bin', 'claude.exe')
    : path.join(home, '.local', 'bin', 'claude')
}

/**
 * Returns the absolute path to the native claude binary, or null if nothing was found.
 * Result is cached for the lifetime of the process.
 */
/** "C:\x", "C:/x", "\\server\x" or "\\?\..." on Windows; "/x" elsewhere. Not "\x" or "C:x". */
export function isFullyQualified(p: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? /^([A-Za-z]:[\\/]|\\\\)/.test(p) : p.startsWith('/')
}

/** A pin the launcher could have written: fully qualified and, on Windows, a plain ".exe" with no
 *  stream ":" (spawn runs "x.com" or "x.exe" for an extensionless "x", and runs from a stream). */
export function isPinnable(p: string, platform: NodeJS.Platform): boolean {
  if (!isFullyQualified(p, platform)) return false
  if (platform !== 'win32') return true
  const rest = p.replace(/^\\\\[?.]\\/, '')
  return /\.exe$/i.test(p) && rest.indexOf(':', 2) === -1
}

export function resolveClaudeBinary(): { path: string | null; hint: string } {
  if (cached) return cached

  // 1. Explicit env override. The installed launcher sets it to the claude.exe whose Anthropic
  //    signature it verified, or to a path that is not a file when it refused the one it
  //    found. Either way it is final: never fall back to some other, unverified copy.
  //    Only a fully qualified path: "\tools\claude.exe" or "C:tools\claude.exe" means one file
  //    here and another once a turn spawns it from a project on a different drive or folder.
  const override = process.env.ORCSTRATOR_CLAUDE_PATH
  if (override) {
    cached = { path: isPinnable(override, process.platform) && existsAsFile(override) ? override : null, hint: INSTALL_HINT }
    return cached
  }

  // 2. PATH lookup: the native .exe in any PATH directory; a .cmd shim is never spawned
  const onPath = searchPath()
  if (onPath) {
    cached = { path: onPath, hint: INSTALL_HINT }
    return cached
  }

  // 3. Native-installer default location
  const fallback = fallbackLocation()
  if (existsAsFile(fallback)) {
    cached = { path: fallback, hint: INSTALL_HINT }
    return cached
  }

  cached = { path: null, hint: INSTALL_HINT }
  return cached
}

/**
 * Runs `<resolved> --version` with a tight timeout to confirm the binary actually executes
 * and to surface its version string in startup logs. Resolves with the trimmed stdout, or
 * null on any failure (timeout, non-zero exit, spawn error). Never throws.
 */
export function probeClaudeVersion(binPath: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      resolve(v)
    }
    try {
      const child = execFile(binPath, ['--version'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (err) return finish(null)
        const out = (stdout || '').toString().trim()
        finish(out || null)
      })
      // Hard kill if execFile's own timeout misbehaves
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish(null)
      }, timeoutMs + 500).unref()
    } catch {
      finish(null)
    }
  })
}

// What a person sees in the chat when there is no usable Claude binary. The install hint
// (irm ..., ORCSTRATOR_CLAUDE_PATH) goes to the server log instead.
export const CLAUDE_MISSING_MESSAGE = 'Claude AI is not set up on this computer. Go back to the OrcStrator window and click Restart.'
