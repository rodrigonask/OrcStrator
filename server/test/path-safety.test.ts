// Every route that takes a path refuses a network
// or device path with a 400 BEFORE any filesystem call (an fs spy proves it: on Windows even
// an existence check on \\host\share sends the login hash to that host); files are read,
// written and opened only inside project folders; opening never launches a program; the
// SVG-serving image route is gone; a session id is never turned into a path unless it is a
// real session id.
//
//   npx tsx server/test/path-safety.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { syncBuiltinESMExports } from 'module'
import { scratchApp, check, done } from './helpers/scratch-app.js'

// ── spies, installed before any route module loads ─────────────────────────────────────
const require = createRequire(import.meta.url)
const cp = require('child_process') as typeof import('child_process')
const launched: string[][] = []
const realSpawn = cp.spawn
cp.spawn = ((cmd: string, args?: readonly string[], opts?: object) => {
  if (/explorer|xdg-open|^open$/.test(String(cmd))) {
    launched.push([String(cmd), ...(args ?? [])])
    return { unref() {}, on() { return this } } as unknown as ReturnType<typeof realSpawn>
  }
  return realSpawn(cmd, args as string[], opts as never)
}) as typeof cp.spawn
syncBuiltinESMExports()

const touched: string[] = []
const isNet = (v: unknown) => typeof v === 'string' && /^[\\/]{2}|^[\\/]\?\?[\\/]/.test(v.trim())
for (const name of ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'realpathSync', 'accessSync', 'createReadStream', 'writeFileSync', 'openSync'] as const) {
  const orig = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[name]
  ;(fs as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
    if (isNet(args[0])) touched.push(`${name}(${String(args[0])})`)
    return orig.apply(fs, args)
  }
}
const nativeReal = fs.realpathSync.native
fs.realpathSync.native = ((p: fs.PathLike, o?: unknown) => {
  if (isNet(p)) touched.push(`realpathSync.native(${String(p)})`)
  return nativeReal(p, o as never)
}) as typeof fs.realpathSync.native
syncBuiltinESMExports()

const { app, db, close } = await scratchApp(['folders', 'fs', 'settings', 'instances', 'agents', 'sessions'])

type Json = Record<string, unknown>
async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Json } : {}) })
  let body: Json = {}
  try { body = res.json() as Json } catch { /* empty */ }
  return { status: res.statusCode, body, headers: res.headers }
}

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-paths-'))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-outside-'))
fs.writeFileSync(path.join(project, 'notes.md'), '# notes')
fs.writeFileSync(path.join(project, 'run.bat'), 'echo hi')
fs.writeFileSync(path.join(project, 'sneaky.bat.'.replace(/\.$/, '') ), 'echo hi')
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside')
fs.writeFileSync(path.join(project, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/state")</script></svg>')
const folder = await call('POST', '/api/folders', { path: project, name: 'paths' })
const pid = String(folder.body.id ?? '')
check('setup: a project folder is created', folder.status === 201, `status ${folder.status}`)
db.prepare("INSERT INTO instances (id, folder_id, name, cwd, created_at) VALUES ('chat-1', ?, 'c', ?, ?)").run(pid, project, Date.now())

// ── Network and device paths, on every route that takes a path ──────────────────
const netPaths = [
  '\\\\192.0.2.1\\share\\a.txt',
  '//192.0.2.1/share/a.txt',
  '\\\\?\\UNC\\192.0.2.1\\share\\a.txt',
  '\\\\.\\pipe\\x',
  '\\??\\C:\\x',
  '\\\\192.0.2.1@8080\\DavWWWRoot\\a.txt',
  '\\/192.0.2.1\\share',
]
const routes: Array<[string, (p: string) => Promise<{ status: number }>]> = [
  ['GET /fs/browse', p => call('GET', `/api/fs/browse?dir=${encodeURIComponent(p)}`)],
  ['GET /fs/subfolders', p => call('GET', `/api/fs/subfolders?dir=${encodeURIComponent(p)}`)],
  ['GET /fs/claude-md', p => call('GET', `/api/fs/claude-md?dir=${encodeURIComponent(p)}`)],
  ['PUT /fs/claude-md', p => call('PUT', `/api/fs/claude-md?dir=${encodeURIComponent(p)}`, { content: 'x' })],
  ['POST /fs/open', p => call('POST', '/api/fs/open', { path: p })],
  ['GET /settings/output-styles', p => call('GET', `/api/settings/output-styles?cwd=${encodeURIComponent(p)}`)],
  ['POST /folders', p => call('POST', '/api/folders', { path: p, name: 'n' })],
  ['PUT /folders/:id', p => call('PUT', `/api/folders/${pid}`, { path: p })],
  ['POST /instances', p => call('POST', '/api/instances', { folderId: pid, cwd: p })],
  ['PUT /instances/:id', p => call('PUT', '/api/instances/chat-1', { cwd: p })],
  // POST /agents/scan used to be here; the route is removed (dead-endpoints.test.ts).
]
for (const [name, fn] of routes) {
  const statuses: number[] = []
  for (const p of netPaths) statuses.push((await fn(p)).status)
  check(`${name} refuses every network and device path with 400`, statuses.every(s => s === 400), statuses.join(','))
}
check('no filesystem call ever saw a network or device path', touched.length === 0, touched.slice(0, 4).join(' | '))
const legacyImage = await call('GET', `/api/fs/image?path=${encodeURIComponent('\\\\192.0.2.1\\share\\a.png')}`)
check('the image route is gone (404)', legacyImage.status === 404, `status ${legacyImage.status}`)
const svg = await call('GET', `/api/fs/image?path=${encodeURIComponent(path.join(project, 'pic.svg'))}`)
check('an SVG in a project is not served as a live page', svg.status === 404 && !String(svg.headers['content-type'] ?? '').includes('svg'), `status ${svg.status} ${svg.headers['content-type']}`)

// ── Project folders only; open never runs a program ──────────────────────────────────
const drive = path.parse(project).root
const browseRoot = await call('GET', `/api/fs/browse?dir=${encodeURIComponent(drive)}`)
check('listing files at the drive root is refused (was a listing)', browseRoot.status === 403, `status ${browseRoot.status}`)
const browseHome = await call('GET', `/api/fs/browse?dir=${encodeURIComponent(os.homedir())}`)
check('listing files in the home folder is refused', browseHome.status === 403, `status ${browseHome.status}`)
const browseProject = await call('GET', `/api/fs/browse?dir=${encodeURIComponent(project)}`)
check('listing a project folder still works', browseProject.status === 200, `status ${browseProject.status}`)
const picker = await call('GET', `/api/fs/subfolders?dir=${encodeURIComponent(drive)}`)
check('the folder picker can still list folder names at the drive root', picker.status === 200 && Array.isArray(picker.body.folders) && !('items' in picker.body), `status ${picker.status}`)
const readOutside = await call('GET', `/api/fs/claude-md?dir=${encodeURIComponent(outside)}`)
check('CLAUDE.md outside a project cannot be read', readOutside.status === 403, `status ${readOutside.status}`)
const writeOutside = await call('PUT', `/api/fs/claude-md?dir=${encodeURIComponent(outside)}`, { content: 'planted' })
check('CLAUDE.md cannot be planted outside a project', writeOutside.status === 403 && !fs.existsSync(path.join(outside, 'CLAUDE.md')), `status ${writeOutside.status}`)
const writeInside = await call('PUT', `/api/fs/claude-md?dir=${encodeURIComponent(project)}`, { content: '# ok' })
check('CLAUDE.md in a project can still be written', writeInside.status === 200, `status ${writeInside.status}`)

launched.length = 0
const openDoc = await call('POST', '/api/fs/open', { path: path.join(project, 'notes.md') })
check('a document in a project opens', openDoc.status === 200 && openDoc.body.action === 'open' && launched.length === 1 && !launched[0].some(a => a.startsWith('/select')), JSON.stringify(launched))
launched.length = 0
const openBat = await call('POST', '/api/fs/open', { path: path.join(project, 'run.bat') })
check('a .bat in a project is shown in its folder, never run', openBat.status === 200 && openBat.body.action === 'reveal' && (process.platform !== 'win32' || launched[0]?.[1] === `/select,${path.join(project, 'run.bat')}`), JSON.stringify(launched))
launched.length = 0
const openDotted = await call('POST', '/api/fs/open', { path: path.join(project, 'run.bat') + '.' })
check('"run.bat." (Windows drops the dot and runs it) is also only shown', openDotted.status !== 200 || openDotted.body.action === 'reveal', `status ${openDotted.status} ${openDotted.body.action}`)
launched.length = 0
const openOutside = await call('POST', '/api/fs/open', { path: path.join(outside, 'secret.txt') })
check('a file outside every project is only shown in its folder', openOutside.status === 200 && openOutside.body.action === 'reveal', `status ${openOutside.status} ${openOutside.body.action}`)
const openCited = await call('POST', '/api/fs/open', { path: path.join(project, 'notes.md') + ':12' })
check('a cited "file.md:12" link still opens the file', openCited.status === 200 && openCited.body.action === 'open', `status ${openCited.status}`)
const openStream = await call('POST', '/api/fs/open', { path: path.join(project, 'notes.md') + ':evil.exe' })
check('an NTFS stream name is refused', process.platform !== 'win32' || openStream.status === 400, `status ${openStream.status}`)

// A junction inside a project led the fs routes outside it.
const jn = path.join(project, 'escape')
let junctionMade = false
try { fs.symlinkSync(outside, jn, 'junction'); junctionMade = true } catch { /* no junctions on this OS */ }
if (junctionMade) {
  const viaJunction = await call('GET', `/api/fs/browse?dir=${encodeURIComponent(jn)}`)
  check('a junction inside a project cannot be used to list outside it', viaJunction.status === 403, `status ${viaJunction.status}`)
  const plant = await call('PUT', `/api/fs/claude-md?dir=${encodeURIComponent(jn)}`, { content: 'planted' })
  check('... nor to plant a CLAUDE.md outside it', plant.status === 403 && !fs.existsSync(path.join(outside, 'CLAUDE.md')), `status ${plant.status}`)
  launched.length = 0
  const openVia = await call('POST', '/api/fs/open', { path: path.join(jn, 'secret.txt') })
  check('... and a file reached through it is only shown, not opened', openVia.status === 200 && openVia.body.action === 'reveal', `status ${openVia.status} ${openVia.body.action}`)
}

// Node can create a junction whose target is a network share;
// lstat then says ENOENT. It must be refused, not treated as a new name.
if (process.platform === 'win32') {
  const uncJunction = path.join(project, 'share-link')
  let made = false
  try { fs.symlinkSync('\\\\localhost\\c$\\Windows', uncJunction, 'junction'); made = true } catch { /* not creatable here */ }
  if (made) {
    const via = await call('POST', '/api/fs/open', { path: path.join(uncJunction, 'win.ini') })
    check('(win) a path through a junction to a share is refused', via.status === 400, `status ${via.status}`)
    const list = await call('GET', `/api/fs/browse?dir=${encodeURIComponent(uncJunction)}`)
    check('(win) ... and cannot be listed', list.status === 403 || list.status === 400, `status ${list.status}`)
    try { fs.rmdirSync(uncJunction) } catch { /* best effort */ }
  }
}

// Scaffold New starts a chat in the user's root-folder setting (it broke with the project-path check).
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('rootFolder', ?)").run(JSON.stringify(outside))
const scaffold = await call('POST', '/api/instances', { folderId: pid, name: 'New Project', cwd: outside })
check('"Scaffold New" can still open a chat in the root folder from Settings', scaffold.status === 201, `status ${scaffold.status}`)
db.prepare("DELETE FROM settings WHERE key = 'rootFolder'").run()

// ── Output styles only from a project ────────────────────────────────────────────────
const stylesOutside = await call('GET', `/api/settings/output-styles?cwd=${encodeURIComponent(outside)}`)
check('output styles are not read from an arbitrary folder', stylesOutside.status === 403, `status ${stylesOutside.status}`)
const stylesProject = await call('GET', `/api/settings/output-styles?cwd=${encodeURIComponent(project)}`)
check('output styles from a project folder still work', stylesProject.status === 200, `status ${stylesProject.status}`)

// ── Project paths and chat folders ───────────────────────────────────────────────────
const driveOnly = await call('PUT', `/api/folders/${pid}`, { path: 'C:' })
check('a project cannot be re-pointed at a bare drive', driveOnly.status === 400, `status ${driveOnly.status}`)
const missing = await call('POST', '/api/folders', { path: path.join(project, 'does-not-exist'), name: 'm' })
check('a project folder must exist', missing.status === 400, `status ${missing.status}`)
const relCwd = await call('PUT', '/api/instances/chat-1', { cwd: 'relative/not/a/path' })
check('a chat cwd must be a full path (was stored)', relCwd.status === 400, `status ${relCwd.status}`)
const outCwd = await call('PUT', '/api/instances/chat-1', { cwd: outside })
check('a chat cannot be moved outside its project', outCwd.status === 400, `status ${outCwd.status}`)
const subdir = path.join(project, 'sub')
fs.mkdirSync(subdir)
const inCwd = await call('PUT', '/api/instances/chat-1', { cwd: subdir })
check('a chat can still move to a folder inside its project', inCwd.status === 200, `status ${inCwd.status}`)
const noFolder = await call('POST', '/api/instances', {})
check('POST /instances {} is a 400 (was a raw SQLite 500)', noFolder.status === 400, `status ${noFolder.status}`)

// A drive-root project (a legacy row) never hands its rules to other projects.
db.prepare("INSERT INTO folders (id, path, name, permission_rules) VALUES ('root-legacy', 'C:', 'root', ?)").run(JSON.stringify({ allow: ['Bash(cmd:*)'] }))
db.prepare("INSERT INTO folders (id, path, name, permission_rules, status) VALUES ('archived-parent', ?, 'arch', ?, 'archived')").run(path.dirname(project), JSON.stringify({ allow: ['Bash(archived:*)'] }))
const { folderRuleChain } = await import('../src/services/folder-rules.js')
const chain = folderRuleChain(pid).map(s => s.folderId)
check('a drive-root project is not in any other project\'s inherited rules', !chain.includes('root-legacy'), JSON.stringify(chain))
check('an archived project is not in any other project\'s inherited rules', !chain.includes('archived-parent'), JSON.stringify(chain))

// ── Session ids ──────────────────────────────────────────────────────────────────────
const badSession = await call('PUT', '/api/instances/chat-1', { sessionId: '..\\..\\..\\Users\\Public\\victim' })
check('a path-like sessionId is refused (was stored)', badSession.status === 400, `status ${badSession.status}`)
const goodSession = await call('PUT', '/api/instances/chat-1', { sessionId: '00000000-0000-4000-8000-000000000001' })
check('a real session id is still accepted', goodSession.status === 200, `status ${goodSession.status}`)
const { healSessionLocation, sanitizeSession } = await import('../src/services/session-sanitizer.js')
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-a12-'))
const victim = path.join(probe, 'victim.jsonl')
fs.writeFileSync(victim, 'keep me')
const traversal = path.relative(path.join(os.homedir(), '.claude', 'projects', 'x'), victim).replace(/\.jsonl$/, '')
check('healSessionLocation refuses a traversal id', (await healSessionLocation(project, traversal)) === 'absent')
await sanitizeSession(project, traversal)
check('sanitizeSession leaves an unrelated file alone', fs.readFileSync(victim, 'utf8') === 'keep me')

for (const d of [project, outside, probe]) fs.rmSync(d, { recursive: true, force: true })
await close()
done()
