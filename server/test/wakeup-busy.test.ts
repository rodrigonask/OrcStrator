// A wake-up never fires into a busy chat (sendMessage would kill the running turn),
// and it is marked fired only after its turn actually starts.
//
//   npx tsx server/test/wakeup-busy.test.ts

import { scratchApp, check, done } from './helpers/scratch-app.js'

const { db, close } = await scratchApp([])
const ws = await import('../src/services/wakeup-scheduler.js') as Record<string, unknown>
const { scheduleWakeup, stopWakeupScheduler } = await import('../src/services/wakeup-scheduler.js')
type Fire = (id: string, send?: (o: unknown) => Promise<unknown>) => Promise<string>
const fireWakeup = ws.fireWakeup as Fire | undefined

db.prepare("INSERT INTO folders (id, path, name) VALUES ('f', 'C:/tmp/p', 'p')").run()
db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, process_state, sort_order, created_at) VALUES ('busy', 'f', 'b', 'C:/tmp/p', 'running', 'running', 0, 1)").run()
db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, process_state, sort_order, created_at) VALUES ('idle', 'f', 'i', 'C:/tmp/p', 'idle', 'idle', 1, 2)").run()

const status = (id: string) => db.prepare('SELECT status, fire_at FROM scheduled_wakeups WHERE id = ?').get(id) as { status: string; fire_at: number }

check('the fire path is exported for testing (fireWakeup)', typeof fireWakeup === 'function')
if (fireWakeup) {
  // ── busy chat: deferred, never sent ─────────────────────────────────────────────
  const w1 = scheduleWakeup({ instanceId: 'busy', delaySeconds: 60, prompt: 'check in' })
  const before = status(w1.id).fire_at
  let sent = 0
  const r1 = await fireWakeup(w1.id, async () => { sent++ })
  check('a wake-up due on a busy chat is deferred', r1 === 'deferred', r1)
  check('... and nothing is sent into the running turn', sent === 0, `sent ${sent}`)
  check('... it stays pending, pushed later', status(w1.id).status === 'pending' && status(w1.id).fire_at >= before, JSON.stringify(status(w1.id)))

  // ── idle chat, send fails: back to pending, not lost ───────────────────────────────
  const w2 = scheduleWakeup({ instanceId: 'idle', delaySeconds: 60, prompt: 'check in' })
  const r2 = await fireWakeup(w2.id, async () => { throw new Error('spawn failed') })
  check('a failed send is retried, not marked fired', r2 === 'retry' && status(w2.id).status === 'pending', `${r2} ${status(w2.id).status}`)
  await fireWakeup(w2.id, async () => { throw new Error('spawn failed') })
  const r2c = await fireWakeup(w2.id, async () => { throw new Error('spawn failed') })
  check('after 3 failed sends it is marked failed (visible), not silently fired', r2c === 'failed' && status(w2.id).status === 'failed', `${r2c} ${status(w2.id).status}`)

  // ── idle chat, send succeeds: fired after the send, and never cancelled by it ─────────
  const w3 = scheduleWakeup({ instanceId: 'idle', delaySeconds: 60, prompt: 'check in' })
  let statusDuringSend = ''
  const r3 = await fireWakeup(w3.id, async () => {
    statusDuringSend = status(w3.id).status
    // sendMessage cancels every PENDING wake-up of the chat; the one sending must survive that.
    db.prepare("UPDATE scheduled_wakeups SET status = 'cancelled' WHERE instance_id = 'idle' AND status = 'pending'").run()
  })
  check('while the turn is starting the wake-up is "firing", not "fired"', statusDuringSend === 'firing', statusDuringSend)
  check('once the send succeeds it is fired', r3 === 'fired' && status(w3.id).status === 'fired', `${r3} ${status(w3.id).status}`)
  const again = await fireWakeup(w3.id, async () => { sent++ })
  check('a fired wake-up can never fire twice', again === 'skipped' && sent === 0, again)
}

stopWakeupScheduler()
await close()
done()
