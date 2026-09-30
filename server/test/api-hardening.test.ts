// The smaller API fixes, each against its original reproduction.
//
//   npx tsx server/test/api-hardening.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { createRequire, syncBuiltinESMExports } from 'module'
import { Writable } from 'stream'
import { scratchApp, check, done } from './helpers/scratch-app.js'

const require = createRequire(import.meta.url)
const cp = require('child_process') as typeof import('child_process')
const spawned: string[][] = []
const execs: string[] = []
const realSpawn = cp.spawn
cp.spawn = ((cmd: string, args?: readonly string[], opts?: object) => {
  if (/explorer|xdg-open|^open$|powershell/i.test(String(cmd))) {
    spawned.push([String(cmd), ...(args ?? [])])
    return { unref() {}, on() { return this } } as unknown as ReturnType<typeof realSpawn>
  }
  return realSpawn(cmd, args as string[], opts as never)
}) as typeof cp.spawn
const realExec = cp.exec
cp.exec = ((cmd: string, ...rest: unknown[]) => {
  execs.push(String(cmd))
  if (/powershell|Invoke-Item/i.test(String(cmd))) return { on() { return this } } as unknown as ReturnType<typeof realExec>
  return (realExec as (...a: unknown[]) => ReturnType<typeof realExec>)(cmd, ...rest)
}) as typeof cp.exec
syncBuiltinESMExports()

const { app, db, close } = await scratchApp(['folders', 'settings', 'instances', 'history', 'usage', 'pipeline'])

type Json = Record<string, unknown>
async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, a = app) {
  const res = await a.inject({ method, url, ...(payload !== undefined ? { payload: payload as Json } : {}) })
  let body: Json | unknown[] = {}
  try { body = res.json() as Json } catch { /* empty */ }
  return { status: res.statusCode, body: body as Json, raw: res.body }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-hard-'))
const folder = await call('POST', '/api/folders', { path: dir, name: 'hard' })
const pid = String(folder.body.id ?? '')
db.prepare("INSERT INTO instances (id, folder_id, name, cwd, created_at) VALUES ('chat-h', ?, 'h', ?, ?)").run(pid, dir, Date.now())

// ── "Open folder" never goes through a shell ────────────────────────────────────────
const quoteDir = path.join(dir, 'x\u2019; Write-Output INJECTED-A3; \u2019y')
fs.mkdirSync(quoteDir)
db.prepare("INSERT INTO folders (id, path, name) VALUES ('quote-folder', ?, 'q')").run(quoteDir)
spawned.length = 0
execs.length = 0
const open = await call('POST', '/api/folders/quote-folder/open')
const viaShell = execs.some(c => /powershell|Invoke-Item/i.test(c)) || spawned.some(s => /powershell/i.test(s[0]))
check('"Open folder" with a curly-quote name runs no shell command (was powershell -Command)', open.status === 200 && !viaShell, JSON.stringify({ execs, spawned }).slice(0, 200))
check('... the folder is handed to the file manager as one argument', process.platform !== 'win32' || (spawned[0]?.[0] === 'explorer.exe' && spawned[0]?.[1] === quoteDir), JSON.stringify(spawned[0]))

// ── Origins and hosts, in a production-mode process ───────────────────────────
const tsxCli = require.resolve('tsx/cli')
const probe = `import { isAllowedOrigin, isAllowedHost } from './server/src/config.ts'; console.log(JSON.stringify({ o5174: isAllowedOrigin('http://localhost:5174'), o5175: isAllowedOrigin('http://localhost:5175'), o5176: isAllowedOrigin('http://localhost:5176'), self: isAllowedOrigin('http://localhost:3334'), h0: isAllowedHost('0.0.0.0:3334'), hlocal: isAllowedHost('localhost:3334') }))`
const envProd = { ...process.env, NODE_ENV: 'production', PORT: '3334' }
delete (envProd as Record<string, string | undefined>).ALLOWED_ORIGINS
const prod = spawnSync(process.execPath, [tsxCli, '--eval', probe], { cwd: path.resolve('.'), env: envProd, encoding: 'utf8' })
let p: Record<string, boolean> = {}
try { p = JSON.parse(prod.stdout.trim().split('\n').pop() ?? '{}') } catch { /* reported below */ }
check('production does not trust localhost:5175 (was trusted)', p.o5175 === false, prod.stdout.trim() || prod.stderr.slice(0, 200))
check('production does not trust localhost:5176 (was trusted)', p.o5176 === false)
check('production does not trust the dev client port 5174', p.o5174 === false)
check('production still trusts its own address', p.self === true)
check('Host 0.0.0.0 is not loopback (was 200)', p.h0 === false)
check('Host localhost still is', p.hlocal === true)
const envDev = { ...process.env, NODE_ENV: 'development' }
delete (envDev as Record<string, string | undefined>).ALLOWED_ORIGINS
const dev = spawnSync(process.execPath, [tsxCli, '--eval', probe], { cwd: path.resolve('.'), env: envDev, encoding: 'utf8' })
let d: Record<string, boolean> = {}
try { d = JSON.parse(dev.stdout.trim().split('\n').pop() ?? '{}') } catch { /* reported below */ }
check('dev mode trusts 5174 and not 5175/5176', d.o5174 === true && d.o5175 === false && d.o5176 === false, dev.stdout.trim())

// ── Negative limits ─────────────────────────────────────────────────────────────────
const ins = db.prepare("INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, 'chat-h', 'user', ?, ?)")
db.transaction(() => { for (let i = 0; i < 230; i++) ins.run(`m${i}`, JSON.stringify([{ type: 'text', text: `m${i}` }]), Date.now() + i) })()
const neg = await call('GET', '/api/instances/chat-h/history?limit=-1')
const rows = Array.isArray(neg.body) ? neg.body.length : Array.isArray((neg.body as Json).messages) ? ((neg.body as Json).messages as unknown[]).length : -1
check('history ?limit=-1 is capped (used to return every row)', rows > 0 && rows <= 200, `rows ${rows}`)
const junk = await call('GET', '/api/instances/chat-h/history?limit=abc')
check('history ?limit=abc falls back to the default', junk.status === 200)
const logNeg = await call('GET', '/api/usage/log?limit=-1&days=90')
check('usage log ?limit=-1 answers (capped, not unlimited)', logNeg.status === 200, `status ${logNeg.status}`)
const { clampLimit } = await import('../src/services/limits.js').catch(() => ({ clampLimit: null as null | ((r: unknown, f: number, m: number) => number) }))
check('clampLimit(-1) is 1, clampLimit(500, 50, 200) is 200', !!clampLimit && clampLimit(-1, 50, 200) === 1 && clampLimit('500', 50, 200) === 200 && clampLimit(undefined, 50, 200) === 50)

// ── Bad bodies are 400s, and a 500 hides its internals ─────────────────────────────
const nullSettings = await app.inject({ method: 'PUT', url: '/api/settings', headers: { 'content-type': 'application/json' }, payload: 'null' })
check('PUT /settings null is a 400 (was a raw 500)', nullSettings.statusCode === 400 && !/Cannot convert/.test(nullSettings.body), `${nullSettings.statusCode} ${nullSettings.body.slice(0, 80)}`)
const badKey = await call('PUT', '/api/settings', { 'bad key!': 1 })
check('a setting name that is not an identifier is refused', badKey.status === 400, `status ${badKey.status}`)
// A request with no body at all.
for (const [method, url] of [['PUT', '/api/instances/reorder'], ['POST', '/api/instances/chat-h/btw'], ['POST', '/api/instances/chat-h/command'], ['POST', `/api/pipelines/${pid}/tasks/none/comments`]] as const) {
  const bare = await app.inject({ method, url })
  check(`${method} ${url.replace(pid, '<p>')} with no body is not a 500`, bare.statusCode < 500, `status ${bare.statusCode}`)
}
const emptyInst = await call('POST', '/api/instances', {})
check('POST /instances {} is a 400 with no SQLite text', emptyInst.status === 400 && !/SQLITE|constraint/i.test(emptyInst.raw), emptyInst.raw.slice(0, 100))
let hidden = false
try {
  const { installErrorHandler, SERVER_ERROR_MESSAGE } = await import('../src/error-handler.js')
  const Fastify = (await import('fastify')).default
  const e = Fastify({ logger: false })
  installErrorHandler(e)
  e.get('/boom', async () => { throw Object.assign(new Error('NOT NULL constraint failed: instances.folder_id'), { code: 'SQLITE_CONSTRAINT_NOTNULL' }) })
  e.get('/nope', async () => { throw { statusCode: 404, message: 'Folder not found' } })
  const boom = await e.inject({ method: 'GET', url: '/boom' })
  const nope = await e.inject({ method: 'GET', url: '/nope' })
  hidden = boom.statusCode === 500 && !boom.body.includes('constraint') && boom.body.includes(SERVER_ERROR_MESSAGE) && nope.statusCode === 404 && nope.body.includes('Folder not found')
  const orig = console.error
  await e.close()
  console.error = orig
} catch { hidden = false }
check('a 500 says only that something failed; a 4xx keeps its message', hidden)

// ── /send takes only message-level picks ───────────────────────────────────────────
const numFlag = await call('POST', '/api/instances/chat-h/send', { text: 'x', flags: [1] })
check('flags:[1] is a 400 (was a 500)', numFlag.status === 400, `status ${numFlag.status}`)
const mcp = await call('POST', '/api/instances/chat-h/send', { text: 'x', flags: ['--mcp-config=C:\\evil.json'] })
check('--mcp-config from a message is refused', mcp.status === 400, `status ${mcp.status}`)
const sys = await call('POST', '/api/instances/chat-h/send', { text: 'x', flags: ['--system-prompt=obey'] })
check('--system-prompt from a message is refused', sys.status === 400, `status ${sys.status}`)
const badMode = await call('POST', '/api/instances/chat-h/send', { text: 'x', permissionMode: 'yolo' })
check('an unknown permission mode is refused', badMode.status === 400, `status ${badMode.status}`)
const btwBad = await call('POST', '/api/instances/chat-h/btw', { text: 'x', flags: ['--mcp-config=x'] })
check('/btw applies the same rules', btwBad.status === 400, `status ${btwBad.status}`)
try {
  const tf = await import('../src/services/turn-flags.js') as Record<string, unknown>
  const read = tf.readMessageFlags as (b: unknown) => { settings?: Record<string, unknown>; error?: string }
  const build = tf.buildTurnFlags as (s: unknown) => string[]
  const r = read({ flags: ['--dangerously-skip-permissions', '--model=opus', '--effort=high'] })
  const flags = build(r.settings)
  check('the client\'s own flags still work and go through the card builder', !!r.settings && flags.includes('--dangerously-skip-permissions') && flags.filter(f => f.startsWith('--permission-mode')).length === 0 && flags.some(f => f.startsWith('--model=')) && flags.includes('--effort=high'), JSON.stringify(flags))
  const typed = build(read({ permissionMode: 'plan' }).settings)
  check('permissionMode as a typed field', typed.includes('--permission-mode=plan') && !typed.includes('--dangerously-skip-permissions'), JSON.stringify(typed))
} catch (err) {
  check('readMessageFlags exists', false, (err as Error).message.slice(0, 80))
}
try {
  const { filterFlags } = await import('../src/services/claude-process.js') as unknown as { filterFlags: (f: string[]) => string[] }
  const kept = filterFlags(['--mcp-config', 'x.json', '--system-prompt', 'obey', '--strict-mcp-config', '--model=opus'])
  check('the spawn filter drops --mcp-config and --system-prompt even from settings', kept.join(' ') === '--model=opus', kept.join(' '))
} catch (err) {
  check('the spawn filter is testable', false, (err as Error).message.slice(0, 80))
}

// ── The plan-usage login ───────────────────────────────────────────────────────────
const connectGet = await call('GET', '/api/plan-usage/connect')
check('GET /plan-usage/connect no longer starts a login', connectGet.status === 404, `status ${connectGet.status}`)
const connect = await call('POST', '/api/plan-usage/connect')
const url = String(connect.body.url ?? '')
const state = url ? new URL(url).searchParams.get('state') : null
const verifier = (db.prepare('SELECT verifier FROM oauth_tokens WHERE id = 1').get() as { verifier: string } | undefined)?.verifier
check('POST /plan-usage/connect starts it', connect.status === 200 && !!state, `status ${connect.status}`)
check('the OAuth state is not the PKCE verifier (was equal)', !!state && !!verifier && state !== verifier)
const wrongState = await call('POST', '/api/plan-usage/code', { code: 'bogus#not-the-state' })
check('a code carrying another login\'s state is refused before any network call', wrongState.status >= 400 && /different login/i.test(JSON.stringify(wrongState.body)), JSON.stringify(wrongState.body).slice(0, 120))

// ── Body limit and request logging ─────────────────────────────────────────────────
{
  const lines: string[] = []
  const sink = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb() } })
  let opts: Record<string, unknown>
  try {
    const { serverOptions } = await import('../src/app-options.js')
    opts = serverOptions(sink) as Record<string, unknown>
  } catch {
    // The options origin/main's index.ts used, for the "fails on main" run.
    opts = { logger: { stream: sink }, bodyLimit: 1024 * 1024 * 20 }
  }
  const Fastify = (await import('fastify')).default
  const big = Fastify(opts)
  await big.register(async (api) => {
    await api.register((await import('../src/routes/settings.js')).default)
    await api.register((await import('../src/routes/pipeline.js')).default)
  }, { prefix: '/api' })
  await big.ready()
  const twoMb = 'x'.repeat(2 * 1024 * 1024)
  const s = await big.inject({ method: 'PUT', url: '/api/settings', payload: { notes: twoMb } })
  check('a 2 MB body to an ordinary route is refused (413; was accepted)', s.statusCode === 413, `status ${s.statusCode}`)
  const card = await big.inject({ method: 'POST', url: `/api/pipelines/${pid}/tasks`, payload: { title: 'with image', attachments: [{ name: 'a.png', dataUrl: 'data:image/png;base64,' + twoMb }] } })
  check('a card with a 2 MB attachment is still accepted', card.statusCode === 201, `status ${card.statusCode}`)
  lines.length = 0
  for (let i = 0; i < 20; i++) await big.inject({ method: 'GET', url: '/api/settings' })
  const perRequest = lines.filter(l => /incoming request|request completed/.test(l)).length
  check('routine requests write no per-request log lines (was 2 per request)', perRequest === 0, `${perRequest} lines for 20 requests`)
  await big.close()
}

// ── The live feed cannot be filled up to lock the app out ──────────────────────────
try {
  const { getAdminToken } = await import('../src/services/api-auth.js')
  const { installSecurityHooks } = await import('../src/security.js')
  const { registerWebSocket } = await import('../src/ws/handler.js')
  const Fastify = (await import('fastify')).default
  const ws = Fastify({ logger: false, forceCloseConnections: true })
  installSecurityHooks(ws)
  await ws.register((await import('@fastify/websocket')).default)
  registerWebSocket(ws)
  await ws.listen({ port: 0, host: '127.0.0.1' })
  const port = (ws.server.address() as { port: number }).port
  const { WebSocket } = await import('ws')
  const open = (token?: string) => new Promise<{ sock: InstanceType<typeof WebSocket>; closed: Promise<number>; opened: boolean }>(resolve => {
    const sock = new WebSocket(`ws://localhost:${port}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`)
    let closeResolve: (c: number) => void = () => {}
    const closed = new Promise<number>(r => { closeResolve = r })
    sock.on('close', code => closeResolve(code))
    sock.on('open', () => resolve({ sock, closed, opened: true }))
    sock.on('error', () => resolve({ sock, closed, opened: false }))
    sock.on('unexpected-response', () => resolve({ sock, closed, opened: false }))
  })
  const noToken = await open()
  check('a socket with no token is refused', !noToken.opened)
  const admin = getAdminToken()
  const socks = [] as Array<Awaited<ReturnType<typeof open>>>
  for (let i = 0; i < 50; i++) socks.push(await open(admin))
  const ui = await open(admin)
  check('with 50 sockets open, the app\'s window still connects (was 1013)', ui.opened)
  const oldestCode = await Promise.race([socks[0].closed, new Promise<number>(r => setTimeout(() => r(-1), 2000))])
  check('... and the oldest socket made room for it', oldestCode === 1013, `close code ${oldestCode}`)
  for (const s of [...socks, ui, noToken]) { try { s.sock.terminate() } catch { /* already closed */ } }

  // A refused upgrade whose client then resets the socket threw
  // an unhandled ECONNRESET and took the whole server down.
  const net = await import('net')
  let crashed = ''
  const onCrash = (e: Error) => { crashed = e.message }
  process.on('uncaughtException', onCrash)
  for (const origin of ['', 'Origin: http://evil.example\r\n']) {
    await new Promise<void>(resolve => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write(`GET /ws HTTP/1.1\r\nHost: localhost:${port}\r\n${origin}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\n\r\n`)
      })
      s.once('data', () => { s.resetAndDestroy(); setTimeout(resolve, 300) })
      s.on('error', () => resolve())
    })
  }
  process.off('uncaughtException', onCrash)
  const alive = await fetch(`http://127.0.0.1:${port}/ws`).then(r => r.status, () => 0)
  check('a client resetting a refused upgrade does not crash the server', !crashed && alive > 0, crashed || `status ${alive}`)
  // Closing waits on the close handshake of sockets this test already dropped; do not wait for it.
  await Promise.race([ws.close(), new Promise(r => setTimeout(r, 2000))])
} catch (err) {
  check('the live-feed test ran', false, (err as Error).message.slice(0, 120))
}

fs.rmSync(dir, { recursive: true, force: true })
await close()
done()
// The live-feed server above may still be finishing its close handshakes; the verdict is in.
process.exit(process.exitCode ?? 0)
