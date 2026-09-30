// One set of rules for every path a request hands the server.
//
// The rule that matters most: a network or device path is refused BEFORE anything touches
// the filesystem. On Windows even an existence check on \\host\share makes the machine open
// an SMB connection and offer the user's login hash to that host, so the check has to be a
// string check on the raw input and on its resolved form, never exists/stat/realpath.
// Resolving first catches the other spellings of the same thing: //host/share,
// \\?\UNC\host, \\.\device, \??\ and WebDAV host@port forms all come out starting with \\.

import fs from 'fs'
import path from 'path'
import { db } from '../db.js'

const NT_PREFIX = /^[\\/]{2}[?.][\\/]|^[\\/]\?\?[\\/]/

/** True for a network share, a device or NT-namespace path, however it is spelled. Pure string work. */
export function isNetworkOrDevicePath(input: string): boolean {
  const raw = input.trim()
  if (/^[\\/]{2}/.test(raw) || NT_PREFIX.test(raw)) return true
  if (process.platform === 'win32') {
    const resolved = path.win32.resolve(raw)
    if (/^[\\/]{2}/.test(resolved)) return true
  }
  return false
}

/**
 * The first thing every path-taking route calls. Returns the resolved absolute path, or an
 * error for a 400. Makes no filesystem call.
 */
export function checkLocalPath(input: unknown): { path: string } | { error: string } {
  if (typeof input !== 'string' || !input.trim()) return { error: 'A path is required.' }
  const raw = input.trim()
  if (raw.includes('\0')) return { error: 'That is not a valid path.' }
  if (isNetworkOrDevicePath(raw)) return { error: 'Network and device paths are not allowed. Use a folder on this computer.' }
  if (!path.isAbsolute(raw)) return { error: 'The path must be a full path, for example C:\\code\\app.' }
  if (process.platform === 'win32') {
    // No drive letter: relative to whatever drive is current.
    if (/^[\\/](?![\\/])/.test(raw)) return { error: 'The path must include a drive letter, for example C:\\code\\app.' }
    // A colon after the drive is an NTFS stream (file.txt:hidden.exe), not a name.
    if (raw.slice(2).includes(':')) return { error: 'That is not an ordinary file path.' }
  }
  return { path: path.resolve(raw) }
}

/** True when `child` is `parent` or inside it. Case-insensitive on Windows. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** True when the path is the root of a drive or of the filesystem. */
export function isFilesystemRoot(p: string): boolean {
  // "C:" alone is a drive (path.resolve would read it as "the current folder on C:").
  if (/^[a-zA-Z]:[\\/]*$/.test(p.trim()) || /^[\\/]+$/.test(p.trim())) return true
  const resolved = path.resolve(p)
  return path.parse(resolved).root.replace(/[\\/]+$/, '') === resolved.replace(/[\\/]+$/, '')
}

/** The registered project folders that can be trusted as roots: local, absolute, not a drive root. */
export function projectRoots(opts: { includeHidden?: boolean } = {}): string[] {
  let rows: Array<{ path: string | null; hidden?: number }> = []
  try {
    rows = db.prepare(`SELECT path, hidden FROM folders`).all() as Array<{ path: string | null; hidden: number }>
  } catch {
    try { rows = db.prepare('SELECT path FROM folders').all() as Array<{ path: string | null }> } catch { rows = [] }
  }
  const roots: string[] = []
  for (const r of rows) {
    if (!r.path || (!opts.includeHidden && r.hidden)) continue
    const checked = checkLocalPath(r.path)
    if ('error' in checked || isFilesystemRoot(checked.path)) continue
    roots.push(checked.path)
  }
  return roots
}

/** True when the path is inside a registered project folder. */
export function isInsideProject(p: string): boolean {
  return projectRoots({ includeHidden: true }).some(root => isInside(root, p))
}

/**
 * Where a path really leads, following symlinks and junctions one component at a time
 * (a junction inside a project reached outside it). Each link
 * is read with readlink, which does not open its target, so a link to a network share is
 * refused (null) before anything contacts that host. Parts that do not exist yet are kept as
 * written. Only call this on a path that already passed checkLocalPath.
 */
export function resolveLinksLocal(p: string): string | null {
  let done = path.parse(path.resolve(p)).root
  let remaining = path.resolve(p).slice(done.length).split(/[\\/]/).filter(Boolean)
  let hops = 0
  while (remaining.length) {
    const next = path.join(done, remaining.shift()!)
    let st: fs.Stats
    try { st = fs.lstatSync(next) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null // locked or unreadable: refuse, do not guess
      // A junction to a network share reads as "does not exist" (lstat ENOENT, readlink EINVAL)
      // although its parent lists it. Windows will not follow
      // it, but it is refused rather than treated as a new name.
      try { if (fs.readdirSync(done).some(n => n.toLowerCase() === path.basename(next).toLowerCase())) return null } catch { /* parent unreadable */ }
      return path.join(next, ...remaining)
    }
    if (!st.isSymbolicLink()) { done = next; continue }
    if (++hops > 40) return null
    let target: string
    try { target = fs.readlinkSync(next) } catch { return null }
    // A symlink may store its local target as \\?\C:\...; that is a local path, not a device.
    target = target.replace(/^\\\\\?\\([A-Za-z]:\\)/, '$1')
    if (isNetworkOrDevicePath(target)) return null
    const abs = path.resolve(path.dirname(next), target)
    if (isNetworkOrDevicePath(abs)) return null
    done = path.parse(abs).root
    remaining = [...abs.slice(done.length).split(/[\\/]/).filter(Boolean), ...remaining]
  }
  return done
}

/** isInsideProject, on where the path really leads rather than how it is spelled. */
export function isReallyInsideProject(p: string): boolean {
  const real = resolveLinksLocal(p)
  if (!real) return false
  return projectRoots({ includeHidden: true }).some(root => isInside(resolveLinksLocal(root) ?? root, real))
}
