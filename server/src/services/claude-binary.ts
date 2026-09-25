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

function searchPath(): string | null {
  const PATH = process.env.PATH || process.env.Path || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const candidates = process.platform === 'win32'
    ? ['claude.exe', 'claude.cmd']
    : ['claude']
  for (const dir of PATH.split(sep)) {
    if (!dir) continue
    for (const name of candidates) {
      const full = path.join(dir.trim(), name)
      if (existsAsFile(full)) return full
    }
  }
  return null
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
export function resolveClaudeBinary(): { path: string | null; hint: string } {
  if (cached) return cached

  // 1. Explicit env override
  const override = process.env.ORCSTRATOR_CLAUDE_PATH
  if (override && existsAsFile(override)) {
    cached = { path: override, hint: INSTALL_HINT }
    return cached
  }

  // 2. PATH lookup — prefer the native .exe over the .cmd shim
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
