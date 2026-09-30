// Stopping a chat, starting one twice, /compact, and PIDs adopted
// after a restart. Every "agent" here is a fake claude binary (helpers/fake-claude.ts), so no
// real agent runs and nothing is spent.
//
//   npx tsx server/test/process-lifecycle.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { buildFakeClaude, longLivedNodeCommand, treeOf, alive, sleep, listProcesses } from './helpers/fake-claude.js'

const fake = buildFakeClaude()
process.env.ORCSTRATOR_CLAUDE_PATH = fake
process.env.ORCSTRATOR_COMPACT_TIMEOUT_MS = '1500'
process.env.ORCSTRATOR_ADOPTED_POLL_MS = '300'
process.env.FAKE_CLAUDE_SLEEP_MS = '4000'
// A private home: resuming a session looks for its transcript under ~/.claude, and the test
// must neither read nor write the real one.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-life-home-'))
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome

const { scratchApp, check, done } = await import('./helpers/scratch-app.js')
const { app, db, close } = await scratchApp(['instances'])
const registryModule = await import('../src/services/process-registry.js') as Record<string, unknown>
const { processRegistry } = registryModule as { processRegistry: unknown }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-life-'))
db.prepare('INSERT INTO folders (id, path, name) VALUES (?, ?, ?)').run('f', work, 'p')
const addChat = (id: string, sessionId: string | null = null) =>
  db.prepare("INSERT INTO instances (id, folder_id, name, cwd, session_id, state, process_state, sort_order, created_at) VALUES (?, 'f', ?, ?, ?, 'idle', 'idle', 0, 1)").run(id, id, work, sessionId)

const cleanup: number[] = []
const reg = processRegistry as unknown as {
  registerProcess: (id: string, c: import('child_process').ChildProcess) => void
  killProcess: (id: string) => Promise<boolean>
  isTracked: (id: string) => boolean
  watchAdopted?: (id: string, pid: number, startedAt: number | null, onGone: (id: string) => void) => void
}

// ── Stop kills the agent FIRST, then the programs it started ──────────────────────────
{
  addChat('k')
  const child = spawn(fake, [], {
    env: { ...process.env, FAKE_CLAUDE_GRANDCHILD: longLivedNodeCommand(), FAKE_CLAUDE_SLEEP_MS: '60000' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  await new Promise(r => child.once('spawn', r))
  let tree: number[] = []
  for (let i = 0; i < 20 && tree.length < 2; i++) { await sleep(300); tree = treeOf(child.pid!) }
  cleanup.push(child.pid!, ...tree)
  check('setup: the fake agent started a long-running program through a shell', tree.length >= 2, `tree ${tree.join(',')}`)
  reg.registerProcess('k', child)
  db.prepare("UPDATE instances SET process_state = 'running', state = 'running', process_pid = ? WHERE id = 'k'").run(child.pid)

  const res = await app.inject({ method: 'POST', url: '/api/instances/k/kill' })
  check('Stop answers 200', res.statusCode === 200, `${res.statusCode} ${res.body.slice(0, 100)}`)
  await sleep(300)
  check('the agent itself (the root) is dead', !alive(child.pid!))
  const survivors = tree.filter(alive)
  check('every program the agent started is gone too (none orphaned)', survivors.length === 0, `still alive: ${survivors.join(',')}`)
  const state = db.prepare("SELECT state, process_state FROM instances WHERE id = 'k'").get() as { state: string; process_state: string }
  check('the chat reads idle only after that', state.state === 'idle' && state.process_state === 'idle', JSON.stringify(state))

  const killTrace = registryModule.killTrace as Array<{ step: string; pid: number; at: number }> | undefined
  const rootDead = killTrace?.findIndex(e => e.step === 'root-dead' && e.pid === child.pid) ?? -1
  const firstSweep = killTrace?.findIndex(e => e.step === 'sweep-kill') ?? -1
  check('ROOT FIRST: the root was confirmed dead before any program it started was killed',
    rootDead >= 0 && firstSweep > rootDead, `root-dead at ${rootDead}, first sweep-kill at ${firstSweep}`)
  const snapAt = killTrace?.findIndex(e => e.step === 'snapshot' && e.pid === child.pid) ?? -1
  check('the process tree was read BEFORE the root was killed', snapAt >= 0 && snapAt < rootDead, `snapshot at ${snapAt}`)
}

// ── Two starts on one chat at once → exactly one agent and one 409 ──────────────────────
{
  // With a session, as every real chat after its first turn: the start then reads the
  // transcript's location from disk before it spawns, which is the window this is about.
  addChat('r', crypto.randomUUID())
  let registers = 0
  const realRegister = reg.registerProcess.bind(processRegistry)
  reg.registerProcess = (id, c) => { if (id === 'r') { registers++; if (c.pid) cleanup.push(c.pid) } realRegister(id, c) }
  const [a, b] = await Promise.all([
    app.inject({ method: 'POST', url: '/api/instances/r/send', payload: { text: 'one' } }),
    app.inject({ method: 'POST', url: '/api/instances/r/send', payload: { text: 'two' } }),
  ])
  const codes = [a.statusCode, b.statusCode].sort()
  check('two concurrent sends on one chat: one starts, one is refused with 409', codes[0] === 200 && codes[1] === 409, `${a.statusCode} ${b.statusCode}`)
  check('... and exactly ONE claude process was started', registers === 1, `registered ${registers}`)
  const msgs = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE instance_id = 'r' AND role = 'user'").get() as { n: number }).n
  check('... and the refused one left no stray message behind', msgs === 1, `${msgs} user messages`)
  // A send while the first turn runs is refused as before.
  const c = await app.inject({ method: 'POST', url: '/api/instances/r/send', payload: { text: 'three' } })
  check('a send while the turn runs is refused', c.statusCode === 409, String(c.statusCode))
  await reg.killProcess('r')
  reg.registerProcess = realRegister
}

// ── An internal kill (question hard stop, idle timeout) leaves a detached job running ───
// The agent is told a job it launches detached survives its turn; only a user's Stop sweeps.
{
  addChat('hs')
  const child = spawn(fake, [], {
    env: { ...process.env, FAKE_CLAUDE_GRANDCHILD: longLivedNodeCommand(), FAKE_CLAUDE_SLEEP_MS: '60000' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  await new Promise(r => child.once('spawn', r))
  let tree: number[] = []
  for (let i = 0; i < 20 && tree.length < 2; i++) { await sleep(300); tree = treeOf(child.pid!) }
  cleanup.push(child.pid!, ...tree)
  reg.registerProcess('hs', child)
  const ok = await reg.killProcess('hs')
  await sleep(300)
  check('an internal kill still kills the agent itself', ok && !alive(child.pid!))
  check('... but leaves the programs it started (they may be a detached job the agent was told survives)', tree.some(alive), `alive: ${tree.filter(alive).join(',')}`)
  for (const p of tree) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } }
}

// ── Stop pressed while a start is still being set up ────────────────────────────────
{
  addChat('early')
  const sharp = (await import('sharp')).default
  const W = 7000, H = 5000
  const noise = Buffer.alloc(W * H * 3); for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24
  const png = (await sharp(noise, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer()).toString('base64')
  process.env.FAKE_CLAUDE_SLEEP_MS = '60000'
  const registersBefore = (registryModule.processRegistry as { getProcessInfo: () => unknown[] }).getProcessInfo().length
  let sendDone = 0
  const send = app.inject({ method: 'POST', url: '/api/instances/early/send', payload: { text: 'look', images: [png] } }).then(r => { sendDone = Date.now(); return r })
  await sleep(150) // the image is still being processed: claimed, nothing spawned yet
  const killAt = Date.now()
  const setupStillRunning = sendDone === 0
  const k = await app.inject({ method: 'POST', url: '/api/instances/early/kill' })
  const s = await send
  check('setup: Stop really arrived while the start was still being set up', setupStillRunning, `send finished ${sendDone ? sendDone - killAt : 'after'} ms relative to Stop`)
  await sleep(1500)
  const running = (registryModule.processRegistry as { isTracked: (id: string) => boolean }).isTracked('early')
  const row = db.prepare("SELECT state, process_state FROM instances WHERE id = 'early'").get() as { state: string; process_state: string }
  check('Stop during a start\'s setup: no agent is left running behind a chat that says it stopped',
    k.statusCode === 200 && !running && row.process_state === 'idle', `kill ${k.statusCode}, send ${s.statusCode}, tracked ${running}, ${row.state}/${row.process_state}`)
  if (running) await reg.killProcess('early')
  void registersBefore

  // The same stop (Stop, Pause or /reset), with the user sending a new message the moment the
  // cancelled start gives up. Whatever happens to that message, the chat must tell the truth:
  // an agent running under a chat marked idle or paused (with its PID thrown away) is the
  // orphan the kill order exists to prevent. Pause and /reset used to break here.
  const tracked = (id: string) => (registryModule.processRegistry as { isTracked: (id: string) => boolean }).isTracked(id)
  for (const [id, stop] of [['early2', 'kill'], ['early3', 'pause'], ['early4', 'reset']] as const) {
    addChat(id)
    const send2 = app.inject({ method: 'POST', url: `/api/instances/${id}/send`, payload: { text: 'look', images: [png] } })
    await sleep(150)
    const stopReq = stop === 'reset'
      ? app.inject({ method: 'POST', url: `/api/instances/${id}/command`, payload: { command: '/reset' } })
      : app.inject({ method: 'POST', url: `/api/instances/${id}/${stop}` })
    const s2 = await send2
    const fresh = await app.inject({ method: 'POST', url: `/api/instances/${id}/send`, payload: { text: 'carry on' } })
    const k2 = await stopReq
    await sleep(1500)
    const alive2 = tracked(id)
    const row2 = db.prepare('SELECT state, process_state, process_pid FROM instances WHERE id = ?').get(id) as { state: string; process_state: string; process_pid: number | null }
    const truthful = alive2 ? (row2.process_state === 'running' && row2.process_pid != null && row2.state !== 'paused') : row2.process_state === 'idle'
    const refusedWhileStopping = fresh.statusCode === 409 && /stopping/.test(fresh.body)
    if (stop === 'kill') {
      check('a start cancelled by Stop answers quietly, not with a "could not send" error under the Stop note', s2.statusCode === 200 && /cancelled/.test(s2.body), `${s2.statusCode} ${s2.body.slice(0, 80)}`)
    }
    check(`a message sent while a ${stop === 'kill' ? 'Stop' : stop === 'pause' ? 'Pause' : '/reset'} is finishing is refused ("stopping") or runs, and the chat never shows idle over a live agent`,
      k2.statusCode === 200 && (refusedWhileStopping || fresh.statusCode === 200) && truthful,
      `stop ${k2.statusCode}, new send ${fresh.statusCode} ${fresh.body.slice(0, 70)}, running ${alive2}, row ${JSON.stringify(row2)}`)
    if (alive2) await reg.killProcess(id)
  }
  process.env.FAKE_CLAUDE_SLEEP_MS = '4000'
}

// ── Stop while a wake-up is replacing a running turn ────────────────────────────────────
// The replaced turn's exit leaves the chat to the start that replaced it. When Stop cancels that
// start, the replaced turn must still be finished: its end-of-turn subscribers (a card's hand-off,
// a routine's run row) and its live timer.
{
  addChat('rep')
  process.env.FAKE_CLAUDE_SLEEP_MS = '60000'
  const cp = await import('../src/services/claude-process.js')
  const tp = await import('../src/services/turn-progress.js')
  let completes = 0
  cp.onTurnComplete((id: string) => { if (id === 'rep') completes++ })
  const s1 = await app.inject({ method: 'POST', url: '/api/instances/rep/send', payload: { text: 'first' } })
  await sleep(800)
  const replacing = cp.sendMessage({ instanceId: 'rep', text: 'wake', cwd: work, origin: 'wakeup' }).then(() => 'spawned', (e: Error) => e.constructor.name)
  await sleep(30)
  const k = await app.inject({ method: 'POST', url: '/api/instances/rep/kill' })
  const outcome = await replacing
  await sleep(2500)
  const row = db.prepare("SELECT process_state FROM instances WHERE id = 'rep'").get() as { process_state: string }
  const left = tp.getTurnProgress('rep')
  check('Stop during a wake-up that replaced a turn: the replaced turn is still finished (turn-complete fires, no live timer left)',
    s1.statusCode === 200 && k.statusCode === 200 && (outcome === 'spawned' || (completes === 1 && !left && row.process_state === 'idle')),
    `replacing start ${outcome}, turn-complete fired ${completes}, timer left ${!!left}, ${row.process_state}`)
  if (reg.isTracked('rep')) await reg.killProcess('rep')
  process.env.FAKE_CLAUDE_SLEEP_MS = '4000'
}

// ── After Stop, the chat does not claim the CLI failed ───────────────────────────────────
{
  addChat('n')
  process.env.FAKE_CLAUDE_SLEEP_MS = '60000'
  const s = await app.inject({ method: 'POST', url: '/api/instances/n/send', payload: { text: 'work' } })
  await sleep(1200)
  const k = await app.inject({ method: 'POST', url: '/api/instances/n/kill' })
  for (let i = 0; i < 30; i++) {
    const r = db.prepare("SELECT process_state FROM instances WHERE id = 'n'").get() as { process_state: string }
    if (r.process_state === 'idle') break
    await sleep(200)
  }
  await sleep(500)
  const notes = (db.prepare("SELECT content FROM messages WHERE instance_id = 'n' AND role = 'system'").all() as Array<{ content: string }>).map(r => r.content)
  check('after the user presses Stop, no "exited without starting a turn" failure note is added', s.statusCode === 200 && k.statusCode === 200 && !notes.some(n => /without starting a turn/.test(n)), `${s.statusCode}/${k.statusCode} notes: ${notes.map(n => n.slice(0, 60)).join(' | ')}`)
  check('... it says "Stopped" instead, so the chat does not just go quiet', notes.some(n => /Stopped\. Anything it was doing in the background was ended too/.test(n)))

  // A note sent with /btw while the turn ran must not start a turn of its own after Stop.
  const s2 = await app.inject({ method: 'POST', url: '/api/instances/n/send', payload: { text: 'again' } })
  await sleep(1200)
  const b = await app.inject({ method: 'POST', url: '/api/instances/n/btw', payload: { text: 'by the way' } })
  const k2 = await app.inject({ method: 'POST', url: '/api/instances/n/kill' })
  await sleep(2000)
  const tracked = (registryModule.processRegistry as { isTracked: (id: string) => boolean }).isTracked('n')
  check('a queued /btw note does not start a turn by itself after the user pressed Stop', s2.statusCode === 200 && b.statusCode === 200 && k2.statusCode === 200 && !tracked, `send ${s2.statusCode}, btw ${b.statusCode} ${b.body.slice(0, 40)}, kill ${k2.statusCode}, running after: ${tracked}`)
  if (tracked) await reg.killProcess('n')
  process.env.FAKE_CLAUDE_SLEEP_MS = '4000'
}

// ── /compact holds the chat, has a timeout, and cannot outlive the server ─────────────────
{
  addChat('c', 'sess-c')
  process.env.FAKE_CLAUDE_SLEEP_MS = '60000'
  const before = new Set(listProcesses().filter(p => p.ppid === process.pid).map(p => p.pid))
  const compact = app.inject({ method: 'POST', url: '/api/instances/c/compact' })
  await sleep(400)
  const kids = listProcesses().filter(p => p.ppid === process.pid && !before.has(p.pid)).map(p => p.pid)
  cleanup.push(...kids)
  const send = await app.inject({ method: 'POST', url: '/api/instances/c/send', payload: { text: 'during compact' } })
  check('a message sent while /compact runs is refused (409), not a second agent', send.statusCode === 409, `${send.statusCode} ${send.body.slice(0, 120)}`)
  const again = await app.inject({ method: 'POST', url: '/api/instances/c/compact' })
  check('a second /compact is refused while one runs', again.statusCode === 409 && again.body.includes('already-compacting'), again.body.slice(0, 80))
  const result = await Promise.race([compact, sleep(8000).then(() => null)])
  check('a hung /compact is stopped by its timeout and reported', !!result && result.statusCode === 409 && result.body.includes('timeout'), result ? result.body.slice(0, 120) : 'still running after 8 s')
  await sleep(500)
  check('... and its process is dead', kids.length > 0 && kids.every(p => !alive(p)), `compact pids ${kids.join(',')}`)

  // Stop reaches a running compact, and so does shutdown.
  const compact2 = app.inject({ method: 'POST', url: '/api/instances/c/compact' })
  await sleep(400)
  const kids2 = listProcesses().filter(p => p.ppid === process.pid && !before.has(p.pid) && !kids.includes(p.pid)).map(p => p.pid)
  cleanup.push(...kids2)
  const gate = await import('../src/services/turn-gate.js').catch(() => null) as { killAllClaimChildren?: () => Promise<void> } | null
  if (gate?.killAllClaimChildren) await gate.killAllClaimChildren()
  const r2 = await Promise.race([compact2, sleep(4000).then(() => null)])
  check('shutdown kills a running /compact (it is not in the registry)', !!r2 && kids2.length > 0 && kids2.every(p => !alive(p)), `pids ${kids2.join(',')}, answered ${!!r2}`)
  process.env.FAKE_CLAUDE_SLEEP_MS = '4000'
}

// ── A PID adopted after a restart is only killed if it is still OUR agent ─────────────────
{
  addChat('a')
  // An unrelated program that was given the dead agent's PID: here, a plain node process.
  const stranger = spawn(process.execPath, ['-e', 'setInterval(function(){},1000)'], { stdio: 'ignore', windowsHide: true })
  await new Promise(r => stranger.once('spawn', r))
  cleanup.push(stranger.pid!)
  db.prepare("UPDATE instances SET process_state = 'running', state = 'running', process_pid = ? WHERE id = 'a'").run(stranger.pid)
  const res = await app.inject({ method: 'POST', url: '/api/instances/a/kill' })
  await sleep(300)
  check('Stop on an adopted chat whose PID now belongs to another program does NOT kill that program', alive(stranger.pid!), `status ${res.statusCode}`)
  check('... and the chat is released (the agent is already gone)', res.statusCode === 200, `${res.statusCode} ${res.body.slice(0, 100)}`)

  const verify = registryModule.verifyAgentIdentity as ((pid: number, startedAt: number | null, snap: unknown) => string) | undefined
  check('identity check exists (verifyAgentIdentity)', typeof verify === 'function')
  if (verify) {
    const now = Date.now()
    check('a node.exe is never taken for the agent', verify(10, null, [{ pid: 10, ppid: 1, createdAt: now, name: 'node.exe' }]) === 'stranger')
    check('claude.exe that started at a different time is a stranger', verify(10, now - 3_600_000, [{ pid: 10, ppid: 1, createdAt: now, name: 'claude.exe' }]) === 'stranger')
    check('claude.exe that started when the chat did is the agent', verify(10, now - 1000, [{ pid: 10, ppid: 1, createdAt: now - 900, name: 'claude.exe' }]) === 'agent')
    check('an unreadable process table fails closed (unknown, so nothing is killed)', verify(10, now, null) === 'unknown')
  }

  // Adopted PIDs are watched: the chat is handed back when the agent exits.
  const shortLived = spawn(process.execPath, ['-e', 'setTimeout(function(){},600)'], { stdio: 'ignore', windowsHide: true })
  await new Promise(r => shortLived.once('spawn', r))
  let gone = ''
  if (reg.watchAdopted) reg.watchAdopted('a2', shortLived.pid!, null, id => { gone = id })
  await sleep(2000)
  check('an adopted agent that exits is noticed (no "running" for ever)', gone === 'a2', gone || 'never noticed')
}

// ── Shutdown reaches a start that is still being set up (LAST: shutdown is for good) ─────
{
  addChat('sd')
  const sharp = (await import('sharp')).default
  const W = 7000, H = 5000
  const noise = Buffer.alloc(W * H * 3); for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24
  const png = (await sharp(noise, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer()).toString('base64')
  process.env.FAKE_CLAUDE_SLEEP_MS = '60000'
  const send = app.inject({ method: 'POST', url: '/api/instances/sd/send', payload: { text: 'look', images: [png] } })
  await sleep(150)
  const startingAtShutdown = !reg.isTracked('sd')
  const pr = processRegistry as unknown as { shutdownAgents?: () => Promise<void>; killAll: () => Promise<void> }
  if (pr.shutdownAgents) await pr.shutdownAgents()
  else {
    // The server's shutdown before the fix: the registry, then the /compact children.
    await pr.killAll()
    // (origin/main has no turn-gate at all.)
    const gate = await import('../src/services/turn-gate.js').catch(() => ({})) as { killAllClaimChildren?: () => Promise<void> }
    await gate.killAllClaimChildren?.()
  }
  const r = await send
  await sleep(500)
  const info = (processRegistry as unknown as { getProcessInfo: () => Array<{ instanceId: string; pid: number }> }).getProcessInfo().find(p => p.instanceId === 'sd')
  check('shutdown: a start still being set up does not spawn an agent after "all processes confirmed dead"',
    startingAtShutdown && !reg.isTracked('sd') && !(info && alive(info.pid)),
    `was starting ${startingAtShutdown}, send ${r.statusCode} ${r.body.slice(0, 60)}, tracked after ${reg.isTracked('sd')}, pid ${info?.pid ?? 'none'}`)
  if (info) { try { process.kill(info.pid, 'SIGKILL') } catch { /* gone */ } }
}

// Leave nothing behind, whatever happened above.
for (const pid of cleanup) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
for (const d of [path.dirname(fake), fakeHome, work]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* in use a moment longer */ } }
await close()
done()
process.exit(process.exitCode ?? 0)
