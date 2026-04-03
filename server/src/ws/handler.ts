import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { ALLOWED_ORIGINS } from '../config.js'

const clients = new Set<WebSocket>()
const MAX_WS_CLIENTS = 50
let pingInterval: ReturnType<typeof setInterval> | null = null

// Per-client terminal subscriptions: socket -> Set of subscribed instanceIds
const terminalSubscribers = new Map<WebSocket, Set<string>>()

export function registerWebSocket(app: FastifyInstance): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
    // Origin validation
    const origin = request.headers.origin
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
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
        if (msg.type === 'subscribe:terminal' && msg.instanceId) {
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
  const data = JSON.stringify({ type: 'claude:output-batch', payload })
  for (const [client, subs] of terminalSubscribers) {
    if (subs.has(instanceId) && client.readyState === client.OPEN) {
      client.send(data)
    }
  }
}

export function broadcastEvent(message: { type: string; payload: unknown }): void {
  // Log all non-stream events (skip high-frequency output batches)
  if (message.type !== 'claude:output-batch') {
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
