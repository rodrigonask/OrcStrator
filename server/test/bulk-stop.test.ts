// Project-wide and app-wide stops, and a retry
// armed before a stop. A chat's row must never say idle, paused or gone while its agent runs.
// Every "agent" here is the fake claude binary (helpers/fake-claude.ts): nothing is spent.
//
//   npx tsx server/test/bulk-stop.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildFakeClaude, alive, sleep } from './helpers/fake-claude.js'

const fake = buildFakeClaude()
process.env.ORCSTRATOR_CLAUDE_PATH = fake
process.env.FAKE_CLAUDE_SLEEP_MS = '20000'
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-bulk-home-'))
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome

const { scratchApp, check, done } = await import('./helpers/scratch-app.js')
const { app, db, close } = await scratchApp(['instances', 'folders', 'pipeline'])
const { processRegistry: reg } = await import('../src/services/process-registry.js') as unknown as {
  processRegistry: { isTracked: (id: string) => boolean; killProcess: (id: string) => Promise<boolean>; getProcessInfo: () => Array<{ instanceId: string; pid: number }>; killAll: () => Promise<void>; wasStoppedByUser: (id: string) => boolean }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-bulk-work-'))
const pids: number[] = []
const pidOf = (id: string) => reg.getProcessInfo().find(p => p.instanceId === id)?.pid

async function newChat(folderId: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/instances', payload: { folderId, name: 'x' } })
  return (r.json() as { id: string }).id
}

// ── A chat opened and started WHILE a project-wide stop runs ─────────────────────────────────
// The bulk action used to take its list first, then write by folder (or with no filter at all),
// so it deleted or idled the new chat while that chat's agent ran on.
for (const [label, route] of [
  ['Close all', 'close-all'],
  ['Pause all', 'pause-all'],
  ['Shut down all chats', 'shutdown'],
  ['Delete project', 'delete'],
] as const) {
  const folderId = `f-${route}`
  const dir = path.join(work, route)
  fs.mkdirSync(dir)
  db.prepare('INSERT INTO folders (id, path, name) VALUES (?, ?, ?)').run(folderId, dir, route)
  const a = await newChat(folderId)
  const sa = await app.inject({ method: 'POST', url: `/api/instances/${a}/send`, payload: { text: 'hi' } })
  await sleep(500)
  const url = route === 'shutdown' ? '/api/shutdown' : route === 'delete' ? `/api/folders/${folderId}?confirm=${folderId}` : `/api/folders/${folderId}/${route}`
  const bulk = app.inject({ method: route === 'delete' ? 'DELETE' : 'POST', url })
  await sleep(30)
  const b = await newChat(folderId)
  const sb = await app.inject({ method: 'POST', url: `/api/instances/${b}/send`, payload: { text: 'hi' } })
  const br = await bulk
  await sleep(300)
  const pid = pidOf(b)
  if (pid) pids.push(pid)
  const row = db.prepare('SELECT state, process_state FROM instances WHERE id = ?').get(b) as { state: string; process_state: string } | undefined
  const running = !!pid && alive(pid)
  const truthful = running ? (!!row && row.process_state === 'running' && row.state === 'running') : true
  check(`${label}: a chat opened while it ran is never left with a live agent behind a row that says ${route === 'pause-all' ? 'paused/idle' : route === 'shutdown' ? 'idle' : 'deleted'}`,
    sa.statusCode === 200 && br.statusCode < 500 && truthful,
    `A send ${sa.statusCode}, B send ${sb.statusCode}, bulk ${br.statusCode} ${br.body.slice(0, 60)}, B agent ${running ? `alive (pid ${pid})` : 'none'}, B row ${JSON.stringify(row ?? 'deleted')}`)
  for (const id of [a, b]) if (reg.isTracked(id)) await reg.killProcess(id)
}

// ── A retry armed before Pause must not start the chat again ────────────────────────────────
{
  const folderId = 'f-retry'
  const dir = path.join(work, 'retry')
  fs.mkdirSync(dir)
  db.prepare('INSERT INTO folders (id, path, name) VALUES (?, ?, ?)').run(folderId, dir, 'retry')
  db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, process_state, sort_order, created_at) VALUES ('c', ?, 'c', ?, 'idle', 'idle', 0, 1)").run(folderId, dir)
  // A turn that ends with the API's "overloaded" error: the app schedules an automatic Try Again.
  const out = path.join(fakeHome, 'overloaded.jsonl')
  fs.writeFileSync(out, JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}' }) + '\n')
  process.env.FAKE_CLAUDE_STDOUT_FILE = out
  process.env.FAKE_CLAUDE_SLEEP_MS = '300'
  const s = await app.inject({ method: 'POST', url: '/api/instances/c/send', payload: { text: 'hi' } })
  delete process.env.FAKE_CLAUDE_STDOUT_FILE
  process.env.FAKE_CLAUDE_SLEEP_MS = '20000'
  await sleep(2000)
  const p = await app.inject({ method: 'POST', url: '/api/instances/c/pause' })
  let pid: number | undefined
  for (let i = 0; i < 160 && !pid; i++) { await sleep(100); pid = pidOf('c') }
  if (pid) pids.push(pid)
  const row = db.prepare("SELECT state FROM instances WHERE id = 'c'").get() as { state: string }
  check('an automatic retry armed before Pause does not start the paused chat again',
    s.statusCode === 200 && p.statusCode === 200 && !pid && row.state === 'paused',
    `send ${s.statusCode}, pause ${p.statusCode}, agent after 16 s: ${pid ? `pid ${pid}` : 'none'}, state ${row.state}`)
}

// ── A wake-up the agent scheduled before Pause / Stop must not start the chat again ──────────
for (const stop of ['pause', 'kill'] as const) {
  const id = `w-${stop}`
  db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, process_state, sort_order, created_at) VALUES (?, 'f-retry', ?, ?, 'idle', 'idle', 0, 1)").run(id, id, path.join(work, 'retry'))
  const wk = await import('../src/services/wakeup-scheduler.js') as {
    scheduleWakeup: (o: { instanceId: string; delaySeconds: number; prompt: string; toolUseId: string }) => { id: string }
    fireWakeup: (id: string) => Promise<string>
  }
  const s = await app.inject({ method: 'POST', url: `/api/instances/${id}/send`, payload: { text: 'hi' } })
  await sleep(1500)
  const w = wk.scheduleWakeup({ instanceId: id, delaySeconds: 60, prompt: 'check back', toolUseId: `tu-${stop}` })
  const p = await app.inject({ method: 'POST', url: `/api/instances/${id}/${stop}` })
  await sleep(500)
  // Fire it now instead of waiting out its minute.
  const fired = await wk.fireWakeup(w.id)
  let pid: number | undefined
  for (let i = 0; i < 30 && !pid; i++) { await sleep(100); pid = pidOf(id) }
  if (pid) pids.push(pid)
  const status = (db.prepare('SELECT status FROM scheduled_wakeups WHERE id = ?').get(w.id) as { status: string } | undefined)?.status
  check(`a wake-up scheduled before ${stop === 'pause' ? 'Pause' : 'Stop'} does not start the chat again on its own`,
    s.statusCode === 200 && p.statusCode === 200 && !pid,
    `send ${s.statusCode}, ${stop} ${p.statusCode}, fire ${fired}, wake-up ${status}, agent after: ${pid ? `pid ${pid}` : 'none'}`)
}

// ── A routine the user scheduled does not fire into a chat they PAUSED ──────────────────────
// (it did, and cleared the stop, so a /btw queued before the
// Pause ran as well). A paused chat is an explicit "hold"; the fire waits instead.
{
  const id = 'r-paused'
  db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, process_state, sort_order, created_at) VALUES (?, 'f-retry', ?, ?, 'idle', 'idle', 0, 1)").run(id, id, path.join(work, 'retry'))
  const ts = await import('../src/services/task-scheduler.js') as { startTaskScheduler: () => void; stopTaskScheduler: () => void }
  const s = await app.inject({ method: 'POST', url: `/api/instances/${id}/send`, payload: { text: 'hi' } })
  await sleep(1500)
  const p = await app.inject({ method: 'POST', url: `/api/instances/${id}/pause` })
  const cr = await app.inject({ method: 'POST', url: '/api/pipelines/f-retry/tasks', payload: { title: 'routine', description: 'daily check', scheduleKind: 'every', scheduleValue: '60', targetInstanceId: id } })
  const tid = (cr.json() as { id: string }).id
  db.prepare('UPDATE pipeline_tasks SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, tid)
  ts.startTaskScheduler()
  let pid: number | undefined
  // The scheduler polls every 30 s: wait out one full poll.
  for (let i = 0; i < 400 && !pid; i++) { await sleep(100); pid = pidOf(id) }
  ts.stopTaskScheduler()
  if (pid) pids.push(pid)
  const row = db.prepare('SELECT state FROM instances WHERE id = ?').get(id) as { state: string }
  check('a routine does not fire into a chat the user paused (and does not lift the pause)',
    s.statusCode === 200 && p.statusCode === 200 && cr.statusCode < 300 && !pid && row.state === 'paused',
    `send ${s.statusCode}, pause ${p.statusCode}, card ${cr.statusCode}, agent after 40 s: ${pid ? `pid ${pid}` : 'none'}, state ${row.state}`)
  if (pid) await reg.killProcess(id)
}

// ── Restarting the app keeps each chat's wake-ups; Resume lifts the user's stop ─────────────
{
  const id = 'w-restart'
  db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, process_state, sort_order, created_at) VALUES (?, 'f-retry', ?, ?, 'idle', 'idle', 0, 1)").run(id, id, path.join(work, 'retry'))
  const wk = await import('../src/services/wakeup-scheduler.js') as { scheduleWakeup: (o: { instanceId: string; delaySeconds: number; prompt: string; toolUseId: string }) => { id: string } }
  const s = await app.inject({ method: 'POST', url: `/api/instances/${id}/send`, payload: { text: 'hi' } })
  await sleep(1500)
  const w = wk.scheduleWakeup({ instanceId: id, delaySeconds: 600, prompt: 'check back', toolUseId: 'tu-restart' })
  // The server's own shutdown path (SIGINT, dev restart): every running agent is killed.
  await reg.killAll()
  const status = (db.prepare('SELECT status FROM scheduled_wakeups WHERE id = ?').get(w.id) as { status: string }).status
  check('a restart of the app does not cancel the wake-ups of the chats it stops (they re-arm on the next start)',
    s.statusCode === 200 && status === 'pending', `send ${s.statusCode}, wake-up after the shutdown kill: ${status}`)

  const p = await app.inject({ method: 'POST', url: `/api/instances/${id}/pause` })
  const r = await app.inject({ method: 'POST', url: `/api/instances/${id}/resume` })
  check('Resume after Pause lifts the stop (keep-warm and queued notes may run again)',
    p.statusCode === 200 && r.statusCode === 200 && !reg.wasStoppedByUser(id), `pause ${p.statusCode}, resume ${r.statusCode}, still stopped: ${reg.wasStoppedByUser(id)}`)
}

// ── After a Stop, a routine's OWN follow-up wake-up still fires (only older ones are held) ───
// (with the stop kept as a plain mark, a routine turn days later had its own
// wake-up cancelled as "stopped by the user")
{
  const id = 'r-wake'
  db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, process_state, sort_order, created_at) VALUES (?, 'f-retry', ?, ?, 'idle', 'idle', 0, 1)").run(id, id, path.join(work, 'retry'))
  const cp = await import('../src/services/claude-process.js') as { sendMessage: (o: Record<string, unknown>) => Promise<unknown> }
  const wk = await import('../src/services/wakeup-scheduler.js') as {
    scheduleWakeup: (o: { instanceId: string; delaySeconds: number; prompt: string; toolUseId: string }) => { id: string }
    fireWakeup: (id: string, send?: (o: Record<string, unknown>) => Promise<unknown>) => Promise<string>
  }
  process.env.FAKE_CLAUDE_SLEEP_MS = '1500'
  await app.inject({ method: 'POST', url: `/api/instances/${id}/send`, payload: { text: 'hi' } })
  await sleep(700)
  const k = await app.inject({ method: 'POST', url: `/api/instances/${id}/kill` })
  await sleep(1100)
  await cp.sendMessage({ instanceId: id, text: 'routine run', cwd: path.join(work, 'retry'), origin: 'routine' })
  await sleep(300)
  const w = wk.scheduleWakeup({ instanceId: id, delaySeconds: 1200, prompt: 're-check', toolUseId: 'tu-rwake' })
  for (let i = 0; i < 60 && reg.isTracked(id); i++) await sleep(100)
  // Fire it with a stand-in sender: whether it would START is the question, not the turn itself.
  let sent = false
  const r = await wk.fireWakeup(w.id, async () => { sent = true; return { sessionId: 'x' } })
  check('after a Stop, a wake-up that a later routine turn scheduled still fires (only ones from before the Stop are held)',
    k.statusCode === 200 && r === 'fired' && sent, `stop ${k.statusCode}, fire ${r}, sent ${sent}`)
  process.env.FAKE_CLAUDE_SLEEP_MS = '20000'
}

// ── A stale Resume on a chat that is working again does not mark it idle ────────────────────
{
  const id = 'res-live'
  db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, process_state, sort_order, created_at) VALUES (?, 'f-retry', ?, ?, 'idle', 'idle', 0, 1)").run(id, id, path.join(work, 'retry'))
  const s = await app.inject({ method: 'POST', url: `/api/instances/${id}/send`, payload: { text: 'hi' } })
  await sleep(1500)
  const r = await app.inject({ method: 'POST', url: `/api/instances/${id}/resume` })
  const row = db.prepare('SELECT state FROM instances WHERE id = ?').get(id) as { state: string }
  const pid = pidOf(id)
  if (pid) pids.push(pid)
  check('Resume on a chat that is working does not write idle over its live agent',
    s.statusCode === 200 && r.statusCode === 200 && !!pid && row.state === 'running', `send ${s.statusCode}, resume ${r.statusCode} ${r.body}, agent ${pid ?? 'none'}, state ${row.state}`)
  if (reg.isTracked(id)) await reg.killProcess(id)
}

// ── A wake-up the stopped turn asks for DURING the Stop is not scheduled ─────────────────────
// (the stop is marked when it begins, but the dying agent's
// output is still read while the kill runs; a ScheduleWakeup read then was stamped after the
// stop and so passed the "armed before the stop" check, restarting the chat later)
{
  const id = 'w-window'
  db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, process_state, sort_order, created_at) VALUES (?, 'f-retry', ?, ?, 'idle', 'idle', 0, 1)").run(id, id, path.join(work, 'retry'))
  const out = path.join(fakeHome, 'late-wakeup.jsonl')
  fs.writeFileSync(out, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_window', name: 'ScheduleWakeup', input: { delaySeconds: 600, prompt: 'check back later' } }] } }) + '\n')
  process.env.FAKE_CLAUDE_STDOUT_FILE = out
  process.env.FAKE_CLAUDE_STDOUT_DELAY_MS = '900'
  const s = await app.inject({ method: 'POST', url: `/api/instances/${id}/send`, payload: { text: 'hi' } })
  await sleep(500)
  // Stop lands before the agent prints its ScheduleWakeup; the kill is still running when it does.
  const k = await app.inject({ method: 'POST', url: `/api/instances/${id}/kill` })
  delete process.env.FAKE_CLAUDE_STDOUT_FILE
  delete process.env.FAKE_CLAUDE_STDOUT_DELAY_MS
  await sleep(500)
  const rows = db.prepare('SELECT status FROM scheduled_wakeups WHERE instance_id = ?').all(id) as Array<{ status: string }>
  const pending = rows.filter(r => r.status === 'pending').length
  check('a wake-up the stopped turn asks for while the Stop is running is not left pending (it would restart the chat)',
    s.statusCode === 200 && k.statusCode === 200 && pending === 0, `send ${s.statusCode}, stop ${k.statusCode}, wake-ups ${JSON.stringify(rows)}`)
}

// ── The sweep after the kill (no snapshot before it) never takes a stranger for ours ─────────
{
  const { treeAfterRootDied, descendantsOf } = await import('../src/services/process-tree.js') as unknown as {
    treeAfterRootDied?: (root: number, startedAt: number, deadAt: number, after: Array<{ pid: number; ppid: number; createdAt: number; name: string }>) => Array<{ pid: number; ppid: number; createdAt: number; name: string }>
    descendantsOf: (root: number, snap: Array<{ pid: number; ppid: number; createdAt: number; name: string }>) => Array<{ pid: number; name: string }>
  }
  const t0 = 1_000_000, dead = t0 + 60_000
  const after = [
    { pid: 50, ppid: 1, createdAt: dead + 200, name: 'recycled-root' },      // a stranger given the dead root's number
    { pid: 51, ppid: 50, createdAt: dead + 300, name: 'recycled-child' },     // ...and its child
    { pid: 52, ppid: 50, createdAt: t0 - 3_600_000, name: 'stranger-old' },   // an old program whose parent number matches
    { pid: 53, ppid: 50, createdAt: t0 + 5_000, name: 'ours' },               // started by our agent while it ran
    { pid: 54, ppid: 53, createdAt: t0 + 6_000, name: 'ours-grandchild' },
  ]
  const names = treeAfterRootDied ? descendantsOf(50, treeAfterRootDied(50, t0, dead, after)).map(p => p.name).sort() : ['(no treeAfterRootDied)']
  check('the post-kill sweep takes only programs our agent started while it ran (not a reused PID\'s, not an older stranger)',
    JSON.stringify(names) === JSON.stringify(['ours', 'ours-grandchild']), names.join(', '))
}

for (const p of pids) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } }
await sleep(300)
for (const d of [path.dirname(fake), fakeHome, work]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* in use a moment longer */ } }
await close()
done()
process.exit(process.exitCode ?? 0)
