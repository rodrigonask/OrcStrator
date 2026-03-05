import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { ALLOWED_ORIGINS } from '../config.js'

const clients = new Set<WebSocket>()
const MAX_WS_CLIENTS = 50
let pingInterval: ReturnType<typeof setInterval> | null = null

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

    socket.on('close', () => {
      clients.delete(socket)
    })

    socket.on('error', () => {
      clients.delete(socket)
    })
  })

  // 30s ping to keep connections alive
  pingInterval = setInterval(() => {
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.ping()
      } else {
        clients.delete(client)
      }
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

export function broadcastEvent(message: { type: string; payload: unknown }): void {
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
