// A failed write on the message-saving path was swallowed. Each write is made to fail
// with a SQLite trigger (the shape of a full or locked disk), and the test reads what the
// server says about it: a log line with the chat and the error, and a `server:error` event to
// every open tab. Agents are the fake claude binary; nothing real is read, written or spent.
//
//   npx tsx server/test/persist-errors.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildFakeClaude, sleep } from './helpers/fake-claude.js'

const fake = buildFakeClaude()
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-h2-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.ORCSTRATOR_CLAUDE_PATH = fake
process.env.FAKE_CLAUDE_SLEEP_MS = '1200'

const { scratchApp, check, done } = await import('./helpers/scratch-app.js')
const { app, db, close } = await scratchApp(['instances', 'folders', 'pipeline', 'settings'])
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-h2-work-'))
db.prepare('INSERT INTO folders (id, path, name) VALUES (?, ?, ?)').run('f', work, 'p')
const addChat = (id: string, sessionId: string | null = null) =>
  db.prepare("INSERT INTO instances (id, folder_id, name, cwd, session_id, state, process_state, sort_order, created_at) VALUES (?, 'f', ?, ?, ?, 'idle', 'idle', 0, 1)").run(id, id, work, sessionId)
const waitIdle = async (id: string, ms = 15_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const r = db.prepare('SELECT process_state FROM instances WHERE id = ?').get(id) as { process_state: string } | undefined
    if (r?.process_state === 'idle') return true
    await sleep(200)
  }
  return false
}

// Everything logged to console.error, and every frame a tab would receive.
const errors: string[] = []
const origError = console.error
console.error = (...args: unknown[]) => { errors.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' ')); origError(...args) }
const frames: Array<{ type: string; payload: Record<string, unknown> }> = []
const ws = await import('../src/ws/handler.js') as Record<string, unknown>
const trackClient = ws.trackClient as ((s: unknown) => void) | undefined
trackClient?.({
  OPEN: 1, readyState: 1, bufferedAmount: 0,
  send: (d: string) => { frames.push(JSON.parse(d)) },
  ping: () => {}, terminate: () => {}, close: () => {}, on: () => {},
})
const serverErrors = (site: string, instanceId?: string) =>
  frames.filter(f => f.type === 'server:error' && f.payload.site === site && (instanceId === undefined || f.payload.instanceId === instanceId))
const logged = (re: RegExp) => errors.some(e => re.test(e))
const fail = (name: string, when: string) =>
  db.exec(`CREATE TRIGGER ${name} ${when} BEGIN SELECT RAISE(ABORT, 'database or disk is full (simulated)'); END;`)

// ── A system note that cannot be saved ────────────────────────────────────────────────────
{
  addChat('note1')
  fail('h2_sys', "BEFORE INSERT ON messages WHEN NEW.role = 'system'")
  const cp = await import('../src/services/claude-process.js') as { broadcastSystemNote: (id: string, t: string) => void }
  cp.broadcastSystemNote('note1', 'hello')
  db.exec('DROP TRIGGER h2_sys')
  check('a system note that fails to save is logged with the chat and the error', logged(/note1/) && logged(/disk is full/), errors.slice(-1)[0] ?? 'nothing logged')
  const ev = serverErrors('system-note', 'note1')[0]
  check('... and every open tab is told, in plain words (server:error)', !!ev && typeof ev.payload.message === 'string' && /could not be saved/.test(ev.payload.message as string), ev ? String(ev.payload.message) : 'no server:error event')
}

// ── The session id of a running turn cannot be saved ─────────────────────────────────────
{
  addChat('sid1')
  fail('h2_sid', 'BEFORE UPDATE OF session_id ON instances')
  const r = await app.inject({ method: 'POST', url: '/api/instances/sid1/send', payload: { text: 'hi' } })
  check('setup: the turn starts', r.statusCode === 200, `${r.statusCode} ${r.body.slice(0, 160)}`)
  await waitIdle('sid1')
  db.exec('DROP TRIGGER h2_sid')
  check('a session id that fails to save is logged with the chat', errors.some(e => /session/i.test(e) && /sid1/.test(e) && /disk is full/.test(e)), errors.filter(e => /sid1/.test(e)).slice(-1)[0] ?? 'nothing logged for sid1')
  check('... and surfaced as server:error (reopening the chat may start a fresh conversation)', serverErrors('session-id', 'sid1').length > 0)
}

// ── An assistant reply that cannot be saved ──────────────────────────────────────────────
{
  addChat('asst1')
  const out = path.join(work, 'asst.jsonl')
  fs.writeFileSync(out, JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'a reply' }] } }) + '\n')
  process.env.FAKE_CLAUDE_STDOUT_FILE = out
  fail('h2_asst', "BEFORE INSERT ON messages WHEN NEW.role = 'assistant'")
  await app.inject({ method: 'POST', url: '/api/instances/asst1/send', payload: { text: 'hi' } })
  await waitIdle('asst1')
  delete process.env.FAKE_CLAUDE_STDOUT_FILE
  db.exec('DROP TRIGGER h2_asst')
  check('an assistant reply that fails to save is logged with the chat', errors.some(e => /asst1/.test(e) && /disk is full/.test(e)), errors.filter(e => /asst1/.test(e)).slice(-1)[0] ?? 'nothing logged for asst1')
  check('... and surfaced as server:error', serverErrors('assistant-message', 'asst1').length > 0)
}

// ── A scheduled card whose prompt cannot be saved to the chat ────────────────────────────
{
  addChat('rt1')
  const created = await app.inject({ method: 'POST', url: '/api/pipelines/f/tasks', payload: { title: 'routine', description: 'do the thing', targetInstanceId: 'rt1', scheduleKind: 'every', scheduleValue: '600', scheduleEnabled: false } })
  const cardId = (created.json() as { id?: string }).id
  check('setup: a card aimed at the chat exists', !!cardId, `${created.statusCode} ${created.body.slice(0, 160)}`)
  fail('h2_rt', "BEFORE INSERT ON messages WHEN NEW.role = 'user' AND NEW.instance_id = 'rt1'")
  const sched = await import('../src/services/task-scheduler.js') as { runTaskNow: (id: string) => Promise<{ ok: boolean; reason?: string }> }
  const fired = cardId ? await sched.runTaskNow(cardId) : { ok: false, reason: 'no card' }
  db.exec('DROP TRIGGER h2_rt')
  await waitIdle('rt1')
  check('setup: the card fires', fired.ok, JSON.stringify(fired))
  check('a routine prompt that fails to save is logged with the chat', errors.some(e => /rt1/.test(e) && /disk is full/.test(e)), errors.filter(e => /rt1/.test(e)).slice(-1)[0] ?? 'nothing logged for rt1')
  check('... and surfaced as server:error', serverErrors('routine-message', 'rt1').length > 0)
}

// ── uncaughtException: an explicit decision ─────────────────────────────────────────────────
{
  const index = fs.readFileSync('server/src/index.ts', 'utf8')
  let handler: ((kind: 'exception' | 'rejection', err: unknown) => void) | undefined
  let install: (() => void) | undefined
  try {
    const pe = await import('../src/services/process-errors.js') as Record<string, unknown>
    handler = pe.handleUncaught as typeof handler
    install = pe.installProcessErrorHandlers as typeof install
  } catch { /* the source tree before this fix: reported below */ }
  check('the server installs a handler for uncaught exceptions as well as rejections', /installProcessErrorHandlers\(\)/.test(index) && typeof install === 'function')
  const before = process.listenerCount('uncaughtException')
  install?.()
  check('... which really registers on the process', process.listenerCount('uncaughtException') === before + 1, `${before} -> ${process.listenerCount('uncaughtException')}`)
  handler?.('exception', new Error('boom from a timer'))
  check('an uncaught exception is logged with its stack and the server keeps running', logged(/Uncaught exception/) && logged(/boom from a timer/))
  check('... and shown to the user as server:error', serverErrors('process').length > 0)
}

// ── The throttle is per chat ──────────────────────────────────
{
  const pe = await import('../src/services/persist-errors.js') as { reportPersistFailure: (s: string, e: unknown, c?: { instanceId?: string }) => void; resetPersistFailureThrottle: () => void }
  pe.resetPersistFailureThrottle()
  pe.reportPersistFailure('assistant-message', new Error('disk full'), { instanceId: 'thr-a' })
  pe.reportPersistFailure('assistant-message', new Error('disk full'), { instanceId: 'thr-b' })
  pe.reportPersistFailure('assistant-message', new Error('disk full'), { instanceId: 'thr-a' })
  check('a failure in one chat does not silence the same failure in another chat',
    serverErrors('assistant-message', 'thr-a').length === 1 && serverErrors('assistant-message', 'thr-b').length === 1,
    `a ${serverErrors('assistant-message', 'thr-a').length}, b ${serverErrors('assistant-message', 'thr-b').length}`)
}

done()
console.error = origError
const reg = await import('../src/services/process-registry.js') as { processRegistry: { killAll: () => Promise<void> } }
await reg.processRegistry.killAll()
await close()
for (const d of [fakeHome, work, path.dirname(fake)]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* busy */ } }
process.exit(process.exitCode ?? 0)
