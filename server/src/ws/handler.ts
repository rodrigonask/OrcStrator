import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { WsEventName } from '@orcstrator/shared'
import { isAllowedOrigin, isAllowedHost } from '../config.js'
import { identify } from '../services/api-auth.js'

// Insertion-ordered, so the first entry is the oldest socket.
const clients = new Set<WebSocket>()
// Ping rounds in a row a socket has not answered. Two misses and it is dropped: one
// missed round can be a laptop lid closing for a moment, two (a minute or more) is gone.
const missedPongs = new WeakMap<WebSocket, number>()
const MAX_MISSED_PONGS = 2
const MAX_WS_CLIENTS = 50
let pingInterval: ReturnType<typeof setInterval> | null = null

// BACKPRESSURE. Every output batch went to every tab, and a tab that stops reading
// (a sleeping laptop, a frozen browser) let its unsent bytes pile up in this process without
// limit. Now a socket with more than SLOW_SOCKET_BYTES waiting is skipped for the high-volume
// stream frames, which are the ones that are both large and recoverable: the chat's saved
// history and /api/state carry everything they did. A socket that missed frames that way is
// closed once it has caught up, so the app reconnects and reloads the full picture instead of
// showing a chat with holes in it. Past DEAD_SOCKET_BYTES it is not coming back, and is cut.
export const SLOW_SOCKET_BYTES = 8 * 1024 * 1024
export const DEAD_SOCKET_BYTES = 4 * SLOW_SOCKET_BYTES
/** Frames a slow socket may miss: streaming output and the live token counter. */
const SKIPPABLE = new Set(['claude:output-batch', 'turn:progress'])
/** Sockets that missed at least one frame and must reload once they drain. */
const missedFrames = new WeakSet<WebSocket>()
/** A tool's output in a broadcast is cut to this many characters (the full text is in the transcript). */
export const TOOL_OUTPUT_BROADCAST_CAP = 20_000

// Per-client terminal subscriptions: socket -> Set of subscribed instanceIds
const terminalSubscribers = new Map<WebSocket, Set<string>>()

export function registerWebSocket(app: FastifyInstance): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
    // Origin + Host validation. This socket streams raw agent stdout — file contents,
    // source, .env values — so a drive-by page must never reach it. WebSockets are NOT
    // subject to CORS, so this check is the only thing standing between a malicious tab
    // and the stream; the browser attaches a truthful Origin to every WS upgrade and a
    // page cannot forge or suppress it. The Host check blocks DNS rebinding. (The
    // onRequest hook in index.ts covers the upgrade too — this is defence in depth, and
    // keeps the socket safe if the handler is ever mounted on another app.)
    if (!isAllowedHost(request.headers.host) || !isAllowedOrigin(request.headers.origin)) {
      console.warn(`[security] rejected WS upgrade — origin: ${request.headers.origin} host: ${request.headers.host}`)
      socket.close(1008, 'Origin not allowed')
      return
    }

    // The page's admin token. The onRequest guard already refused the upgrade
    // without one; checked again here so the socket stays safe if mounted elsewhere.
    const token = new URLSearchParams(request.url.split('?')[1] ?? '').get('token') ?? undefined
    if (identify(request.headers, token).kind !== 'admin') {
      socket.close(1008, 'Token required')
      return
    }

    // Connection limit: a full house used to refuse the NEWEST socket, so stray
    // connections could lock the app's own window out of live updates. Now the oldest one
    // makes room: a live window reconnects by itself, a leaked socket does not.
    trackClient(socket)
  })

  // 30s ping to keep connections alive, and to find the dead and the stuck.
  pingInterval = setInterval(pingRound, 30_000)

  app.addHook('onClose', () => {
    if (pingInterval) {
      clearInterval(pingInterval)
      pingInterval = null
    }
    for (const client of clients) {
      client.close()
    }
    clients.clear()
  })
}

function dropClient(socket: WebSocket): void {
  clients.delete(socket)
  terminalSubscribers.delete(socket)
}

/**
 * Take an accepted socket on as a broadcast recipient: the connection cap, pong tracking and
 * the terminal subscribe messages. Split out of the route so the backpressure and liveness
 * rules can be tested against a stand-in socket.
 */
export function trackClient(socket: WebSocket): void {
  while (clients.size >= MAX_WS_CLIENTS) {
    const oldest = clients.values().next().value as WebSocket | undefined
    if (!oldest) break
    dropClient(oldest)
    try { oldest.close(1013, 'Replaced by a newer connection') } catch { /* already gone */ }
  }

  clients.add(socket)
  missedPongs.set(socket, 0)
  socket.on('pong', () => { missedPongs.set(socket, 0) })

  socket.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as { type: string; instanceId?: string }
      if (msg.type === 'ping') {
        // Client liveness heartbeat: reply so it can detect a silently-dead socket.
        try { socket.send(JSON.stringify({ type: 'pong' })) } catch { /* socket dying */ }
      } else if (msg.type === 'subscribe:terminal' && msg.instanceId) {
        if (!terminalSubscribers.has(socket)) terminalSubscribers.set(socket, new Set())
        terminalSubscribers.get(socket)!.add(msg.instanceId)
      } else if (msg.type === 'unsubscribe:terminal' && msg.instanceId) {
        terminalSubscribers.get(socket)?.delete(msg.instanceId)
      }
    } catch { /* ignore malformed */ }
  })

  socket.on('close', () => dropClient(socket))
  socket.on('error', () => dropClient(socket))
}

/**
 * One liveness round. A socket that has not answered MAX_MISSED_PONGS pings in a row is gone
 * without a close frame and is terminated, so it stops holding a slot and a buffer.
 * A socket that skipped frames while it was slow and has now drained is closed on purpose:
 * the app reconnects at once and reloads what it missed. Exported for tests.
 */
export function pingRound(): void {
  try {
    for (const client of clients) {
      try {
        if (client.readyState !== client.OPEN) { dropClient(client); continue }
        const missed = missedPongs.get(client) ?? 0
        if (missed >= MAX_MISSED_PONGS) {
          console.warn(`[ws] a tab missed ${missed} pings in a row; dropping its connection`)
          dropClient(client)
          client.terminate()
          continue
        }
        if (missedFrames.has(client) && client.bufferedAmount < SLOW_SOCKET_BYTES) {
          missedFrames.delete(client)
          dropClient(client)
          // 4000: an application code the app treats like any close, reconnecting straight away.
          try { client.close(4000, 'Caught up, reload') } catch { client.terminate() }
          continue
        }
        missedPongs.set(client, missed + 1)
        client.ping()
      } catch {
        dropClient(client)
      }
    }
  } catch (err) {
    console.error('[ws] ping interval error:', err)
  }
}

/**
 * Send one serialized frame to one socket, honouring backpressure. Returns false when the
 * frame was skipped. A socket past DEAD_SOCKET_BYTES is cut outright.
 */
function sendTo(client: WebSocket, data: string, skippable: boolean): boolean {
  if (client.readyState !== client.OPEN) return false
  const queued = client.bufferedAmount
  if (queued > DEAD_SOCKET_BYTES) {
    console.warn(`[ws] a tab has ${Math.round(queued / 1048576)} MB unread; dropping its connection`)
    dropClient(client)
    try { client.terminate() } catch { /* already gone */ }
    return false
  }
  if (skippable && queued > SLOW_SOCKET_BYTES) {
    missedFrames.add(client)
    return false
  }
  client.send(data)
  return true
}

/**
 * The broadcast copy of an output batch, with each tool's output cut to
 * TOOL_OUTPUT_BROADCAST_CAP. One large tool result used to be serialized in full
 * and queued once per open tab. Returns the message itself when nothing needed cutting.
 */
export function slimOutputBatch(message: { type: string; payload: unknown }): { type: string; payload: unknown } {
  if (message.type !== 'claude:output-batch') return message
  const payload = message.payload as { events?: Array<Record<string, unknown>> } | null
  const events = payload?.events
  if (!Array.isArray(events)) return message
  let changed = false
  const slim = events.map(e => {
    if (e && e.type === 'tool-complete' && typeof e.output === 'string' && e.output.length > TOOL_OUTPUT_BROADCAST_CAP) {
      changed = true
      const dropped = e.output.length - TOOL_OUTPUT_BROADCAST_CAP
      return { ...e, output: `${e.output.slice(0, TOOL_OUTPUT_BROADCAST_CAP)}\n[... ${dropped.toLocaleString('en-US')} more characters not shown. The full output is in the session transcript.]` }
    }
    return e
  })
  return changed ? { ...message, payload: { ...(payload as object), events: slim } } : message
}

export function broadcastTerminalLine(instanceId: string, payload: unknown): void {
  // Serialize lazily — this runs for EVERY raw stdout line (tool results reach
  // ~1 MB each) and the subscriber set is empty unless a terminal view is open,
  // so an eager stringify here was pure hot-path waste.
  if (terminalSubscribers.size === 0) return
  let data: string | null = null
  for (const [client, subs] of terminalSubscribers) {
    if (subs.has(instanceId) && client.readyState === client.OPEN) {
      if (data === null) data = JSON.stringify({ type: 'claude:output-batch', payload })
      // Raw lines are the heaviest frames of all, and the terminal view reloads on reconnect.
      sendTo(client, data, true)
    }
  }
}

const VERBOSE = !!process.env.ORCSTRATOR_VERBOSE

// Typed against the shared event map: an event name the client does not know is a
// compile error here, not a feature that silently stops updating. Payloads are NOT checked on
// this side: the map is their contract, enforced where the client handles them (a server-wide
// payload retyping is a large refactor, ruled out on purpose).
export function broadcastEvent<K extends WsEventName>(message: { type: K; payload: unknown }): void {
  // Log all non-stream events (skip high-frequency output batches). Gated behind
  // ORCSTRATOR_VERBOSE so the dev console isn't a firehose of WS events.
  if (VERBOSE && message.type !== 'claude:output-batch') {
    console.log(`[ws] broadcast ${message.type} → ${clients.size} clients | ${JSON.stringify(message.payload).slice(0, 200)}`)
  }
  if (clients.size === 0) return
  const data = JSON.stringify(slimOutputBatch(message))
  const skippable = SKIPPABLE.has(message.type)
  for (const client of clients) {
    try { sendTo(client, data, skippable) } catch { dropClient(client) }
  }
}

export function getClientCount(): number {
  return clients.size
}
