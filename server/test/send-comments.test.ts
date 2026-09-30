// Per-card "send comments as context", and routine close summaries landing in run history.
//
//   npx tsx server/test/send-comments.test.ts

import os from 'os'
import crypto from 'crypto'
import { scratchApp, check, done } from './helpers/scratch-app.js'

const { app, db, close } = await scratchApp(['folders', 'pipeline'])
type Json = Record<string, unknown>
async function call(method: 'POST' | 'PUT' | 'GET', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Json } : {}) })
  return { status: res.statusCode, body: res.json() as Json }
}

const folder = await call('POST', '/api/folders', { path: os.tmpdir(), name: 'sc' })
const pid = folder.body.id as string
const tasksUrl = `/api/pipelines/${pid}/tasks`
const { kickoffComments, buildKickoffPrompt } = await import('../src/services/kickoff-prompt.js')
const taskManager = await import('../src/services/task-manager.js')

async function seed(body: Json): Promise<string> {
  const r = await call('POST', tasksUrl, body)
  const id = r.body.id as string
  await call('POST', `${tasksUrl}/${id}/comments`, { author: 'human', body: 'NOTE FROM A HUMAN' })
  return id
}
const sends = (id: string) => kickoffComments(taskManager.getTask(id)!).length > 0

// ── Auto defaults ────────────────────────────────────────────────────────────
const plain = await seed({ title: 'plain', description: 'do it' })
const routine = await seed({ title: 'routine', description: 'daily thing', scheduleKind: 'every', scheduleValue: '60' })
check('a new card stores AUTO (null)', (await call('GET', `${tasksUrl}/${plain}`)).body.sendComments === null)
check('auto: a plain task sends its comments', sends(plain))
check('auto: a routine does not', !sends(routine))
check('the routine prompt really leaves the comment out',
  !buildKickoffPrompt(taskManager.getTask(routine)!, kickoffComments(taskManager.getTask(routine)!)).includes('NOTE FROM A HUMAN'))

// ── Explicit choice wins, null goes back to auto ────────────────────────────
await call('PUT', `${tasksUrl}/${routine}`, { sendComments: true })
check('a routine switched on sends them', sends(routine))
await call('PUT', `${tasksUrl}/${plain}`, { sendComments: false })
check('a task switched off does not', !sends(plain))
const back = await call('PUT', `${tasksUrl}/${plain}`, { sendComments: null })
check('null puts the card back on auto', back.body.sendComments === null && sends(plain))
const bad = await call('PUT', `${tasksUrl}/${plain}`, { sendComments: 'maybe' })
check('a nonsense value is refused', bad.status === 400, `status ${bad.status}`)

// A plain task that gains a schedule follows auto without anyone touching the box.
await call('PUT', `${tasksUrl}/${plain}`, { scheduleKind: 'every', scheduleValue: '120' })
check('a task given a schedule stops sending on auto', !sends(plain))

// ── Verbatim cards never send, whatever the box says ────────────────────────
const raw = await seed({ title: 'raw', description: 'exact text', rawPrompt: true, sendComments: true })
check('a verbatim card never sends comments', !sends(raw))
const goal = await seed({ title: 'goal', description: '/goal finish it', sendComments: true })
check('a /goal card never sends comments', !sends(goal))

// ── Close summaries: routine -> run history, task -> comment ────────────────
const { summarizeInBackground } = await import('../src/services/session-summarizer.js')
const inst = crypto.randomUUID()
const runId = crypto.randomUUID()
db.prepare("INSERT INTO task_runs (id, task_id, instance_id, started_at, status) VALUES (?, ?, ?, ?, 'ok')").run(runId, routine, inst, Date.now())
const commentsBefore = (db.prepare('SELECT COUNT(*) c FROM task_comments WHERE task_id = ?').get(routine) as { c: number }).c
const captured = (taskId: string) => ({
  instanceId: inst, instanceName: 'Chat', folderId: pid, taskId,
  transcript: [{ role: 'user', text: 'hi' }], nativeTasks: [], workStartedAt: null, workEndedAt: null,
})
await summarizeInBackground(captured(routine))
const commentsAfter = (db.prepare('SELECT COUNT(*) c FROM task_comments WHERE task_id = ?').get(routine) as { c: number }).c
const run = db.prepare('SELECT summary FROM task_runs WHERE id = ?').get(runId) as { summary: string | null }
check('a routine close summary lands on its run', !!run.summary, JSON.stringify(run))
check('and files no comment', commentsAfter === commentsBefore, `${commentsBefore} -> ${commentsAfter}`)
const runs = await call('GET', `${tasksUrl}/${routine}/runs`)
check('the runs endpoint returns the summary', ((runs.body.runs as Json[])[0]?.summary as string | null) === run.summary)

const task = await seed({ title: 'task', description: 'x' })
await summarizeInBackground(captured(task))
const taskComments = (db.prepare("SELECT COUNT(*) c FROM task_comments WHERE task_id = ? AND author LIKE '%(summary)'").get(task) as { c: number }).c
check('a plain task still gets its summary as a comment', taskComments === 1, String(taskComments))

const noRuns = await seed({ title: 'never ran', description: 'x', scheduleKind: 'every', scheduleValue: '60' })
await summarizeInBackground(captured(noRuns))
const fallback = (db.prepare("SELECT COUNT(*) c FROM task_comments WHERE task_id = ? AND author LIKE '%(summary)'").get(noRuns) as { c: number }).c
check('a routine with no run to hold it falls back to a comment, never drops it', fallback === 1, String(fallback))

await close()
done()
