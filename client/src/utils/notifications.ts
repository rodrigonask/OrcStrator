// Desktop chat notifications (Web Notification API)
// - Lazy permission request: only asks the first time a notification would fire
// - Throttled: max one notification per instance per 5 seconds

const THROTTLE_MS = 5000
const lastNotifiedAt: Record<string, number> = {}

interface ChatNotification {
  instanceId: string
  title: string
  body: string
  onClick?: () => void
}

function show({ instanceId, title, body, onClick }: ChatNotification): void {
  try {
    const n = new Notification(title, { body, tag: `orcstrator-${instanceId}` })
    n.onclick = () => {
      window.focus()
      onClick?.()
      n.close()
    }
  } catch {
    /* Notification construction can throw on some platforms */
  }
}

/**
 * Fire a desktop notification for a chat event.
 * Caller is responsible for gating on settings + focus/selection state.
 * Returns true if the notification was attempted (i.e. not throttled/denied),
 * so callers can pair it with a sound under the same throttle.
 */
export function notifyChatEvent(opts: ChatNotification): boolean {
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'denied') return false

  const now = Date.now()
  if (now - (lastNotifiedAt[opts.instanceId] ?? 0) < THROTTLE_MS) return false
  lastNotifiedAt[opts.instanceId] = now

  if (Notification.permission === 'granted') {
    show(opts)
  } else {
    // permission === 'default' — lazy request the first time a notification would fire
    Notification.requestPermission().then(p => {
      if (p === 'granted') show(opts)
    }).catch(() => {})
  }
  return true
}
