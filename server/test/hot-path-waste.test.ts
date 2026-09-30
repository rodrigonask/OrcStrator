// Small server hot-path waste. session_id rewritten on every system event, the full
// card prompt built on every poll of a busy card, one query a minute per idle chat in the cache
// advisor, UTC day buckets in the savings chart, and advisor maps that never shrink.
// Agents are the fake claude binary; nothing real is read, written or spent.
//
//   npx tsx server/test/hot-path-waste.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildFakeClaude, sleep } from './helpers/fake-claude.js'

const fake = buildFakeClaude()
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-c7-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.ORCSTRATOR_CLAUDE_PATH = fake
process.env.FAKE_CLAUDE_SLEEP_MS = '1200'

const { scratchApp, check, done } = await import('./helpers/scratch-app.js')
const { app, db, close } = await scratchApp(['instances', 'folders', 'pipeline', 'settings'])
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-c7-work-'))
db.prepare('INSERT INTO folders (id, path, name) VALUES (?, ?, ?)').run('f', work, 'p')
const addChat = (id: string, extra: { sessionId?: string | null; processState?: string; ctx?: number; keepWarm?: number } = {}) =>
  db.prepare("INSERT INTO instances (id, folder_id, name, cwd, session_id, state, process_state, ctx_tokens, keep_warm, sort_order, created_at) VALUES (?, 'f', ?, ?, ?, 'idle', ?, ?, ?, 0, 1)")
    .run(id, id, work, extra.sessionId ?? null, extra.processState ?? 'idle', extra.ctx ?? null, extra.keepWarm ?? 0)
const waitIdle = async (id: string, ms = 15_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const r = db.prepare('SELECT process_state FROM instances WHERE id = ?').get(id) as { process_state: string } | undefined
    if (r?.process_state === 'idle') return true
    await sleep(200)
  }
  return false
}

/** Every SQL text prepared while `fn` runs. */
async function preparedDuring(fn: () => Promise<unknown> | unknown): Promise<string[]> {
  const seen: string[] = []
  const orig = db.prepare.bind(db)
  ;(db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => { seen.push(sql); return orig(sql) }
  try { await fn() } finally { (db as unknown as { prepare: typeof orig }).prepare = orig }
  return seen
}

// ── session_id is written only when it changes ──────────────────────────────────────────
{
  addChat('sid')
  db.exec(`CREATE TABLE c7_sid_writes (n INTEGER);
    CREATE TRIGGER c7_count AFTER UPDATE OF session_id ON instances WHEN NEW.id = 'sid' BEGIN INSERT INTO c7_sid_writes VALUES (1); END;`)
  const out = path.join(work, 'sys.jsonl')
  const sys = (sub: string) => JSON.stringify({ type: 'system', subtype: sub, session_id: 'c7-fixed-session' })
  fs.writeFileSync(out, [sys('init'), sys('hook_started'), sys('hook_response'), sys('status'), sys('hook_started'), sys('hook_response')].join('\n') + '\n')
  process.env.FAKE_CLAUDE_STDOUT_FILE = out
  const r = await app.inject({ method: 'POST', url: '/api/instances/sid/send', payload: { text: 'hi' } })
  check('setup: the turn starts', r.statusCode === 200, `${r.statusCode} ${r.body.slice(0, 120)}`)
  await waitIdle('sid')
  delete process.env.FAKE_CLAUDE_STDOUT_FILE
  const writes = (db.prepare('SELECT COUNT(*) AS n FROM c7_sid_writes').get() as { n: number }).n
  const stored = (db.prepare("SELECT session_id FROM instances WHERE id = 'sid'").get() as { session_id: string }).session_id
  // The fake prints its own init (a fresh id) first, then six events sharing one id: two changes.
  check('six system events repeating one session id write it once, not six times', writes === 2, `${writes} session_id writes for 2 distinct ids`)
  check('... and the stored session id is the latest one', stored === 'c7-fixed-session', stored)
}

// ── A busy card does not build its prompt on every poll ───────────────────────────────────
{
  addChat('busy', { processState: 'running' })
  const created = await app.inject({ method: 'POST', url: '/api/pipelines/f/tasks', payload: { title: 'waits', description: 'long card text', targetInstanceId: 'busy', scheduleKind: 'every', scheduleValue: '600', scheduleEnabled: false } })
  const cardId = (created.json() as { id?: string }).id!
  db.prepare("INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES ('cm1', ?, 'human', 'a comment', 1)").run(cardId)
  const sched = await import('../src/services/task-scheduler.js') as { runTaskNow: (id: string) => Promise<{ ok: boolean; reason?: string }> }
  let result: { ok: boolean; reason?: string } = { ok: false }
  const sql = await preparedDuring(async () => { result = await sched.runTaskNow(cardId) })
  check('setup: a card aimed at a busy chat is refused as busy', !result.ok && result.reason === 'instance-busy', JSON.stringify(result))
  const built = sql.filter(s => /FROM task_comments/i.test(s))
  check('... without building the prompt first (no comments read)', built.length === 0, `${built.length} comment queries`)

  // The row check still refuses an empty verbatim card before anything else.
  addChat('free')
  const empty = await app.inject({ method: 'POST', url: '/api/pipelines/f/tasks', payload: { title: 'empty', description: '/goal x', targetInstanceId: 'free', scheduleKind: 'every', scheduleValue: '600', scheduleEnabled: false } })
  const emptyId = (empty.json() as { id: string }).id
  db.prepare("UPDATE pipeline_tasks SET description = '   ', raw_prompt = 1 WHERE id = ?").run(emptyId)
  const refused = await sched.runTaskNow(emptyId)
  check('an empty verbatim card is still refused with no-prompt (unchanged behaviour)', refused.reason === 'no-prompt', JSON.stringify(refused))
}

// ── The cache advisor only looks at chats it can act on ───────────────────────────────────
const ca = await import('../src/services/cache-advisor.js') as Record<string, unknown>
const tick = ca.runCacheAdvisorTick as ((now?: number) => Promise<void>) | undefined
const stateSize = ca.cacheAdvisorStateSize as (() => number) | undefined
check('setup: one advisor pass can be run on demand (runCacheAdvisorTick)', typeof tick === 'function')
{
  for (const id of ['light1', 'light2', 'light3']) addChat(id, { sessionId: `s-${id}`, ctx: 1000 })
  const sql = await preparedDuring(() => tick?.())
  const perChat = sql.filter(s => /FROM turn_costs WHERE instance_id/i.test(s)).length
  check('idle light chats that are not kept warm cost no per-chat query', typeof tick === 'function' && perChat === 0, `${perChat} turn_costs queries`)
  const main = sql.find(s => /FROM instances/i.test(s) && /keep_warm/i.test(s) && /WHERE/i.test(s)) ?? ''
  check('... the advisor query itself filters to keep_warm or ctx_tokens >= 250000', /keep_warm\s*!=\s*0|keep_warm\s*=\s*1/i.test(main) && /ctx_tokens/.test(main.slice(main.indexOf('WHERE'))), main.replace(/\s+/g, ' ').slice(0, 200))
}

// ── Advisor maps are pruned ───────────────────────────────────────────────────────────────
{
  addChat('heavy', { sessionId: 's-heavy', ctx: 400_000 })
  const suggest = ca.suggestCompactionForQuota as (pct: number) => void
  suggest(95)
  const held = stateSize?.() ?? -1
  await tick?.(Date.now() + 31 * 60 * 1000)
  const after = stateSize?.() ?? -1
  check('a suggestion older than its cooldown is forgotten (the maps shrink)', held >= 1 && after === 0, `held ${held}, after ${after}`)
}

// ── Savings are bucketed by the user's own day ────────────────────────────────────────────
{
  // A time whose local and UTC dates differ: 00:30 local east of UTC, 23:30 local west of it.
  const d = new Date()
  if (d.getTimezoneOffset() > 0) d.setHours(23, 30, 0, 0)
  else d.setHours(0, 30, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  const localDay = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const utcDay = d.toISOString().slice(0, 10)
  db.prepare("INSERT INTO compaction_savings (created_at, session_id, instance_id, folder_id, model, tool_name, before_chars, after_chars, saved_tokens) VALUES (?, 's', NULL, NULL, NULL, 'Bash', 1000, 100, 200)").run(d.getTime())
  const cs = await import('../src/services/compaction-savings.js') as { getCompactionSavingsSummary: (since: number) => { days: Array<{ day: string }> } }
  const days = cs.getCompactionSavingsSummary(d.getTime() - 1000).days.map(x => x.day)
  if (localDay === utcDay) console.log(`NOTE  this machine is on UTC, so the two bucketings agree; the check below cannot tell them apart`)
  check('work done near midnight local time lands on that local day, not the UTC one', days.length === 1 && days[0] === localDay, `buckets ${days.join(',')}, local ${localDay}, utc ${utcDay}`)

  // The usage charts beside it bucket the same way, or one day's cost and savings would sit on
  // two different bars.
  const srcDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'src')
  const utcBuckets = ['routes/usage.ts', 'services/command-registry.ts', 'services/compaction-savings.ts']
    .filter(f => /'unixepoch'\)/.test(fs.readFileSync(path.join(srcDir, f), 'utf8')))
  check('every day bucket in the usage views is the local day', utcBuckets.length === 0, utcBuckets.join(', '))
}

done()
const reg = await import('../src/services/process-registry.js') as { processRegistry: { killAll: () => Promise<void> } }
await reg.processRegistry.killAll()
await close()
for (const dir of [fakeHome, work, path.dirname(fake)]) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* busy */ } }
process.exit(process.exitCode ?? 0)
