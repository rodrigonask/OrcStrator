import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { db } from '../db.js'

/**
 * Get the list of allowed root directories: user home, temp dir, and
 * all registered folder paths from the database.
 * Every entry is normalized via path.resolve() with path.sep separators.
 */
function getAllowedRoots(): string[] {
  const roots: string[] = [
    path.resolve(os.homedir()),
    path.resolve(os.tmpdir()),
  ]

  try {
    const folderRows = db.prepare('SELECT path FROM folders').all() as Array<{ path: string }>
    for (const r of folderRows) {
      const resolved = path.resolve(r.path)
      roots.push(resolved)
      // Also allow the parent so the folder picker can browse up to find new folders
      roots.push(path.dirname(resolved))
    }
  } catch {
    // DB may not have 'folders' table yet — allow home/temp only
  }

  return roots
}

/**
 * Check whether `targetPath` is under one of the allowed roots.
 * Uses path.relative() to detect escapes (e.g. ../../etc/passwd).
 * Normalizes both sides to handle Windows backslash/forward-slash mismatch.
 */
function isPathAllowed(targetPath: string, allowedRoots?: string[]): boolean {
  const resolved = path.resolve(targetPath)
  const roots = allowedRoots ?? getAllowedRoots()

  for (const root of roots) {
    const rel = path.relative(root, resolved)
    // rel must not start with '..' and must not be absolute (escape)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return true
    }
  }
  return false
}

export default async function fsRoutes(app: FastifyInstance): Promise<void> {
  // Browse directory contents
  app.get('/fs/browse', async (request) => {
    const { dir } = request.query as { dir?: string }
    const targetDir = dir || os.homedir()
    const resolved = path.resolve(targetDir)

    if (!isPathAllowed(resolved)) {
      throw { statusCode: 403, message: 'Path not in allowed directories' }
    }

    if (!fs.existsSync(resolved)) {
      throw { statusCode: 404, message: 'Directory not found' }
    }

    const stat = fs.statSync(resolved)
    if (!stat.isDirectory()) {
      throw { statusCode: 400, message: 'Path is not a directory' }
    }

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
      const items = entries
        .filter(e => !e.name.startsWith('.')) // Skip hidden files by default
        .map(e => ({
          name: e.name,
          path: path.join(resolved, e.name),
          isDirectory: e.isDirectory(),
          isFile: e.isFile()
        }))
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.name.localeCompare(b.name)
        })

      return { dir: resolved, items }
    } catch (err) {
      throw { statusCode: 403, message: 'Cannot read directory' }
    }
  })

  // List subdirectories only
  app.get('/fs/subfolders', async (request) => {
    const { dir } = request.query as { dir?: string }
    const targetDir = dir || os.homedir()
    const resolved = path.resolve(targetDir)

    if (!isPathAllowed(resolved)) {
      throw { statusCode: 403, message: 'Path not in allowed directories' }
    }

    if (!fs.existsSync(resolved)) {
      throw { statusCode: 404, message: 'Directory not found' }
    }

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
      const folders = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          path: path.join(resolved, e.name)
        }))
        .sort((a, b) => a.name.localeCompare(b.name))

      return { dir: resolved, folders }
    } catch {
      throw { statusCode: 403, message: 'Cannot read directory' }
    }
  })

  // Serve an image file with path security
  app.get('/fs/image', async (request, reply) => {
    const { path: filePath } = request.query as { path?: string }
    if (!filePath) {
      throw { statusCode: 400, message: 'Missing path parameter' }
    }

    const normalizedPath = path.resolve(filePath)

    // Security: validate against allowed roots using path.relative()
    if (!isPathAllowed(normalizedPath)) {
      throw { statusCode: 403, message: 'Path not in allowed directories' }
    }

    // Security: reject symlinks
    try {
      const realPath = fs.realpathSync(normalizedPath)
      if (realPath !== normalizedPath) {
        throw { statusCode: 403, message: 'Symlinks not allowed' }
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err) throw err
      throw { statusCode: 404, message: 'File not found' }
    }

    if (!fs.existsSync(normalizedPath)) {
      throw { statusCode: 404, message: 'File not found' }
    }

    // Determine content type
    const ext = path.extname(normalizedPath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.bmp': 'image/bmp'
    }

    const contentType = mimeTypes[ext] || 'application/octet-stream'
    const stream = fs.createReadStream(normalizedPath)
    reply.type(contentType)
    return reply.send(stream)
  })

  // Check if CLAUDE.md exists in a directory
  app.get('/fs/claude-md', async (request) => {
    const { dir } = request.query as { dir?: string }
    if (!dir) {
      throw { statusCode: 400, message: 'Missing dir parameter' }
    }

    const resolved = path.resolve(dir)

    if (!isPathAllowed(resolved)) {
      throw { statusCode: 403, message: 'Path not in allowed directories' }
    }

    const claudeMdPath = path.join(resolved, 'CLAUDE.md')
    const exists = fs.existsSync(claudeMdPath)

    let content: string | null = null
    if (exists) {
      try {
        content = fs.readFileSync(claudeMdPath, 'utf-8')
      } catch {
        // Can't read, but file exists
      }
    }

    const chars = content?.length ?? 0
    const estimatedTokens = Math.round(chars / 4)

    return {
      exists,
      path: claudeMdPath,
      content,
      chars,
      estimatedTokens,
      // Simple size warning for the UI
      sizeWarning: estimatedTokens > 3000
        ? `Your CLAUDE.md is ~${estimatedTokens.toLocaleString()} tokens. This is loaded into every agent session. Consider trimming it to speed up your agents.`
        : estimatedTokens > 1500
          ? `Your CLAUDE.md is ~${estimatedTokens.toLocaleString()} tokens. It is loaded into every agent session.`
          : null,
    }
  })

  // Write CLAUDE.md in a directory
  app.put('/fs/claude-md', async (request) => {
    const { dir } = request.query as { dir?: string }
    const { content } = request.body as { content?: string }

    if (!dir) throw { statusCode: 400, message: 'Missing dir parameter' }
    if (typeof content !== 'string') throw { statusCode: 400, message: 'Missing content in body' }

    const resolved = path.resolve(dir)

    if (!isPathAllowed(resolved)) {
      throw { statusCode: 403, message: 'Path not in allowed directories' }
    }

    const claudeMdPath = path.join(resolved, 'CLAUDE.md')
    try {
      fs.writeFileSync(claudeMdPath, content, 'utf-8')
    } catch {
      throw { statusCode: 500, message: 'Failed to write CLAUDE.md' }
    }

    return { ok: true, path: claudeMdPath }
  })
}
