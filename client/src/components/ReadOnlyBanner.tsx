import { useEffect, useState } from 'react'
import { rest } from '../api/rest'

/**
 * When the server could not make a safety backup before updating its database, it
 * starts read-only and refuses every change. Without this bar every button would simply fail;
 * with it the user reads why once, at the top of the app. Asked once at load; renders nothing
 * in the normal case.
 */
export function ReadOnlyBanner() {
  const [reason, setReason] = useState<string | null>(null)
  useEffect(() => {
    rest.getHealth().then(h => setReason(h.dbReadOnly ?? null)).catch(() => {})
  }, [])
  if (!reason) return null
  return (
    <div
      role="alert"
      style={{
        padding: '8px 16px', fontSize: 13, lineHeight: 1.4,
        background: 'var(--warning-bg, #fef3c7)', color: 'var(--warning-fg, #78350f)',
        borderBottom: '1px solid var(--warning, #f59e0b)',
      }}
    >
      <strong>Read-only:</strong> OrcStrator did not update its database, because it could not make a safety copy first.
      You can look at your chats, but nothing can be changed. Check there is free disk space and that its data folder can be written to, then restart OrcStrator to try again.
      <span style={{ display: 'block', fontSize: 11, opacity: 0.75, fontFamily: 'var(--font-mono, monospace)' }}>Technical detail (for troubleshooting): {reason}</span>
    </div>
  )
}
