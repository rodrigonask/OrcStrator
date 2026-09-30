// Keep-warm had no auto-expiry, and the keep-alive turn reset its own clock. A chat
// nobody has used for 12 hours now has keep-warm switched off, however many pings it had.
// Agents are the fake claude binary (only as a safety net: no turn should start here).
//
//   npx tsx server/test/keep-warm-expiry.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildFakeClaude } from './helpers/fake-claude.js'

const fake = buildFakeClaude()
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-c8-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.ORCSTRATOR_CLAUDE_PATH = fake
process.env.FAKE_CLAUDE_SLEEP_MS = '500'

const { scratchApp, check, done } = await import('./helpers/scratch-app.js')
const { app, db, close } = await scratchApp(['instances', 'folders'])
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-c8-work-'))
db.prepare('INSERT INTO folders (id, path, name) VALUES (?, ?, ?)').run('f', work, 'p')

const H = 3_600_000
const now = Date.now()
const addChat = (id: string, keepWarm: number) =>
  db.prepare("INSERT INTO instances (id, folder_id, name, cwd, session_id, state, process_state, ctx_tokens, ctx_model, keep_warm, sort_order, created_at) VALUES (?, 'f', ?, ?, ?, 'idle', 'idle', 1000, 'claude-haiku-4-5', ?, 0, 1)")
    .run(id, id, work, `s-${id}`, keepWarm)
let n = 0
const userMsg = (id: string, text: string, at: number) =>
  db.prepare("INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)").run(`m${++n}`, id, JSON.stringify([{ type: 'text', text }]), at)
const turn = (id: string, at: number) =>
  db.prepare("INSERT INTO turn_costs (instance_id, folder_id, session_id, turn_index, input_tokens, output_tokens, cost_usd, created_at) VALUES (?, 'f', ?, ?, 10, 1, 0.001, ?)").run(id, `s-${id}`, ++n, at)
const keepWarmOf = (id: string) => (db.prepare('SELECT keep_warm FROM instances WHERE id = ?').get(id) as { keep_warm: number }).keep_warm

// A: switched on 13 h ago, last typed message 13 h ago, then a keep-alive ping every hour since,
// the last one 57 min ago (so its cache is inside the keep-warm fire window right now).
addChat('forgotten', now - 13 * H)
userMsg('forgotten', 'the last thing the user typed', now - 13 * H)
for (let h = 12; h >= 1; h--) { userMsg('forgotten', '🔥 keep-warm', now - h * H + 3 * 60_000); turn('forgotten', now - h * H + 3 * 60_000) }

// B: last typed message two days ago, but the user switches the chip on right now (the route).
addChat('fresh-toggle', 0)
userMsg('fresh-toggle', 'old message', now - 48 * H)
turn('fresh-toggle', now - 10 * 60_000)
const r = await app.inject({ method: 'POST', url: '/api/instances/fresh-toggle/keep-warm', payload: { enabled: true } })
check('setup: the chip can be switched on', r.statusCode === 200, `${r.statusCode} ${r.body.slice(0, 120)}`)
check('switching keep-warm on records when (so the idle clock starts there)', keepWarmOf('fresh-toggle') > 1_000_000_000_000, String(keepWarmOf('fresh-toggle')))

// C: on since before this change (keep_warm = 1), typed in an hour ago.
addChat('in-use', 1)
userMsg('in-use', 'recent', now - H)
turn('in-use', now - 10 * 60_000)

const ca = await import('../src/services/cache-advisor.js') as Record<string, unknown>
const tick = ca.runCacheAdvisorTick as ((at?: number) => Promise<void>) | undefined
check('setup: one advisor pass can be run on demand (runCacheAdvisorTick)', typeof tick === 'function')
const pingsBefore = (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE instance_id = 'forgotten'").get() as { c: number }).c
await tick?.()

check('keep-warm switches itself off after 12 hours with no real message, keep-alive pings notwithstanding', typeof tick === 'function' && keepWarmOf('forgotten') === 0, `keep_warm ${keepWarmOf('forgotten')}`)
const newRows = db.prepare("SELECT role, content FROM messages WHERE instance_id = 'forgotten' ORDER BY rowid DESC LIMIT 5").all() as Array<{ role: string; content: string }>
const pingsAfter = (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE instance_id = 'forgotten'").get() as { c: number }).c
check('... no new keep-alive ping is sent to it', typeof tick === 'function' && !newRows.slice(0, pingsAfter - pingsBefore).some(m => m.role === 'user' && m.content.includes('keep-warm')))
check('... and the chat says why, in plain words', newRows.some(m => m.role === 'system' && /switched itself off/.test(m.content)), newRows.map(m => m.role).join(','))
check('a chip switched on just now stays on, even on a chat untouched for two days', typeof tick === 'function' && keepWarmOf('fresh-toggle') > 0)
check('a chip on a chat used an hour ago stays on (older rows holding 1 still work)', typeof tick === 'function' && keepWarmOf('in-use') === 1)

// The keep-alive note itself never moves the clock.
const last = ca.lastHumanActivityAt as ((id: string, kw: number) => number) | undefined
check('the idle clock skips the keep-alive notes', typeof last === 'function' && Math.abs(last('forgotten', 0) - (now - 13 * H)) < 1000, last ? String(now - last('forgotten', 0)) : 'missing')

done()
const reg = await import('../src/services/process-registry.js') as { processRegistry: { killAll: () => Promise<void> } }
await reg.processRegistry.killAll()
await close()
for (const dir of [fakeHome, work, path.dirname(fake)]) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* busy */ } }
process.exit(process.exitCode ?? 0)
