import { useState, useCallback } from 'react'
import { api } from '../api'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import type { UsageBucket } from '@shared/types'
import { useUsage } from '../context/LiveStatsContext'

export function PlanLimitsWidget() {
  const { settings } = useUI()
  const usage = useUsage()
  const { dispatch } = useAppDispatch()
  const [authStarted, setAuthStarted] = useState(false)
  const [pasteCode, setPasteCode] = useState('')
  const [exchanging, setExchanging] = useState(false)
  const [exchangeError, setExchangeError] = useState<string | null>(null)

  const handleConnect = useCallback(async () => {
    try {
      const { url } = await api.getAuthUrl()
      window.open(url, '_blank')
      setAuthStarted(true)
    } catch { /* user can retry */ }
  }, [])

  const handleExchange = useCallback(async () => {
    // Send the raw paste ("code#state") — the server splits it and echoes state
    // back to the token endpoint, which the manual-code flow requires.
    const code = pasteCode.trim()
    if (!code) return
    setExchanging(true)
    setExchangeError(null)
    try {
      const fresh = await api.exchangeCode(code)
      dispatch({ type: 'SET_USAGE', payload: fresh })
      setPasteCode('')
      setAuthStarted(false)
    } catch (e) {
      setExchangeError((e as Error).message || 'Exchange failed')
    } finally {
      setExchanging(false)
    }
  }, [pasteCode, dispatch])

  if (settings.showPlanLimits === false) return null
  if (!usage) return null

  if (!usage.connected) {
    return (
      <div className="rs-section rs-plan-limits">
        <div className="rs-plan-limits-header">
          <span className="rs-plan-limits-title">Plan limits</span>
        </div>
        {!authStarted ? (
          <>
            <button className="rs-plan-limits-connect" onClick={handleConnect}>
              Connect Claude account
            </button>
            {usage.lastError && (
              <div className="rs-plan-limits-paste-error">{usage.lastError}</div>
            )}
          </>
        ) : (
          <div className="rs-plan-limits-paste">
            <div className="rs-plan-limits-paste-hint">
              Paste the code from the callback page:
            </div>
            <input
              className="rs-plan-limits-paste-input"
              type="text"
              value={pasteCode}
              onChange={e => setPasteCode(e.target.value)}
              placeholder="code#state"
              onKeyDown={e => { if (e.key === 'Enter') handleExchange() }}
              autoFocus
            />
            <div className="rs-plan-limits-paste-actions">
              <button
                className="rs-plan-limits-paste-cancel"
                onClick={() => { setAuthStarted(false); setPasteCode(''); setExchangeError(null) }}
                disabled={exchanging}
              >
                Cancel
              </button>
              <button
                className="rs-plan-limits-connect"
                onClick={handleExchange}
                disabled={exchanging || !pasteCode.trim()}
              >
                {exchanging ? 'Connecting…' : 'Submit'}
              </button>
            </div>
            {exchangeError && (
              <div className="rs-plan-limits-paste-error">{exchangeError}</div>
            )}
          </div>
        )}
      </div>
    )
  }

  // Connected: zero-chrome — just the three buckets, one tight line each.
  // Disconnect + poll interval live in Settings → Advanced → Plan Limits.
  return (
    <div className="rs-section rs-plan-limits rs-plan-limits-compact">
      {usage.buckets.length === 0 ? (
        <div className="rs-plan-limits-paste-hint">No usage data yet</div>
      ) : (
        <div className="rs-plan-limits-buckets">
          {usage.buckets.map(b => (
            <BucketRow key={b.key} bucket={b} />
          ))}
        </div>
      )}
      {usage.lastError && (
        <div className="rs-plan-limits-paste-error">{usage.lastError}</div>
      )}
    </div>
  )
}

function BucketRow({ bucket }: { bucket: UsageBucket }) {
  // All buckets use the violet→indigo brand gradient. (The mockup actually greens the
  // model buckets; off-palette green is kept out of here as a deliberate divergence.)
  const barBg = 'linear-gradient(90deg, var(--accent), var(--info))'
  return (
    <div className="rs-plan-limits-row inline" title={`${bucket.label} ${bucket.pct}%${bucket.reset ? ` · resets in ${bucket.reset}` : ''}`}>
      <div className="rs-plan-limits-head">
        <span className="rs-plan-limits-label">{bucket.label}</span>
      </div>
      <div className="rs-plan-limits-bar-track">
        <div
          className="rs-plan-limits-bar-fill"
          style={{ width: `${Math.min(bucket.pct, 100)}%`, background: barBg }}
        />
      </div>
      <span className="rs-plan-limits-reset">{bucket.reset || ''}</span>
    </div>
  )
}
