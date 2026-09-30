import { getSessionToken } from './auth'

type EventCallback = (payload: any) => void

class WsClient {
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<EventCallback>>()
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  public connected = false
  private hasConnectedBefore = false

  // Liveness tracking. A hard server kill (e.g. the dev-watch restart, or closing &
  // reopening OrcStrator) frequently does NOT deliver a clean WS close frame, so the
  // browser's socket can look "open" forever while delivering nothing — the chat just
  // silently stops updating. We drive our own ping/pong so a dead socket is detected
  // and reconnected within STALE_MS instead of relying on TCP timeouts (minutes).
  private lastSeenAt = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private static HEARTBEAT_MS = 10_000
  private static STALE_MS = 25_000

  private opening = false

  // Terminal feeds the page wants, with how many panels want each. The server forgets every
  // subscription when a socket closes, so they are replayed on every open; before, a terminal
  // panel went silent after any reconnect, and one opened while the socket was still
  // connecting never subscribed at all.
  private terminalSubs = new Map<string, number>()
  // The pending reconnect, kept so a forced reconnect or a disconnect can cancel it instead of
  // racing it into a second socket.
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  connect() {
    this.clearReconnectTimer()
    // Guard: connect() is called from multiple mount points — never open a second socket
    if (this.opening) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    // The live feed needs the page's token. After a server restart the old one is
    // unknown there, so every reconnect after a failed open asks for a fresh one.
    this.opening = true
    const refresh = this.hasConnectedBefore || this.reconnectDelay > 1000
    void getSessionToken(refresh).then(token => {
      this.opening = false
      this.open(token)
    })
  }

  private open(token: string | null) {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this.connected = true
      this.lastSeenAt = Date.now()
      // Reset exponential backoff after a successful (re)connect
      this.reconnectDelay = 1000
      this.startHeartbeat()
      this.emit('connection', { connected: true, reconnected: this.hasConnectedBefore })
      if (this.hasConnectedBefore) this.emit('reconnected', {})
      this.hasConnectedBefore = true
      for (const instanceId of this.terminalSubs.keys()) {
        this.ws?.send(JSON.stringify({ type: 'subscribe:terminal', instanceId }))
      }
    }

    this.ws.onmessage = (event) => {
      // Any inbound frame proves the socket is alive — refresh the liveness clock.
      this.lastSeenAt = Date.now()
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'pong') return // heartbeat reply — liveness already recorded
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
      this.stopHeartbeat()
      this.emit('connection', { connected: false })
      this.clearReconnectTimer()
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect() }, this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      // Ping to elicit a pong (keeps lastSeenAt fresh while idle)...
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ type: 'ping' })) } catch { /* caught by stale check */ }
      }
      // ...and if we've heard nothing back for too long, the socket is dead — reconnect.
      if (this.connected && Date.now() - this.lastSeenAt > WsClient.STALE_MS) {
        this.forceReconnect()
      }
    }, WsClient.HEARTBEAT_MS)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** Drop a presumed-dead socket and reconnect immediately, bypassing the close backoff. */
  forceReconnect() {
    this.stopHeartbeat()
    this.clearReconnectTimer()
    if (this.ws) {
      // Detach handlers so the dead socket's eventual close doesn't schedule a duplicate reconnect.
      this.ws.onclose = null
      this.ws.onmessage = null
      this.ws.onopen = null
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    this.connected = false
    this.reconnectDelay = 1000
    this.emit('connection', { connected: false })
    this.connect()
  }

  /**
   * Probe liveness right now and reconnect if the socket is gone or has gone quiet.
   * Called when the tab regains focus so a feed that died while the tab was hidden
   * (backend restart, laptop sleep) recovers instantly instead of after STALE_MS.
   */
  checkAlive() {
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return // a connect is already in flight
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this.forceReconnect(); return }
    if (Date.now() - this.lastSeenAt > WsClient.STALE_MS) { this.forceReconnect(); return }
    // Borderline — send an immediate ping so a marginal socket proves itself fast.
    try { this.ws.send(JSON.stringify({ type: 'ping' })) } catch { this.forceReconnect() }
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

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  subscribeTerminal(instanceId: string): void {
    const n = this.terminalSubs.get(instanceId) ?? 0
    this.terminalSubs.set(instanceId, n + 1)
    // Only the first panel for a chat subscribes; a socket that is not open yet picks it up
    // in onopen.
    if (n === 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe:terminal', instanceId }))
    }
  }

  unsubscribeTerminal(instanceId: string): void {
    const n = this.terminalSubs.get(instanceId) ?? 0
    if (n > 1) { this.terminalSubs.set(instanceId, n - 1); return }
    this.terminalSubs.delete(instanceId)
    if (n === 1 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe:terminal', instanceId }))
    }
  }

  disconnect() {
    this.stopHeartbeat()
    this.clearReconnectTimer()
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
      this.connected = false
    }
  }
}

export const wsClient = new WsClient()

// Recover the live feed the instant the user returns to a tab whose socket died while
// hidden (the common case: backend restarted, or the machine slept, while you were away).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wsClient.checkAlive()
  })
  window.addEventListener('focus', () => wsClient.checkAlive())
}
