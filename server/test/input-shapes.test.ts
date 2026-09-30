// Wrong-typed data from a sloppy caller is refused at the door, and a bad
// row already in the database is coerced on read, so neither can white-screen the app.
// The error boundaries are checked at the source level at the end.
//
//   npx tsx server/test/input-shapes.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { scratchApp, check, done } from './helpers/scratch-app.js'

const { app, db, close } = await scratchApp(['folders', 'pipeline', 'history'])

type Json = Record<string, unknown>
async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Json } : {}) })
  let body: Json = {}
  try { body = res.json() as Json } catch { /* empty */ }
  return { status: res.statusCode, body }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-a19-'))

// ── the original reproductions, now refused ────────────────────────────────────────
const noPath = await call('POST', '/api/folders', {})
check('POST /folders {} is refused (was 201 with path=null)', noPath.status === 400, `status ${noPath.status}`)
const relPath = await call('POST', '/api/folders', { path: 'relative/dir' })
check('POST /folders with a relative path is refused', relPath.status === 400, `status ${relPath.status}`)
const nullCount = (db.prepare('SELECT COUNT(*) AS n FROM folders WHERE path IS NULL').get() as { n: number }).n
check('no folder with a NULL path was stored', nullCount === 0, `null-path folders ${nullCount}`)

const folder = await call('POST', '/api/folders', { path: dir, name: 'a19' })
const pid = folder.body.id as string
check('a proper folder is still created', folder.status === 201)
const putNullPath = await call('PUT', `/api/folders/${pid}`, { path: null })
check('PUT /folders cannot null the path', putNullPath.status === 400, `status ${putNullPath.status}`)

// Second spellings of one folder, roots, and bad PUT values.
const dupSlash = await call('POST', '/api/folders', { path: dir + path.sep, name: 'dup' })
check('the same folder with a trailing slash is not a second project (409)', dupSlash.status === 409 && dupSlash.body.id === pid, `status ${dupSlash.status}`)
const rootPath = await call('POST', '/api/folders', { path: path.parse(dir).root, name: 'root' })
check('the root of a drive is not a project folder', rootPath.status === 400, `status ${rootPath.status}`)
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-a19b-'))
const second = await call('POST', '/api/folders', { path: other, name: 'second' })
const steal = await call('PUT', `/api/folders/${second.body.id}`, { path: dir })
check('PUT cannot point a project at a folder another project owns (409, was 500)', steal.status === 409, `status ${steal.status}`)
const putObj = await call('PUT', `/api/folders/${pid}`, { name: { a: 1 } })
check('PUT name:{...} is a 400 (was 500)', putObj.status === 400, `status ${putObj.status}`)
const putSort = await call('PUT', `/api/folders/${pid}`, { sortOrder: 'abc' })
check('PUT sortOrder:"abc" is refused (was stored)', putSort.status === 400, `status ${putSort.status}`)
fs.rmSync(other, { recursive: true, force: true })

// Windows-only spellings of one folder. Skipped on POSIX CI,
// where these strings are not paths at all.
if (process.platform === 'win32') {
  const dot = await call('POST', '/api/folders', { path: dir + '.', name: 'dot' })
  check('(win) a trailing dot is the same folder (409)', dot.status === 409, `status ${dot.status}`)
  const nt = await call('POST', '/api/folders', { path: '\\??\\' + dir, name: 'nt' })
  check('(win) an NT \\??\\ prefix is refused', nt.status === 400, `status ${nt.status}`)
  const stream = await call('POST', '/api/folders', { path: dir + '::$INDEX_ALLOCATION', name: 's' })
  check('(win) an NTFS stream suffix is refused', stream.status === 400, `status ${stream.status}`)
  const noDrive = await call('POST', '/api/folders', { path: '\\Users\\nobody\\x', name: 'nd' })
  check('(win) a path with no drive letter is refused', noDrive.status === 400, `status ${noDrive.status}`)
  // An admin share of this computer, a legacy
  // row stored in Git Bash form, and a folder that does not exist yet spelled two ways.
  const share = '\\\\localhost\\' + dir[0] + '$' + dir.slice(2)
  // Both of these are tighter now: a network share, even one naming this
  // computer, is refused before any file call, and a folder must exist to become a project.
  const viaShare = await call('POST', '/api/folders', { path: share, name: 'share' })
  check('(win) a \\\\localhost\\C$ share of the same folder is not a second project (refused)', viaShare.status === 400 || viaShare.status === 409, `status ${viaShare.status}`)
  const ghostA = await call('POST', '/api/folders', { path: dir + '\\ghost', name: 'ghostA' })
  const ghostB = await call('POST', '/api/folders', { path: share + '\\ghost', name: 'ghostB' })
  check('(win) a folder that does not exist cannot be claimed under any spelling', ghostA.status === 400 && ghostB.status === 400, `${ghostA.status} ${ghostB.status}`)
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-legacy-'))
  db.prepare("INSERT INTO folders (id, path, name) VALUES ('legacy-row', ?, 'legacy')").run('/' + legacyDir[0].toLowerCase() + legacyDir.slice(2).replace(/\\/g, '/'))
  const reAdd = await call('POST', '/api/folders', { path: legacyDir, name: 'readd' })
  check('(win) a legacy row stored as /c/... still counts as that folder', reAdd.status === 409, `status ${reAdd.status}`)
  fs.rmSync(legacyDir, { recursive: true, force: true })
  const v6 = await call('POST', '/api/folders', { path: '\\\\[::1]\\' + dir[0] + '$' + dir.slice(2) + '\\v6', name: 'v6' })
  check('(win) an IPv6 share address is not mistaken for a stream', v6.status !== 400 || !/ordinary folder/.test(String(v6.body.error)), `status ${v6.status}`)
  // The folder has to exist, so the probe is a real temp folder.
  const gbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-a19-gitbash-'))
  const gbSpelling = '/' + gbDir[0].toLowerCase() + gbDir.slice(2).replace(/\\/g, '/')
  const gitBash = await call('POST', '/api/folders', { path: gbSpelling, name: 'gb' })
  check('(win) a Git Bash /c/... path is stored as C:\\...', gitBash.status === 201 && String(gitBash.body.path).toLowerCase() === gbDir.toLowerCase(), `${gitBash.status} ${String(gitBash.body.path)}`)
  fs.rmSync(gbDir, { recursive: true, force: true })
}

const badLabels = await call('POST', `/api/pipelines/${pid}/tasks`, { title: 'x', labels: 'bug', attachments: 'not-an-array' })
check('card with labels:"bug" is refused (was 201)', badLabels.status === 400, `status ${badLabels.status}`)
const badAttach = await call('POST', `/api/pipelines/${pid}/tasks`, { title: 'x', attachments: 'not-an-array' })
check('card with attachments:"not-an-array" is refused', badAttach.status === 400, `status ${badAttach.status}`)
const badAttach2 = await call('POST', `/api/pipelines/${pid}/tasks`, { title: 'x', attachments: [{ name: 'a' }] })
check('attachment without a dataUrl is refused', badAttach2.status === 400, `status ${badAttach2.status}`)
const noProject = await call('POST', '/api/pipelines/no-such-project/tasks', { title: 'x' })
check('card in a project that does not exist is refused (was 201)', noProject.status === 404, `status ${noProject.status}`)
const good = await call('POST', `/api/pipelines/${pid}/tasks`, { title: 'fine', labels: ['bug'] })
check('a well-formed card is still created', good.status === 201, `status ${good.status}`)
const goodId = good.body.id as string
const putBad = await call('PUT', `/api/pipelines/${pid}/tasks/${goodId}`, { labels: 'bug' })
check('PUT with labels:"bug" is refused', putBad.status === 400, `status ${putBad.status}`)

// ── a bad row already in the DB (written by an old build) reads safely ──────────────
db.prepare(`UPDATE pipeline_tasks SET labels = '"bug"', attachments = '"nope"' WHERE id = ?`).run(goodId)
const read = await call('GET', `/api/pipelines/${pid}/tasks/${goodId}`)
check('a stored labels:"bug" reads back as a list', Array.isArray(read.body.labels), JSON.stringify(read.body.labels))
check('a stored attachments:"nope" reads back as a list', Array.isArray(read.body.attachments), JSON.stringify(read.body.attachments))
const light = await call('GET', `/api/pipelines/${pid}`)
const lightCard = (light.body as unknown as Json[]).find(t => t.id === goodId)
check('the board list coerces it too', Array.isArray(lightCard?.labels), JSON.stringify(lightCard?.labels))
const block = await call('POST', `/api/pipelines/${pid}/tasks/${goodId}/block`, { reason: 'test' })
check('blocking that card works (was 500 "labels.push is not a function")', block.status === 200, `status ${block.status} ${JSON.stringify(block.body).slice(0, 100)}`)

// ── message history ──────────────────────────────────────────────────────────────
db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, sort_order, created_at) VALUES ('i-a19', ?, 'c', ?, 'idle', 0, ?)").run(pid, dir, Date.now())
const badMsg = await call('POST', '/api/instances/i-a19/history', { role: 'assistant', content: 'not a list' })
check('a message whose content is not a list is refused', badMsg.status === 400, `status ${badMsg.status}`)
const goodMsg = await call('POST', '/api/instances/i-a19/history', { role: 'assistant', content: [{ type: 'text', text: 'hi' }] })
check('a well-formed message is still saved', goodMsg.status === 200 || goodMsg.status === 201, `status ${goodMsg.status}`)
db.prepare("INSERT INTO messages (id, instance_id, role, content, created_at) VALUES ('m-bad', 'i-a19', 'assistant', '\"oops\"', ?)").run(Date.now() + 1)
const hist = await call('GET', '/api/instances/i-a19/history')
const msgs = (hist.body.messages ?? []) as Json[]
check('a stored non-list message reads back with list content', msgs.length === 2 && msgs.every(m => Array.isArray(m.content)), JSON.stringify(msgs.map(m => m.content)))

// ── The boundaries are mounted ──────────────────────────────────────────────
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const main = fs.readFileSync(path.join(root, 'client/src/main.tsx'), 'utf8')
const gridView = fs.readFileSync(path.join(root, 'client/src/components/grid/GridView.tsx'), 'utf8')
check('the whole app renders inside an error boundary', /<ErrorBoundary variant="app">\s*<App \/>\s*<\/ErrorBoundary>/.test(main))
check('every Grid tile renders inside its own error boundary', /<ErrorBoundary\b[^\n]*variant="tile"[^\n]*\n\s*<GridTile\b/.test(gridView))
const boundary = fs.existsSync(path.join(root, 'client/src/components/ErrorBoundary.tsx'))
  ? fs.readFileSync(path.join(root, 'client/src/components/ErrorBoundary.tsx'), 'utf8') : ''
check('the boundary offers a recovery action', /Reload tile/.test(boundary) && /Reload OrcStrator/.test(boundary))

await close()
fs.rmSync(dir, { recursive: true, force: true })
done()
