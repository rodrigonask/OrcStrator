type EventCallback = (payload: any) => void

class WsClient {
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<EventCallback>>()
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  public connected = false
  private hasConnectedBefore = false

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${location.host}/ws`
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this.connected = true
      this.reconnectDelay = 1000
      this.emit('connection', { connected: true, reconnected: this.hasConnectedBefore })
      this.hasConnectedBefore = true
    }

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        this.emit(msg.type, msg.payload)
      } catch {
        // ignore malformed messages
      }
    }

    this.ws.onerror = () => {
      // onclose will fire after this, triggering reconnect
    }

    this.ws.onclose = () => {
      this.connected = false
      this.ws = null
      this.emit('connection', { connected: false })
      setTimeout(() => this.connect(), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
    }
  }

  on(event: string, cb: EventCallback): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(cb)
    return () => {
      this.listeners.get(event)?.delete(cb)
    }
  }

  private emit(event: string, payload: any) {
    this.listeners.get(event)?.forEach((cb) => cb(payload))
  }

  disconnect() {
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
      this.connected = false
    }
  }
}

export const wsClient = new WsClient()
