import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { db } from '../db.js'

export default async function fsRoutes(app: FastifyInstance): Promise<void> {
  // Browse directory contents
  app.get('/fs/browse', async (request) => {
    const { dir } = request.query as { dir?: string }
    const targetDir = dir || os.homedir()

    if (!fs.existsSync(targetDir)) {
      throw { statusCode: 404, message: 'Directory not found' }
    }

    const stat = fs.statSync(targetDir)
    if (!stat.isDirectory()) {
      throw { statusCode: 400, message: 'Path is not a directory' }
    }

    try {
      const entries = fs.readdirSync(targetDir, { withFileTypes: true })
      const items = entries
        .filter(e => !e.name.startsWith('.')) // Skip hidden files by default
        .map(e => ({
          name: e.name,
          path: path.join(targetDir, e.name),
          isDirectory: e.isDirectory(),
          isFile: e.isFile()
        }))
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.name.localeCompare(b.name)
        })

      return { dir: targetDir, items }
    } catch (err) {
      throw { statusCode: 403, message: 'Cannot read directory' }
    }
  })

  // List subdirectories only
  app.get('/fs/subfolders', async (request) => {
    const { dir } = request.query as { dir?: string }
    const targetDir = dir || os.homedir()

    if (!fs.existsSync(targetDir)) {
      throw { statusCode: 404, message: 'Directory not found' }
    }

    try {
      const entries = fs.readdirSync(targetDir, { withFileTypes: true })
      const folders = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          path: path.join(targetDir, e.name)
        }))
        .sort((a, b) => a.name.localeCompare(b.name))

      return { dir: targetDir, folders }
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

    // Security: reject paths with .. traversal
    if (filePath.includes('..')) {
      throw { statusCode: 403, message: 'Path traversal not allowed' }
    }

    // Security: reject symlinks
    try {
      const realPath = fs.realpathSync(filePath)
      if (realPath !== path.resolve(filePath)) {
        throw { statusCode: 403, message: 'Symlinks not allowed' }
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err) throw err
      throw { statusCode: 404, message: 'File not found' }
    }

    // Security: only allow files under home, temp, or registered folder paths
    const normalizedPath = path.resolve(filePath)
    const homeDir = os.homedir()
    const tempDir = os.tmpdir()

    // Get registered folder paths from DB
    const folderRows = db.prepare('SELECT path FROM folders').all() as Array<{ path: string }>
    const registeredPaths = folderRows.map(r => path.resolve(r.path))

    const isAllowed =
      normalizedPath.startsWith(homeDir) ||
      normalizedPath.startsWith(tempDir) ||
      registeredPaths.some(p => normalizedPath.startsWith(p))

    if (!isAllowed) {
      throw { statusCode: 403, message: 'Path not in allowed directories' }
    }

    if (!fs.existsSync(filePath)) {
      throw { statusCode: 404, message: 'File not found' }
    }

    // Determine content type
    const ext = path.extname(filePath).toLowerCase()
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
    const stream = fs.createReadStream(filePath)
    reply.type(contentType)
    return reply.send(stream)
  })

  // Check if CLAUDE.md exists in a directory
  app.get('/fs/claude-md', async (request) => {
    const { dir } = request.query as { dir?: string }
    if (!dir) {
      throw { statusCode: 400, message: 'Missing dir parameter' }
    }

    const claudeMdPath = path.join(dir, 'CLAUDE.md')
    const exists = fs.existsSync(claudeMdPath)

    let content: string | null = null
    if (exists) {
      try {
        content = fs.readFileSync(claudeMdPath, 'utf-8')
      } catch {
        // Can't read, but file exists
      }
    }

    return { exists, path: claudeMdPath, content }
  })
}
