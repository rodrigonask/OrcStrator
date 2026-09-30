import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import { checkLocalPath, isInsideProject, isReallyInsideProject, resolveLinksLocal } from '../services/safe-path.js'

// File access for the UI.
//
// Every route runs checkLocalPath FIRST: a network or device path is refused before any
// filesystem call, because on Windows merely checking that \\host\share exists sends the
// user's login hash to that host. Then:
//   - reading, writing and opening files is limited to registered project folders (it used
//     to be the whole drive, the home folder and the temp folder);
//   - the folder picker may list folder NAMES anywhere on this computer, and nothing else;
//   - opening never runs a program: anything that is not a plain document is shown in its
//     folder instead of being launched.
// The old /fs/image route is gone: nothing called it, and it served SVG files, scripts
// included, as live pages on the app's own address.

function refuse(statusCode: number, message: string): { statusCode: number; message: string } {
  return { statusCode, message }
}

/** A local path from a request, or throws the 400. */
function localPathOr400(input: unknown): string {
  const checked = checkLocalPath(input)
  if ('error' in checked) throw refuse(400, checked.error)
  return checked.path
}

/**
 * File types that open in their default app. Plain documents, images, media and source code
 * whose default handler is an editor or a viewer. Everything else (programs, scripts,
 * shortcuts, installers, .js/.py/.sh that Windows or an interpreter would RUN, web pages and
 * macro-capable formats) is shown in its folder instead.
 */
const OPENABLE = new Set([
  '.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.toml', '.xml',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf',
  '.mp4', '.mov', '.webm', '.mkv', '.mp3', '.wav', '.m4a', '.ogg',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp',
  '.ts', '.tsx', '.mts', '.cts', '.jsx', '.css', '.scss', '.less', '.vue', '.svelte',
  '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.sql', '.prisma', '.graphql', '.proto',
  '.ini', '.conf', '.env', '.gitignore', '.lock',
])

/** The extension Windows will act on: trailing dots and spaces are ignored by the OS ("x.bat." runs as .bat). */
export function effectiveExtension(p: string): string {
  return path.extname(path.basename(p).replace(/[. ]+$/, '')).toLowerCase()
}

export function isOpenableFile(p: string): boolean {
  return OPENABLE.has(effectiveExtension(p))
}

function launch(bin: string, args: string[]): void {
  const child = spawn(bin, args, { windowsHide: true, detached: true, stdio: 'ignore' })
  child.on('error', () => { /* no file manager: nothing to show */ })
  child.unref()
}

export default async function fsRoutes(app: FastifyInstance): Promise<void> {
  // List a project folder's contents. Nothing in the UI calls this today; it stays for
  // tools, limited to project folders.
  app.get('/fs/browse', async (request) => {
    const { dir } = request.query as { dir?: string }
    const resolved = localPathOr400(dir)
    if (!(isInsideProject(resolved) && isReallyInsideProject(resolved))) throw refuse(403, 'Only folders inside your projects can be listed.')
    if (!fs.existsSync(resolved)) throw refuse(404, 'Directory not found')
    if (!fs.statSync(resolved).isDirectory()) throw refuse(400, 'Path is not a directory')

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
    } catch {
      throw refuse(403, 'Cannot read directory')
    }
  })

  // The folder picker: folder NAMES only, anywhere on this computer, so a new project can be
  // chosen. No file names, no file contents.
  app.get('/fs/subfolders', async (request) => {
    const { dir } = request.query as { dir?: string }
    const resolved = dir ? localPathOr400(dir) : path.resolve(os.homedir())
    // A link on the way that leads to a network share is refused before anything follows it.
    if (!resolveLinksLocal(resolved)) throw refuse(400, 'That folder leads to a network path, which OrcStrator will not open.')
    if (!fs.existsSync(resolved)) throw refuse(404, 'Directory not found')

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
      throw refuse(403, 'Cannot read directory')
    }
  })

  // Check if CLAUDE.md exists in a project folder
  app.get('/fs/claude-md', async (request) => {
    const { dir } = request.query as { dir?: string }
    if (!dir) throw refuse(400, 'Missing dir parameter')
    const resolved = localPathOr400(dir)
    if (!(isInsideProject(resolved) && isReallyInsideProject(resolved))) throw refuse(403, 'Only a project folder\'s CLAUDE.md can be read here.')

    const claudeMdPath = path.join(resolved, 'CLAUDE.md')
    // CLAUDE.md itself can be a link out of the project; reading or writing would follow it.
    if (!isReallyInsideProject(claudeMdPath)) throw refuse(403, 'That CLAUDE.md leads outside your projects.')
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

  // Open a file or folder from a path link in chat. Plain documents inside a project open in
  // their default app; a folder opens in the file manager; anything else (a program, a
  // script, a file outside the projects) is shown selected in its folder and never launched.
  app.post('/fs/open', async (request, reply) => {
    const body = request.body as { path?: unknown } | undefined
    const target = body?.path
    if (typeof target !== 'string' || !target.trim()) {
      reply.code(400); return { ok: false, error: 'Missing path' }
    }
    if (/^[a-z][a-z0-9+.-]+:\/\//i.test(target.trim())) {
      reply.code(400); return { ok: false, error: 'URL scheme not allowed. Open web addresses in the browser instead.' }
    }
    // "file.ts:513" is how code gets cited in chat. Strip the citation BEFORE the path check
    // (a colon after the drive is otherwise read as an NTFS stream and refused).
    const cited = target.trim().replace(/:\d+(?::\d+)?$/, '')
    const checked = checkLocalPath(cited)
    if ('error' in checked) { reply.code(400); return { ok: false, error: checked.error } }
    const resolved = checked.path
    // Follow links ourselves first (readlink only): a link to a share never reaches existsSync,
    // and the file type that decides open-or-reveal is the one the link really leads to.
    const real = resolveLinksLocal(resolved)
    if (!real) { reply.code(400); return { ok: false, error: 'That path leads to a network share, which OrcStrator will not open.' } }
    if (!fs.existsSync(resolved)) {
      reply.code(404); return { ok: false, error: 'Path does not exist' }
    }

    const isDir = fs.statSync(resolved).isDirectory()
    const inProject = (isInsideProject(resolved) && isReallyInsideProject(resolved))
    const action: 'open' | 'reveal' = inProject && (isDir || isOpenableFile(resolved) && isOpenableFile(real)) ? 'open' : 'reveal'

    try {
      if (process.platform === 'win32') {
        // explorer.exe, NOT `cmd /c start`: a path holding a cmd metacharacter ("a&b") was
        // split at it, and `start` re-uses a window a background server may not raise.
        // `/select,<path>` shows the file highlighted in its folder without opening it.
        launch('explorer.exe', action === 'open' ? [resolved] : [`/select,${resolved}`])
      } else if (process.platform === 'darwin') {
        launch('open', action === 'open' ? [resolved] : ['-R', resolved])
      } else {
        launch('xdg-open', [action === 'open' ? resolved : path.dirname(resolved)])
      }
      return { ok: true, action }
    } catch (err) {
      reply.code(500); return { ok: false, error: `Failed to open: ${(err as Error).message}` }
    }
  })

  // Write CLAUDE.md in a project folder
  app.put('/fs/claude-md', async (request) => {
    const { dir } = request.query as { dir?: string }
    const { content } = (request.body ?? {}) as { content?: string }

    if (!dir) throw refuse(400, 'Missing dir parameter')
    if (typeof content !== 'string') throw refuse(400, 'Missing content in body')
    const resolved = localPathOr400(dir)
    if (!(isInsideProject(resolved) && isReallyInsideProject(resolved))) throw refuse(403, 'CLAUDE.md can only be written inside one of your projects.')

    const claudeMdPath = path.join(resolved, 'CLAUDE.md')
    // CLAUDE.md itself can be a link out of the project; reading or writing would follow it.
    if (!isReallyInsideProject(claudeMdPath)) throw refuse(403, 'That CLAUDE.md leads outside your projects.')
    try {
      fs.writeFileSync(claudeMdPath, content, 'utf-8')
    } catch {
      throw refuse(500, 'Failed to write CLAUDE.md')
    }

    return { ok: true, path: claudeMdPath }
  })
}
