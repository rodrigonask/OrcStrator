// /state serves each chat's native task list from the poller's memory
// instead of reading task files from disk per chat, and the poller itself reads without
// blocking, only for chats that are running. Task files are synthetic, in a temp home folder.
//
//   npx tsx server/test/native-tasks-cache.test.ts

import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { syncBuiltinESMExports } from 'module'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-tasks-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR

const tasksRoot = path.join(fakeHome, '.claude', 'tasks')
const runningSid = crypto.randomUUID()
const idleSid = crypto.randomUUID()
const writeTask = (sid: string, n: number, subject: string, status = 'pending') => {
  fs.mkdirSync(path.join(tasksRoot, sid), { recursive: true })
  fs.writeFileSync(path.join(tasksRoot, sid, `${n}.json`), JSON.stringify({ id: String(n), subject, status, blockedBy: [] }))
}
writeTask(runningSid, 1, 'running chat task one')
writeTask(idleSid, 1, 'idle chat task one')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const { scratchApp, check, done } = await import('./helpers/scratch-app.js')
const { app, db, close } = await scratchApp(['state'])
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-tasks-work-'))
db.prepare('INSERT INTO folders (id, path, name) VALUES (?, ?, ?)').run('f', work, 'p')
db.prepare("INSERT INTO instances (id, folder_id, name, cwd, session_id, state, process_state, sort_order, created_at) VALUES ('run', 'f', 'run', ?, ?, 'running', 'running', 0, 1)").run(work, runningSid)
db.prepare("INSERT INTO instances (id, folder_id, name, cwd, session_id, state, process_state, sort_order, created_at) VALUES ('idle', 'f', 'idle', ?, ?, 'idle', 'idle', 1, 1)").run(work, idleSid)

// Spies on every disk call that touches the tasks folder, synchronous and not.
const under = (p: unknown) => (typeof p === 'string' || p instanceof URL) && path.resolve(String(p)).toLowerCase().startsWith(tasksRoot.toLowerCase())
let syncCalls: string[] = []
let asyncCalls: string[] = []
for (const name of ['existsSync', 'readdirSync', 'readFileSync', 'statSync', 'mkdirSync'] as const) {
  const orig = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[name]
  ;(fs as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
    if (under(args[0])) syncCalls.push(`${name} ${String(args[0])}`)
    return orig.apply(fs, args)
  }
}
syncBuiltinESMExports()
for (const name of ['readdir', 'readFile', 'stat', 'mkdir'] as const) {
  const orig = (fsp as unknown as Record<string, (...a: unknown[]) => unknown>)[name]
  ;(fsp as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
    if (under(args[0])) asyncCalls.push(`${name} ${String(args[0])}`)
    return orig.apply(fsp, args)
  }
}
const touched = (calls: string[], sid: string) => calls.filter(c => c.toLowerCase().includes(sid.toLowerCase())).length

type Inst = { id: string; nativeTasks?: Array<{ subject: string }> }
const state = async () => ((await app.inject({ method: 'GET', url: '/api/state' })).json() as { instances: Inst[] }).instances
const subjects = (list: Inst[], id: string) => (list.find(i => i.id === id)?.nativeTasks ?? []).map(t => t.subject)

// ── /state and the task files ─────────────────────────────────────────────────────
{
  syncCalls = []
  const first = await state()
  check('setup: /state still returns each chat\'s own task list',
    subjects(first, 'run')[0] === 'running chat task one' && subjects(first, 'idle')[0] === 'idle chat task one',
    JSON.stringify({ run: subjects(first, 'run'), idle: subjects(first, 'idle') }))
  check('loading /state makes no synchronous reads of task files', syncCalls.length === 0,
    `${syncCalls.length} synchronous call(s), e.g. ${syncCalls[0] ?? ''}`)
  syncCalls = []
  asyncCalls = []
  await state()
  check('loading /state again is served from memory, with no disk reads of task files at all',
    syncCalls.length + asyncCalls.length === 0, `${syncCalls.length} sync + ${asyncCalls.length} async call(s)`)
}

// ── The poller ────────────────────────────────────────────────────────────────────
{
  const nt = await import('../src/services/native-tasks.js')
  syncCalls = []
  asyncCalls = []
  nt.startNativeTaskWatcher()
  // The start-up sweep reads idle chats too; on a busy machine it can run late, so the window
  // below opens only once it has run (it touches the idle chat's folder) and a tick has followed.
  const settleEnd = Date.now() + 8000
  await sleep(1000)
  while (Date.now() < settleEnd && touched([...syncCalls, ...asyncCalls], idleSid) === 0) await sleep(200)
  await sleep(700)
  const syncDuringStart = syncCalls.length
  syncCalls = []
  asyncCalls = []
  await sleep(1500)
  const all = [...syncCalls, ...asyncCalls]
  check('the task poller makes no synchronous disk calls', syncDuringStart + syncCalls.length === 0,
    `${syncDuringStart + syncCalls.length} synchronous call(s), e.g. ${syncCalls[0] ?? ''}`)
  check('the running chat\'s task folder is polled', touched(all, runningSid) > 0, `${touched(all, runningSid)} call(s)`)
  check('an idle chat\'s task folder is not polled every tick', touched(all, idleSid) === 0, `${touched(all, idleSid)} call(s) in 1.5 s`)

  writeTask(runningSid, 2, 'running chat task two', 'in_progress')
  let after = await state()
  for (const end = Date.now() + 8000; Date.now() < end && !subjects(after, 'run').includes('running chat task two');) {
    await sleep(300)
    after = await state()
  }
  check('a new task in a running chat reaches /state', subjects(after, 'run').includes('running chat task two'),
    JSON.stringify(subjects(after, 'run')))
  nt.stopNativeTaskWatcher()
}

await close()
fs.rmSync(fakeHome, { recursive: true, force: true })
fs.rmSync(work, { recursive: true, force: true })
done()
