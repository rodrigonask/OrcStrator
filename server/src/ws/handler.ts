import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { isAllowedOrigin, isAllowedHost } from '../config.js'

const clients = new Set<WebSocket>()
const MAX_WS_CLIENTS = 50
let pingInterval: ReturnType<typeof setInterval> | null = null

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

    // Connection limit
    if (clients.size >= MAX_WS_CLIENTS) {
      socket.close(1013, 'Too many connections')
      return
    }

    clients.add(socket)

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { type: string; instanceId?: string }
        if (msg.type === 'ping') {
          // Client liveness heartbeat — reply so it can detect a silently-dead socket.
          try { socket.send(JSON.stringify({ type: 'pong' })) } catch { /* socket dying */ }
        } else if (msg.type === 'subscribe:terminal' && msg.instanceId) {
          if (!terminalSubscribers.has(socket)) terminalSubscribers.set(socket, new Set())
          terminalSubscribers.get(socket)!.add(msg.instanceId)
        } else if (msg.type === 'unsubscribe:terminal' && msg.instanceId) {
          terminalSubscribers.get(socket)?.delete(msg.instanceId)
        }
      } catch { /* ignore malformed */ }
    })

    socket.on('close', () => {
      clients.delete(socket)
      terminalSubscribers.delete(socket)
    })

    socket.on('error', () => {
      clients.delete(socket)
      terminalSubscribers.delete(socket)
    })
  })

  // 30s ping to keep connections alive
  pingInterval = setInterval(() => {
    try {
      for (const client of clients) {
        try {
          if (client.readyState === client.OPEN) {
            client.ping()
          } else {
            clients.delete(client)
          }
        } catch {
          clients.delete(client)
        }
      }
    } catch (err) {
      console.error('[ws] ping interval error:', err)
    }
  }, 30_000)

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

export function broadcastTerminalLine(instanceId: string, payload: unknown): void {
  // Serialize lazily — this runs for EVERY raw stdout line (tool results reach
  // ~1 MB each) and the subscriber set is empty unless a terminal view is open,
  // so an eager stringify here was pure hot-path waste.
  if (terminalSubscribers.size === 0) return
  let data: string | null = null
  for (const [client, subs] of terminalSubscribers) {
    if (subs.has(instanceId) && client.readyState === client.OPEN) {
      if (data === null) data = JSON.stringify({ type: 'claude:output-batch', payload })
      client.send(data)
    }
  }
}

const VERBOSE = !!process.env.ORCSTRATOR_VERBOSE

export function broadcastEvent(message: { type: string; payload: unknown }): void {
  // Log all non-stream events (skip high-frequency output batches). Gated behind
  // ORCSTRATOR_VERBOSE so the dev console isn't a firehose of WS events.
  if (VERBOSE && message.type !== 'claude:output-batch') {
    console.log(`[ws] broadcast ${message.type} → ${clients.size} clients | ${JSON.stringify(message.payload).slice(0, 200)}`)
  }
  const data = JSON.stringify(message)
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(data)
    }
  }
}

export function getClientCount(): number {
  return clients.size
}
