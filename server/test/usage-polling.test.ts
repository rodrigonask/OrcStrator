// The plan-usage poller clamps its interval to 1-1440 minutes (NaN and huge values
// used to fire nonstop), puts a timeout on every call, polls nobody when no tab is open,
// honours Retry-After, and shares one token refresh between concurrent callers.
// fetch is replaced by a local fake: nothing leaves this machine, no real token is used.
//
//   npx tsx server/test/usage-polling.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-usage-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR

const { scratchApp, check, done } = await import('./helpers/scratch-app.js')
const { db, close } = await scratchApp([])
const { OAUTH } = await import('@orcstrator/shared')
const { encrypt } = await import('../src/services/secret-box.js')
const usage = await import('../src/services/usage-monitor.js')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── clock, timers and network fakes ────────────────────────────────────────────────────
const realNow = Date.now
let offset = 0
Date.now = () => realNow() + offset

const intervals: Array<{ delay: number; fn: () => void }> = []
const realSetInterval = globalThis.setInterval
globalThis.setInterval = ((fn: () => void, delay?: number) => {
  intervals.push({ delay: Number(delay), fn })
  const t = realSetInterval(() => {}, 2 ** 30)
  t.unref()
  return t
}) as typeof setInterval

type Call = { url: string; signal: unknown }
let calls: Call[] = []
let usageResponse: () => Response = () => new Response(JSON.stringify({ limits: [{ kind: 'session', percent: 10 }] }), { status: 200 })
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input)
  calls.push({ url, signal: init?.signal })
  if (url === OAUTH.tokenUrl) {
    await sleep(80)
    return new Response(JSON.stringify({ access_token: 'fresh-access-token-0123456789', expires_in: 3600 }), { status: 200 })
  }
  return usageResponse()
}) as typeof fetch
const usageCalls = () => calls.filter(c => c.url === OAUTH.usageUrl).length

// ── one shared token refresh ───────────────────────────────────────────────────────────
{
  db.prepare('UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = 1')
    .run(encrypt('expired-access-token-0123456789'), encrypt('refresh-token-0123456789'), '2000-01-01T00:00:00Z')
  calls = []
  const [a, b] = await Promise.all([usage.fetchUsage(true), usage.fetchUsage(true)])
  const refreshes = calls.filter(c => c.url === OAUTH.tokenUrl).length
  check('two usage checks at once share one token refresh and both succeed',
    refreshes === 1 && a.connected && b.connected, `${refreshes} refresh call(s), connected ${a.connected}/${b.connected}`)
  check('every call to Anthropic carries a timeout', calls.length > 0 && calls.every(c => c.signal instanceof AbortSignal),
    `${calls.filter(c => c.signal instanceof AbortSignal).length} of ${calls.length} with a signal`)
}

// From here the zero-setup source: the CLI's own credentials file, in the fake home.
fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true })
fs.writeFileSync(path.join(fakeHome, '.claude', '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'cli-access-token-0123456789abcdef', expiresAt: realNow() + 365 * 86_400_000 } }))

// ── the interval is clamped ────────────────────────────────────────────────────────────
{
  const delays: number[] = []
  for (const minutes of [Number.NaN, 1e9]) {
    intervals.length = 0
    usage.startPolling(minutes)
    delays.push(intervals[0]?.delay ?? -1)
    usage.stopPolling()
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('usagePollMinutes', '1000000000')").run()
  intervals.length = 0
  usage.startPolling()
  delays.push(intervals[0]?.delay ?? -1)
  usage.stopPolling()
  db.prepare("DELETE FROM settings WHERE key = 'usagePollMinutes'").run()
  const ok = (d: number) => Number.isFinite(d) && d >= 60_000 && d <= 1440 * 60_000
  check('a NaN poll interval becomes a real one (1 to 1440 minutes)', ok(delays[0]), `setInterval delay ${delays[0]}`)
  check('a huge poll interval is capped at a day, not overflowed into 1 ms', ok(delays[1]), `setInterval delay ${delays[1]}`)
  check('a huge saved setting is capped too', ok(delays[2]), `setInterval delay ${delays[2]}`)
}

// ── nobody watching, nobody polled ─────────────────────────────────────────────────────
{
  offset += 10 * 60_000
  calls = []
  intervals.length = 0
  usage.startPolling(1)
  await sleep(50)
  offset += 2 * 60_000
  intervals[0]?.fn()
  await sleep(50)
  check('no usage call is made while no tab is connected', usageCalls() === 0, `${usageCalls()} call(s)`)
  calls = []
  usage.getCurrentUsage()
  await sleep(50)
  check('the first tab to read the numbers again gets a fresh check', usageCalls() === 1, `${usageCalls()} call(s)`)
  usage.stopPolling()
}

// ── Retry-After ────────────────────────────────────────────────────────────────────────
{
  offset += 10 * 60_000
  usageResponse = () => new Response('slow down', { status: 429, headers: { 'Retry-After': '1200' } })
  await usage.fetchUsage(true)
  usageResponse = () => new Response(JSON.stringify({ limits: [{ kind: 'session', percent: 12 }] }), { status: 200 })
  offset += 6 * 60_000
  calls = []
  await usage.fetchUsage()
  check('a 429 asking for 20 minutes is not retried after 6', usageCalls() === 0, `${usageCalls()} call(s)`)
  offset += 15 * 60_000
  calls = []
  const after = await usage.fetchUsage()
  check('once the asked-for wait is over it checks again', usageCalls() === 1 && after.connected, `${usageCalls()} call(s)`)
}

Date.now = realNow
globalThis.setInterval = realSetInterval
await close()
fs.rmSync(fakeHome, { recursive: true, force: true })
done()
