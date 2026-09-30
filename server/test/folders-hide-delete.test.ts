// Hiding a project must never delete anything, deleting needs an
// explicit confirmation and removes everything including run history, and Renew with no
// body must not leave a project with its chats gone.
//
//   npx tsx server/test/folders-hide-delete.test.ts
//
// Runs the real folder and pipeline routes against a fresh temp database (helpers/scratch-app).

import fs from 'fs'
import os from 'os'
import path from 'path'
import { scratchApp, check, done } from './helpers/scratch-app.js'

const { app, db, close } = await scratchApp(['folders', 'pipeline', 'state'])

type Json = Record<string, unknown>
async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Json } : {}) })
  let body: Json = {}
  try { body = res.json() as Json } catch { /* empty body */ }
  return { status: res.statusCode, body }
}

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-proj-'))

/** A project with one card, one routine, a comment, a chat with history, and a run row. */
async function seedProject(label: string): Promise<{ folderId: string; taskId: string; routineId: string; instanceId: string }> {
  const dir = path.join(projectDir, label)
  fs.mkdirSync(dir, { recursive: true })
  const folder = await call('POST', '/api/folders', { path: dir, name: label })
  const folderId = folder.body.id as string
  const card = await call('POST', `/api/pipelines/${folderId}/tasks`, { title: `${label} card` })
  const taskId = card.body.id as string
  const routine = await call('POST', `/api/pipelines/${folderId}/tasks`, {
    title: `${label} routine`, description: 'say hi', scheduleKind: 'every', scheduleValue: '60', scheduleEnabled: false,
  })
  const routineId = routine.body.id as string
  await call('POST', `/api/pipelines/${folderId}/tasks/${taskId}/comments`, { body: 'a comment', author: 'test' })
  const instanceId = `inst-${label}`
  db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, sort_order, created_at) VALUES (?, ?, ?, ?, 'idle', 0, ?)")
    .run(instanceId, folderId, `${label} chat`, dir, Date.now())
  db.prepare("INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, 'user', '[]', ?)")
    .run(`msg-${label}`, instanceId, Date.now())
  db.prepare("INSERT INTO task_runs (id, task_id, instance_id, started_at, status) VALUES (?, ?, ?, ?, 'done')")
    .run(`run-${label}`, routineId, instanceId, Date.now())
  return { folderId, taskId, routineId, instanceId }
}

function counts(folderId: string) {
  const n = (sql: string) => (db.prepare(sql).get(folderId) as { n: number }).n
  return {
    folder: n('SELECT COUNT(*) AS n FROM folders WHERE id = ?'),
    tasks: n('SELECT COUNT(*) AS n FROM pipeline_tasks WHERE project_id = ?'),
    comments: n('SELECT COUNT(*) AS n FROM task_comments WHERE task_id IN (SELECT id FROM pipeline_tasks WHERE project_id = ?)'),
    chats: n('SELECT COUNT(*) AS n FROM instances WHERE folder_id = ?'),
    messages: n('SELECT COUNT(*) AS n FROM messages WHERE instance_id IN (SELECT id FROM instances WHERE folder_id = ?)'),
    runs: n("SELECT COUNT(*) AS n FROM task_runs WHERE instance_id IN (SELECT id FROM instances WHERE folder_id = ?)"),
  }
}

async function listedFolder(folderId: string): Promise<Json | undefined> {
  const state = await call('GET', '/api/state')
  const folders = (state.body.folders ?? []) as Json[]
  return folders.find(f => f.id === folderId)
}

// ── Hide keeps every row ─────────────────────────────────────────────────────
const a = await seedProject('alpha')
const before = counts(a.folderId)
check('seed: project has a card and a routine, a comment, a chat, a message and a run',
  before.folder === 1 && before.tasks === 2 && before.comments === 1 && before.chats === 1 && before.messages === 1 && before.runs === 1,
  JSON.stringify(before))

const hide = await call('POST', `/api/folders/${a.folderId}/hide`)
check('hide route answers 200', hide.status === 200, `status ${hide.status}`)
check('hide sets hidden=true', hide.body.hidden === true, `hidden ${String(hide.body.hidden)}`)
const afterHide = counts(a.folderId)
check('hide keeps every row (folder, cards, routines, comments, chats, messages, runs)',
  JSON.stringify(afterHide) === JSON.stringify(before), JSON.stringify(afterHide))
const listedHidden = await listedFolder(a.folderId)
check('hidden project is still in /state, flagged hidden', listedHidden?.hidden === true, JSON.stringify(listedHidden?.hidden))

const unhide = await call('POST', `/api/folders/${a.folderId}/unhide`)
check('unhide route answers 200', unhide.status === 200, `status ${unhide.status}`)
const listedAgain = await listedFolder(a.folderId)
check('unhide lists the project again (hidden=false)', listedAgain !== undefined && listedAgain.hidden === false, JSON.stringify(listedAgain?.hidden))
check('unhide keeps every row', JSON.stringify(counts(a.folderId)) === JSON.stringify(before))

const hideMissing = await call('POST', '/api/folders/does-not-exist/hide')
check('hiding an unknown project is a 404, not a silent success', hideMissing.status === 404, `status ${hideMissing.status}`)

// ── Delete needs an explicit confirmation ──────────────────────────────────────
const bareDelete = await call('DELETE', `/api/folders/${a.folderId}`)
check('DELETE without ?confirm is refused (400)', bareDelete.status === 400, `status ${bareDelete.status}`)
check('refused DELETE deletes nothing', JSON.stringify(counts(a.folderId)) === JSON.stringify(before))
const wrongConfirm = await call('DELETE', `/api/folders/${a.folderId}?confirm=yes`)
check('DELETE with the wrong confirmation is refused', wrongConfirm.status === 400, `status ${wrongConfirm.status}`)

const summary = await call('GET', `/api/folders/${a.folderId}/delete-summary`)
check('delete summary names what is lost',
  summary.body.cards === 1 && summary.body.routines === 1 && summary.body.comments === 1 && summary.body.chats === 1 && summary.body.messages === 1,
  JSON.stringify(summary.body))

// ── A confirmed delete removes the run history too ────────────────────────────
const confirmed = await call('DELETE', `/api/folders/${a.folderId}?confirm=${a.folderId}`)
check('confirmed DELETE answers 200', confirmed.status === 200, `status ${confirmed.status}`)
const afterDelete = counts(a.folderId)
check('confirmed DELETE removes folder, cards, comments, chats and messages',
  afterDelete.folder === 0 && afterDelete.tasks === 0 && afterDelete.comments === 0 && afterDelete.chats === 0 && afterDelete.messages === 0,
  JSON.stringify(afterDelete))
const orphanRuns = (db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE task_id IN (?, ?)').get(a.taskId, a.routineId) as { n: number }).n
check('confirmed DELETE leaves no task_runs behind', orphanRuns === 0, `orphans ${orphanRuns}`)

// ── Renew with no body ────────────────────────────────────────────────────────
const b = await seedProject('bravo')
db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, sort_order, created_at) VALUES ('inst-bravo-2', ?, 'second', ?, 'idle', 1, ?)")
  .run(b.folderId, path.join(projectDir, 'bravo'), Date.now())
const renew = await call('POST', `/api/folders/${b.folderId}/renew`)
check('Renew with no body succeeds', renew.status === 200, `status ${renew.status} ${JSON.stringify(renew.body).slice(0, 120)}`)
const chatsAfterRenew = counts(b.folderId).chats
check('Renew with no body keeps the chat count (2 before, 2 after)', chatsAfterRenew === 2, `chats ${chatsAfterRenew}`)
const badRenew = await call('POST', `/api/folders/${b.folderId}/renew`, { newNames: 'not-a-list' })
check('Renew with a malformed newNames is refused before anything is deleted', badRenew.status === 400 && counts(b.folderId).chats === 2, `status ${badRenew.status}`)

await close()
fs.rmSync(projectDir, { recursive: true, force: true })
done()
