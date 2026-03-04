import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'

const clients = new Set<WebSocket>()
let pingInterval: ReturnType<typeof setInterval> | null = null

export function registerWebSocket(app: FastifyInstance): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
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
