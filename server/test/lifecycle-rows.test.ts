// The rest of the process
// lifecycle batch. Agents are the fake claude binary (helpers/fake-claude.ts); git runs against
// temp repos; transcripts live in a temp home. Nothing real is read, written or spent.
//
//   npx tsx server/test/lifecycle-rows.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { buildFakeClaude, sleep } from './helpers/fake-claude.js'

const fake = buildFakeClaude()
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-rows-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.ORCSTRATOR_CLAUDE_PATH = fake
process.env.FAKE_CLAUDE_SLEEP_MS = '1500'
process.env.ORCSTRATOR_MAX_LINE_CHARS = '150000'

const { scratchApp, check, done } = await import('./helpers/scratch-app.js')
const { app, db, close, dataDir } = await scratchApp(['instances', 'folders', 'pipeline', 'sessions', 'settings', 'state', 'profile'])
const inProcDataDir = () => dataDir
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-rows-work-'))
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
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' }).toString()
const locks = await import('../src/services/file-locks.js') as Record<string, unknown>
const norm = (p: string) => path.normalize(p).toLowerCase()

// ── Background git never takes the index lock ─────────────────────────────────────────
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-rows-git6-'))
  git(repo, 'init', '-q')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init')
  // A tracked file whose stat changed but content did not: a plain `git status` refreshes
  // the index and rewrites it (taking index.lock); --no-optional-locks must not.
  await sleep(1100)
  const t = new Date(); fs.utimesSync(path.join(repo, 'a.txt'), t, t)
  const idx = path.join(repo, '.git', 'index')
  const before = fs.statSync(idx).mtimeMs
  await (locks.onTurnEnd as (id: string, cwd: string) => Promise<void>)('x', repo)
  const after = fs.statSync(idx).mtimeMs
  check('the background git status does not rewrite (lock) the index', after === before, `index mtime ${before} -> ${after}`)
}

// ── Locks are not silently released (non-ASCII names, git errors) ──────────────────────────
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-rows-git7-'))
  git(repo, 'init', '-q')
  const accented = path.join(repo, 'ação.ts')
  fs.writeFileSync(accented, 'x\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init')
  fs.writeFileSync(accented, 'changed\n') // dirty, tracked
  addChat('lk')
  db.prepare('INSERT INTO file_locks (id, instance_id, cwd, path, created_at) VALUES (?, ?, ?, ?, ?)').run('L1', 'lk', norm(repo), norm(accented), Date.now())
  await (locks.onTurnEnd as (id: string, cwd: string) => Promise<void>)('lk', repo)
  const kept = db.prepare("SELECT COUNT(*) AS n FROM file_locks WHERE id = 'L1'").get() as { n: number }
  check('the lock on a dirty file with an accented name survives the turn end', kept.n === 1)

  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-rows-norepo-'))
  db.prepare('INSERT INTO file_locks (id, instance_id, cwd, path, created_at) VALUES (?, ?, ?, ?, ?)').run('L2', 'lk', norm(notRepo), norm(path.join(notRepo, 'x.ts')), Date.now())
  await (locks.onTurnEnd as (id: string, cwd: string) => Promise<void>)('lk', notRepo)
  const kept2 = db.prepare("SELECT COUNT(*) AS n FROM file_locks WHERE id = 'L2'").get() as { n: number }
  check('when git fails, locks are kept (never read as "all clean")', kept2.n === 1)
}

// ── Nothing on the kill or lock path blocks the event loop ─────────────────────────────
{
  const reg = fs.readFileSync('server/src/services/process-registry.ts', 'utf8')
  const fl = fs.readFileSync('server/src/services/file-locks.ts', 'utf8')
  check('process-registry.ts has no execSync (the kill path is async)', !/execSync\(/.test(reg))
  check('file-locks.ts has no execFileSync (git calls are async)', !/execFileSync\(/.test(fl))
  const res = (locks.noteEdit as (a: string, b: string, c: string) => unknown)('lk', work, path.join(work, 'z.ts'))
  check('the edit-conflict re-check is asynchronous (noteEdit returns a promise)', res instanceof Promise)
  if (res instanceof Promise) await res
}

// ── The transcript sanitizer ───────────────────────────────────────────────────
{
  const san = await import('../src/services/session-sanitizer.js') as Record<string, unknown>
  const sid = crypto.randomUUID()
  const slug = work.replace(/[^a-zA-Z0-9]/g, '-')
  const dir = path.join(fakeHome, '.claude', 'projects', slug)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sid}.jsonl`)
  const big = 'A'.repeat(2000)
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }] } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } },
  ]
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  await (san.sanitizeSession as (c: string, s: string) => Promise<void>)(work, sid)
  const out = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const a1 = out.find(e => e.uuid === 'a1')
  check('a message whose only block was empty is not left with empty content', Array.isArray(a1?.message?.content) && a1.message.content.length > 0, JSON.stringify(a1?.message?.content))
  check('... and the entry itself is kept (the transcript chain is intact)', !!a1 && a1.parentUuid === 'u1')

  const withLock = san.withSessionFileLock as ((f: string, fn: () => Promise<void>) => Promise<void>) | undefined
  check('sanitize passes over one file are serialized (withSessionFileLock)', typeof withLock === 'function')
  if (withLock) {
    const log: string[] = []
    const pass = (n: string) => async () => { log.push(`${n}+`); await sleep(150); log.push(`${n}-`) }
    await Promise.all([withLock(file, pass('a')), withLock(file.toUpperCase(), pass('b'))])
    check('... a second pass waits for the first (no interleaving)', log.join(',') === 'a+,a-,b+,b-', log.join(','))
  }
}

// ── The agent's environment, and its output decoding ─────────────────────────────
{
  addChat('env')
  const dump = path.join(work, 'env.txt')
  const stdoutFile = path.join(work, 'out.jsonl')
  const text = 'ação coração 🎉 '.repeat(6000)
  fs.writeFileSync(stdoutFile, JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text }] } }) + '\n', 'utf8')
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  process.env.CLAUDE_CODE_SSE_PORT = '1234'
  process.env.npm_lifecycle_event = 'dev'
  process.env.ORCSTRATOR_SECRET_SETTING = 'server-only'
  process.env.CLAUDE_CODE_GIT_BASH_PATH = 'C:\\Git\\bin\\bash.exe'
  process.env.FAKE_CLAUDE_ENVDUMP = dump
  process.env.FAKE_CLAUDE_STDOUT_FILE = stdoutFile
  const r = await app.inject({ method: 'POST', url: '/api/instances/env/send', payload: { text: 'hi' } })
  check('setup: the turn starts', r.statusCode === 200, `${r.statusCode} ${r.body.slice(0, 120)}`)
  await waitIdle('env')
  delete process.env.FAKE_CLAUDE_ENVDUMP
  delete process.env.FAKE_CLAUDE_STDOUT_FILE
  const env = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : ''
  const has = (k: string) => new RegExp(`^${k}=`, 'mi').test(env)
  check('a Claude Code session\'s own variables do not reach the agent', env.length > 0 && !has('CLAUDE_CODE_ENTRYPOINT') && !has('CLAUDE_CODE_SSE_PORT'), env ? '' : 'no env dump')
  check('npm\'s variables do not reach the agent', env.length > 0 && !has('npm_lifecycle_event'))
  check('the server\'s own settings do not reach the agent (its chat id still does)', env.length > 0 && !has('ORCSTRATOR_SECRET_SETTING') && has('ORCSTRATOR_INSTANCE_ID'))
  check('deliberate CLI configuration is kept (git-bash path, PATH)', has('CLAUDE_CODE_GIT_BASH_PATH') && has('PATH'))

  const row = db.prepare("SELECT content FROM messages WHERE instance_id = 'env' AND role = 'assistant' ORDER BY created_at DESC LIMIT 1").get() as { content: string } | undefined
  const saved = row ? (JSON.parse(row.content) as Array<{ text?: string }>)[0]?.text ?? '' : ''
  check('accented text and emoji split across output chunks are saved intact (no replacement characters)', saved.length > 0 && !saved.includes('\uFFFD') && saved === text, row ? `${(saved.match(/\uFFFD/g) ?? []).length} replacement chars` : 'no message saved')

  const cp = await import('../src/services/claude-process.js') as Record<string, unknown>
  const split = cp.splitLines as ((p: string, c: string) => string[]) | undefined
  check('only the new chunk is scanned for line breaks (splitLines)', !!split && JSON.stringify(split('ab', 'c\nd\ne')) === JSON.stringify(['abc', 'd', 'e']) && JSON.stringify(split('ab', 'cd')) === JSON.stringify(['abcd']))
  for (const k of ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'npm_lifecycle_event', 'ORCSTRATOR_SECRET_SETTING', 'CLAUDE_CODE_GIT_BASH_PATH']) delete process.env[k]
}

// ── The agent limit ─────────────────────────────────────────────────────────────────
{
  addChat('lim1'); addChat('lim2')
  process.env.FAKE_CLAUDE_SLEEP_MS = '6000'
  const reg = await import('../src/services/process-registry.js') as Record<string, unknown>
  // Off by default: two chats run side by side even with the cap at 1.
  await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxConcurrentProcesses: 1 } })
  const a = await app.inject({ method: 'POST', url: '/api/instances/lim1/send', payload: { text: 'a' } })
  const b = await app.inject({ method: 'POST', url: '/api/instances/lim2/send', payload: { text: 'b' } })
  check('with the limit off (the default), nothing is refused', a.statusCode === 200 && b.statusCode === 200, `${a.statusCode} ${b.statusCode}`)
  const kill = reg.processRegistry as { killProcess: (id: string) => Promise<boolean> }
  await kill.killProcess('lim1'); await kill.killProcess('lim2')
  await waitIdle('lim1'); await waitIdle('lim2')

  await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxConcurrentProcesses: 1, maxConcurrentLimitOn: true } })
  const c = await app.inject({ method: 'POST', url: '/api/instances/lim1/send', payload: { text: 'c' } })
  const d = await app.inject({ method: 'POST', url: '/api/instances/lim2/send', payload: { text: 'd' } })
  check('switched on at 1: the first chat starts', c.statusCode === 200, String(c.statusCode))
  check('... and a second chat is refused with a plain reason', d.statusCode === 409 && /limit of 1/.test(d.body), `${d.statusCode} ${d.body.slice(0, 140)}`)
  const stored = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE instance_id = 'lim2' AND role = 'user'").get() as { n: number }
  check('... leaving no message behind in the refused chat', stored.n === 1, `${stored.n} user messages (1 from the first round)`)
  const health = (await app.inject({ method: 'GET', url: '/api/health' })).json() as Record<string, unknown>
  check('/health says whether the cap is enforced', health.maxProcessesEnforced === true && health.maxProcesses === 1, JSON.stringify({ e: health.maxProcessesEnforced, m: health.maxProcesses }))
  await kill.killProcess('lim1')
  await waitIdle('lim1')
  await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxConcurrentLimitOn: false, maxConcurrentProcesses: 8 } })
  process.env.FAKE_CLAUDE_SLEEP_MS = '1500'
}

// ── Wake-ups ────────────────────────────────────────────────────────────────────────
{
  addChat('w1'); addChat('w2')
  const ws = await import('../src/services/wakeup-scheduler.js') as Record<string, unknown>
  const schedule = ws.scheduleWakeup as (o: { instanceId: string; delaySeconds: number; prompt: string; toolUseId?: string }) => { id: string }
  const made: string[] = []
  let refused = 0
  for (let i = 0; i < 8; i++) {
    try { made.push(schedule({ instanceId: 'w1', delaySeconds: 600, prompt: `p${i}`, toolUseId: `t${i}` }).id) } catch { refused++ }
  }
  const pending = (db.prepare("SELECT COUNT(*) AS n FROM scheduled_wakeups WHERE instance_id = 'w1' AND status = 'pending'").get() as { n: number }).n
  check('one chat cannot pile up wake-ups (capped at 5 pending)', pending === 5 && refused === 3, `${pending} pending, ${refused} refused`)
  const again = schedule({ instanceId: 'w2', delaySeconds: 600, prompt: 'x', toolUseId: 'same' })
  const again2 = (() => { try { return schedule({ instanceId: 'w2', delaySeconds: 600, prompt: 'x', toolUseId: 'same' }) } catch { return null } })()
  const w2 = (db.prepare("SELECT COUNT(*) AS n FROM scheduled_wakeups WHERE instance_id = 'w2'").get() as { n: number }).n
  check('the same tool call seen twice is one wake-up', w2 === 1 && again2?.id === again.id, `${w2} rows`)
  const cross = await app.inject({ method: 'DELETE', url: `/api/instances/w2/wakeups/${made[0]}` })
  const still = (db.prepare('SELECT status FROM scheduled_wakeups WHERE id = ?').get(made[0]) as { status: string }).status
  check('one chat\'s URL cannot cancel another chat\'s wake-up', cross.statusCode === 404 && still === 'pending', `${cross.statusCode} ${still}`)
  const own = await app.inject({ method: 'DELETE', url: `/api/instances/w1/wakeups/${made[0]}` })
  check('... its own chat still can', own.statusCode === 200)
  ;(ws.stopWakeupScheduler as () => void)?.()
}

// ── Resuming one session twice at once → one chat ───────────────────────────────────────
{
  const sid = crypto.randomUUID()
  const slug = work.replace(/[^a-zA-Z0-9]/g, '-')
  const dir = path.join(fakeHome, '.claude', 'projects', slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'user', cwd: work, sessionId: sid, message: { role: 'user', content: 'hello' } }) + '\n')
  const [r1, r2] = await Promise.all([
    app.inject({ method: 'POST', url: `/api/sessions/${sid}/resume` }),
    app.inject({ method: 'POST', url: `/api/sessions/${sid}/resume` }),
  ])
  const bound = (db.prepare('SELECT COUNT(*) AS n FROM instances WHERE session_id = ?').get(sid) as { n: number }).n
  const ids = [r1, r2].map(r => (r.json() as { instanceId?: string }).instanceId)
  check('two resumes of one session at once bind it to exactly ONE chat', bound === 1, `${bound} chats (${r1.statusCode}/${r2.statusCode})`)
  check('... and both callers are handed that chat', !!ids[0] && ids[0] === ids[1], ids.join(' vs '))
}

// ── A manual Start and a scheduled fire of the same card → one run ─────────────────────────
{
  process.env.FAKE_CLAUDE_SLEEP_MS = '4000'
  const card = (await app.inject({ method: 'POST', url: '/api/pipelines/f/tasks', payload: { title: 'nightly', description: 'report', scheduleKind: 'every', scheduleValue: '60', scheduleEnabled: true, rawPrompt: true } })).json() as { id: string }
  const before = (db.prepare("SELECT COUNT(*) AS n FROM instances WHERE folder_id = 'f'").get() as { n: number }).n
  const [s1, s2] = await Promise.all([
    app.inject({ method: 'POST', url: `/api/pipelines/f/tasks/${card.id}/start`, payload: {} }),
    app.inject({ method: 'POST', url: `/api/pipelines/f/tasks/${card.id}/run-now` }),
  ])
  const after = (db.prepare("SELECT COUNT(*) AS n FROM instances WHERE folder_id = 'f'").get() as { n: number }).n
  const runs = (db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?').get(card.id) as { n: number }).n
  check('a manual Start racing a scheduled fire of the same card starts it ONCE', after - before === 1, `${after - before} chats opened, ${runs} run rows, statuses ${s1.statusCode}/${s2.statusCode}`)
  check('... the one that lost is told why (409)', [s1.statusCode, s2.statusCode].includes(409), `${s1.statusCode}/${s2.statusCode} ${s1.body.slice(0, 80)} | ${s2.body.slice(0, 80)}`)
  const reg = await import('../src/services/process-registry.js') as { processRegistry: { killAll: () => Promise<void> } }
  await reg.processRegistry.killAll()
}

// ── A line appended while a pass runs is not lost ────────────────────────────────────────
{
  const san = await import('../src/services/session-sanitizer.js') as Record<string, unknown>
  const sid = crypto.randomUUID()
  const dir = path.join(fakeHome, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sid}.jsonl`)
  const img = { type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(200_000) } }] } }
  fs.writeFileSync(file, Array.from({ length: 150 }, (_, i) => JSON.stringify({ ...img, uuid: `u${i}` })).join('\n') + '\n')
  const pass = (san.sanitizeSession as (c: string, s: string) => Promise<void>)(work, sid)
  await sleep(15)
  // The CLI, running again, appends a line while the pass is copying the file.
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'late', message: { role: 'assistant', content: [{ type: 'text', text: 'appended during the pass' }] } }) + '\n')
  await pass
  const kept = fs.readFileSync(file, 'utf8').includes('appended during the pass')
  check('a line the CLI appends while a sanitize pass runs is not thrown away by its rename', kept)
}

// ── A runaway line is capped, and its tail does not leak in as text ───────────────────────
{
  addChat('cap')
  const stdoutFile = path.join(work, 'cap.jsonl')
  const after = { type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'after-cap' }] } }
  fs.writeFileSync(stdoutFile, 'z'.repeat(400_000) + '\n' + JSON.stringify(after) + '\n', 'utf8')
  const warned: string[] = []
  const realWarn = console.warn
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); realWarn(...a) }
  process.env.FAKE_CLAUDE_STDOUT_FILE = stdoutFile
  await app.inject({ method: 'POST', url: '/api/instances/cap/send', payload: { text: 'hi' } })
  await waitIdle('cap')
  delete process.env.FAKE_CLAUDE_STDOUT_FILE
  console.warn = realWarn
  const rows = db.prepare("SELECT content FROM messages WHERE instance_id = 'cap' AND role = 'assistant'").all() as Array<{ content: string }>
  check('a 400 KB line with no newline is dropped at the cap (the buffer does not grow without limit)', warned.some(w => /without a newline/.test(w)), `${warned.filter(w => /newline/.test(w)).length} warning(s)`)
  check('... the next real line still arrives', rows.some(r => r.content.includes('after-cap')))
  check('... and none of the dropped line leaks into the chat', !rows.some(r => r.content.includes('zzzz')))
}

// ── Related writes roll back together (behaviour) ─────────────────────────────────────────
{
  addChat('d7')
  const stdoutFile = path.join(work, 'd7.jsonl')
  const sidD7 = crypto.randomUUID()
  fs.writeFileSync(stdoutFile, [
    JSON.stringify({ type: 'assistant', session_id: sidD7, message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'd7 reply' }], usage: { input_tokens: 10, output_tokens: 5 } } }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: sidD7, total_cost_usd: 0.01, duration_ms: 50, result: 'd7 reply', usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join('\n') + '\n', 'utf8')
  // The message's cost write fails: the turn's cost row written just before it must go too.
  db.exec("CREATE TRIGGER d7_boom BEFORE UPDATE OF cost_usd ON messages WHEN (SELECT instance_id FROM messages WHERE id = NEW.id) = 'd7' BEGIN SELECT RAISE(ABORT, 'd7 boom'); END;")
  process.env.FAKE_CLAUDE_STDOUT_FILE = stdoutFile
  await app.inject({ method: 'POST', url: '/api/instances/d7/send', payload: { text: 'hi' } })
  await waitIdle('d7')
  delete process.env.FAKE_CLAUDE_STDOUT_FILE
  db.exec('DROP TRIGGER d7_boom')
  const tc = (db.prepare("SELECT COUNT(*) AS n FROM turn_costs WHERE instance_id = 'd7'").get() as { n: number }).n
  check('when a turn\'s message-cost write fails, its turn-cost row is rolled back with it (no half record)', tc === 0, `${tc} turn_costs row(s)`)

  // Compaction savings: the rows and the "read up to here" offset commit together.
  const logPath = path.join(inProcDataDir(), 'compaction-log.jsonl')
  fs.writeFileSync(logPath, [1, 2, 3].map(i => JSON.stringify({ ts: Date.now(), before_chars: 1000 * i, after_chars: 100, tool_name: 'Bash' })).join('\n') + '\n')
  db.exec("CREATE TRIGGER d7_off BEFORE INSERT ON settings WHEN NEW.key = 'compactionLogOffset' BEGIN SELECT RAISE(ABORT, 'offset boom'); END;")
  const cs = await import('../src/services/compaction-savings.js') as { ingestCompactionLog: () => void }
  const before = (db.prepare('SELECT COUNT(*) AS n FROM compaction_savings').get() as { n: number }).n
  cs.ingestCompactionLog()
  const afterRows = (db.prepare('SELECT COUNT(*) AS n FROM compaction_savings').get() as { n: number }).n
  db.exec('DROP TRIGGER d7_off')
  check('when the savings offset cannot be saved, the savings rows are not kept either (no double count on the next read)', afterRows === before, `${afterRows - before} row(s) kept`)
}

// ── dead token_usage writes ──────────────────────────────────────────────────────────────────────
{
  const cp = fs.readFileSync('server/src/services/claude-process.ts', 'utf8')
  check('a turn no longer writes the dead token_usage table', !/UPDATE token_usage/.test(cp))
  const cs = fs.readFileSync('server/src/services/compaction-savings.ts', 'utf8')
  check('compaction savings: rows and the read offset commit together', /db\.transaction\(\(\) => \{\s*tx\(lines\)\s*setOffset\(/.test(cs))
  check('a turn\'s cost row and its message cost are one transaction', /db\.transaction\(\(\) => \{\s*const rec = recordTurnCost\(/.test(cp) && /UPDATE messages SET input_tokens/.test(cp.slice(cp.indexOf('const rec = recordTurnCost('), cp.indexOf('const rec = recordTurnCost(') + 1500)))
  const tin = (db.prepare('SELECT COALESCE(SUM(input_tokens), 0) AS n FROM turn_costs').get() as { n: number }).n
  db.prepare("INSERT INTO turn_costs (instance_id, folder_id, session_id, turn_index, input_tokens, output_tokens, cost_usd, created_at) VALUES ('env', 'f', 's', 99, 100, 50, 0.5, ?)").run(Date.now())
  const prof = (await app.inject({ method: 'GET', url: '/api/profile' })).json() as { tokensSent?: number }
  check('the profile totals come from the turns actually recorded (not the empty legacy table)', prof.tokensSent === tin + 100, `tokensSent ${prof.tokensSent}, expected ${tin + 100}`)
}

done()
const reg = await import('../src/services/process-registry.js') as { processRegistry: { killAll: () => Promise<void> } }
await reg.processRegistry.killAll()
await close()
for (const d of [fakeHome, work, path.dirname(fake)]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* busy */ } }
process.exit(process.exitCode ?? 0)
