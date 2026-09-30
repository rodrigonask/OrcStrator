// Every output batch went to every open tab, with no backpressure and no pong check.
// Stand-in sockets (no network): a fast tab, a tab that stopped reading, a tab that never
// answers pings, and one so far behind it is not coming back.
//
//   npx tsx server/test/ws-backpressure.test.ts

import { useScratchDataDir, check, done } from './helpers/scratch-app.js'

useScratchDataDir()
const ws = await import('../src/ws/handler.js') as Record<string, unknown>
const broadcastEvent = ws.broadcastEvent as (m: { type: string; payload: unknown }) => void
const trackClient = ws.trackClient as ((s: unknown) => void) | undefined
const pingRound = ws.pingRound as (() => void) | undefined

class FakeSocket {
  readonly OPEN = 1
  readyState = 1
  bufferedAmount = 0
  sent: string[] = []
  pings = 0
  terminated = false
  closedWith: number | null = null
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  send(data: string): void { this.sent.push(data) }
  ping(): void { this.pings++ }
  terminate(): void { this.terminated = true; this.readyState = 3; this.emit('close') }
  close(code?: number): void { this.closedWith = code ?? 1000; this.readyState = 3; this.emit('close') }
  on(event: string, fn: (...a: unknown[]) => void): void { (this.handlers[event] ??= []).push(fn) }
  emit(event: string, ...args: unknown[]): void { for (const fn of this.handlers[event] ?? []) fn(...args) }
  types(): string[] { return this.sent.map(s => (JSON.parse(s) as { type: string }).type) }
}

check('setup: the handler takes a socket on through trackClient', typeof trackClient === 'function')
check('setup: one liveness round can be run on demand (pingRound)', typeof pingRound === 'function')

const batch = (events: unknown[]) => ({ type: 'claude:output-batch', payload: { instanceId: 'c1', events } })

// ── A tab that stopped reading is skipped for stream frames, not for the rest ─────────────
{
  const fast = new FakeSocket()
  const slow = new FakeSocket()
  slow.bufferedAmount = 9 * 1024 * 1024
  trackClient?.(fast); trackClient?.(slow)
  broadcastEvent(batch([{ type: 'text-delta', instanceId: 'c1', text: 'hello' }]))
  broadcastEvent({ type: 'message:added', payload: { instanceId: 'c1', message: { id: 'm1' } } })
  check('a tab that is reading gets the output batch', fast.types().includes('claude:output-batch'), fast.types().join(','))
  check('a tab with over 8 MB unread is skipped for the output batch', !slow.types().includes('claude:output-batch'), slow.types().join(','))
  check('... but still gets the small state events (a new message)', slow.types().includes('message:added'), slow.types().join(','))

  // Once it has drained, it is closed on purpose so the app reconnects and reloads what it missed.
  slow.bufferedAmount = 0
  pingRound?.()
  check('a tab that skipped frames and has caught up is closed so it reloads (code 4000)', slow.closedWith === 4000, String(slow.closedWith))
  check('... and the tab that never fell behind is left alone', fast.closedWith === null && !fast.terminated)
  fast.close()
}

// ── Pongs: two missed rounds and the socket is terminated ─────────────────────────────
{
  const silent = new FakeSocket()
  const answering = new FakeSocket()
  trackClient?.(silent); trackClient?.(answering)
  const round = () => { pingRound?.(); answering.emit('pong') }
  round(); round()
  check('a tab that missed one or two pings is kept (a lid closing for a moment)', !silent.terminated && silent.pings === 2, `pings ${silent.pings}, terminated ${silent.terminated}`)
  round()
  check('a tab that missed 2 pongs in a row is terminated', silent.terminated)
  check('a tab that answers every ping is never terminated', !answering.terminated && answering.pings === 3, `pings ${answering.pings}`)
  // It no longer receives anything.
  const before = silent.sent.length
  broadcastEvent({ type: 'message:added', payload: {} })
  check('... and gets nothing more once dropped', silent.sent.length === before)
  answering.close()
}

// ── Too far behind to come back: cut ───────────────────────────────────────────────────
{
  const gone = new FakeSocket()
  gone.bufferedAmount = 40 * 1024 * 1024
  trackClient?.(gone)
  broadcastEvent({ type: 'message:added', payload: {} })
  check('a tab with over 32 MB unread is cut instead of queued for ever', gone.terminated && gone.sent.length === 0, `terminated ${gone.terminated}, sent ${gone.sent.length}`)
}

// ── Tool output is truncated in broadcasts ─────────────────────────────────────────────
{
  const tab = new FakeSocket()
  trackClient?.(tab)
  const big = 'x'.repeat(300_000)
  broadcastEvent(batch([{ type: 'tool-complete', instanceId: 'c1', toolId: 't1', output: big, isError: false }]))
  const frame = tab.sent.find(s => s.includes('tool-complete')) ?? ''
  let output = ''
  try { output = ((JSON.parse(frame) as { payload: { events: Array<{ output: string }> } }).payload.events[0].output) } catch { /* reported below */ }
  check('a 300k-character tool output reaches a tab cut to a bounded size', frame.length > 0 && frame.length < 40_000, `${frame.length} bytes`)
  check('... still valid, with a plain note that it was cut', output.startsWith('xxxx') && /more characters not shown/.test(output))
  const small = 'short output'
  broadcastEvent(batch([{ type: 'tool-complete', instanceId: 'c1', toolId: 't2', output: small }]))
  check('a short tool output is sent untouched', tab.sent.some(s => s.includes('"output":"short output"')))
  tab.close()
}

done()
process.exit()
