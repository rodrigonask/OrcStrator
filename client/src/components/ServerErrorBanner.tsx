import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'

/**
 * Something went wrong inside the server that belongs to no chat (an uncaught error, a failed
 * write with no chat attached): said once, in plain words, at the top of the window.
 * A failure that belongs to a chat is said in that chat instead (AppContext). The server already
 * throttles these to one per kind per minute.
 *
 * Portalled to <body>: the zoom transform on .app would otherwise misplace a fixed element.
 */
export function ServerErrorBanner() {
  const [notice, setNotice] = useState<{ message: string; at: number } | null>(null)
  useEffect(() => api.onEvent('server:error', p => {
    if (!p || p.instanceId) return
    setNotice({ message: p.message, at: p.at })
  }), [])
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 30_000)
    return () => clearTimeout(t)
  }, [notice])
  if (!notice) return null
  return createPortal(
    <div className="server-error-banner" role="alert">
      <span>⚠ {notice.message}</span>
      <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
    </div>,
    document.body,
  )
}
