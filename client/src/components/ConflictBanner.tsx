import { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { authFetch } from '../api/auth'

interface ConflictInfo {
  path: string
  holderName: string
}

/** Shown above the composer when this instance's run was paused by the
 *  file-lock safety layer. Cleared by ignoring (30 min) or dismissing. */
export function ConflictBanner({ instanceId }: { instanceId: string }) {
  const [conflict, setConflict] = useState<ConflictInfo | null>(null)
  const [ignoring, setIgnoring] = useState(false)

  useEffect(() => {
    setConflict(null)
    const unsub = api.onEvent('conflict:paused', (payload: { instanceId: string; path: string; holderName: string }) => {
      if (payload.instanceId === instanceId) {
        setConflict({ path: payload.path, holderName: payload.holderName })
      }
    })
    return unsub
  }, [instanceId])

  const handleIgnore = useCallback(async () => {
    setIgnoring(true)
    try {
      const res = await authFetch('/api/conflicts/ignore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      // A refused request leaves the banner up: hiding it would claim an ignore window the
      // server never opened.
      if (!res.ok) throw new Error(`The server answered ${res.status}`)
      setConflict(null)
    } catch (err) {
      console.error('Failed to set ignore window:', err)
    } finally {
      setIgnoring(false)
    }
  }, [])

  if (!conflict) return null

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '8px 12px', marginBottom: 6, borderRadius: 8, fontSize: 12,
        fontFamily: 'var(--font-mono)',
        background: 'color-mix(in srgb, #ef4444 10%, transparent)',
        border: '1px solid color-mix(in srgb, #ef4444 35%, transparent)',
      }}
    >
      <span style={{ flex: 1, minWidth: 200 }}>
        ⏸ Paused — <strong>{conflict.path}</strong> has uncommitted changes from{' '}
        <strong>{conflict.holderName}</strong>. Commit or PR that work before proceeding.
      </span>
      <button
        className="btn btn-sm btn-danger"
        onClick={handleIgnore}
        disabled={ignoring}
        title="Lifts file-lock enforcement for every instance for 30 minutes"
      >
        ⚠ Ignore restrictions for 30 min
      </button>
      <button className="btn btn-sm" onClick={() => setConflict(null)}>Dismiss</button>
    </div>
  )
}
