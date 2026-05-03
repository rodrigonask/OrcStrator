import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import type { UsageData, UsageBucket } from '@shared/types'

function colorFor(pct: number): string {
  if (pct >= 90) return '#ef4444'
  if (pct >= 75) return '#f97316'
  if (pct >= 50) return '#eab308'
  return '#22c55e'
}

// Anthropic returns labels like "Current session % used" / "Weekly all-models % used".
// Strip the boilerplate so the row reads "session" / "all models" / "Sonnet only".
function shortLabel(label: string): string {
  return label
    .replace(/^Current\s+/i, '')
    .replace(/^Weekly\s+/i, '')
    .replace(/\s+%\s*used$/i, '')
    .replace(/\s+limits?$/i, '')
    .trim() || label
}

export function PlanLimitsWidget() {
  const [data, setData] = useState<UsageData | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [authStarted, setAuthStarted] = useState(false)
  const [pasteCode, setPasteCode] = useState('')
  const [exchanging, setExchanging] = useState(false)
  const [exchangeError, setExchangeError] = useState<string | null>(null)

  useEffect(() => {
    api.getUsage().then(setData).catch(() => {})
    const unsub = api.onUsageUpdated((payload: UsageData) => setData(payload))
    return () => { unsub() }
  }, [])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const fresh = await api.refreshUsage()
      setData(fresh)
    } catch { /* surfaced via lastUpdated staleness */ }
    finally { setRefreshing(false) }
  }, [])

  const handleConnect = useCallback(async () => {
    try {
      const { url } = await api.getAuthUrl()
      window.open(url, '_blank')
      setAuthStarted(true)
    } catch { /* user can retry */ }
  }, [])

  const handleExchange = useCallback(async () => {
    // Anthropic's callback page shows `<code>#<state>` joined by `#`. The token endpoint
    // wants just the code portion; the state is verified locally via the stored verifier.
    const code = pasteCode.trim().split('#')[0]
    if (!code) return
    setExchanging(true)
    setExchangeError(null)
    try {
      await api.exchangeCode(code)
      setPasteCode('')
      setAuthStarted(false)
      const fresh = await api.refreshUsage()
      setData(fresh)
    } catch (e) {
      setExchangeError((e as Error).message || 'Exchange failed')
    } finally {
      setExchanging(false)
    }
  }, [pasteCode])

  if (!data) return null

  if (!data.connected) {
    return (
      <div className="rs-section rs-plan-limits">
        <div className="rs-plan-limits-header">
          <span className="rs-plan-limits-title">Plan limits</span>
        </div>
        {!authStarted ? (
          <button className="rs-plan-limits-connect" onClick={handleConnect}>
            Connect Anthropic account
          </button>
        ) : (
          <div className="rs-plan-limits-paste">
            <div className="rs-plan-limits-paste-hint">
              Paste the code from the Anthropic page:
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

  if (data.buckets.length === 0) return null

  return (
    <div className="rs-section rs-plan-limits">
      <div className="rs-plan-limits-header">
        <span className="rs-plan-limits-title">Plan limits</span>
        <button
          className="rs-plan-limits-refresh"
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh now (auto-refreshes every 10 min)"
          aria-label="Refresh plan limits"
        >
          {refreshing ? '⋯' : '↻'}
        </button>
      </div>
      <div className="rs-plan-limits-buckets">
        {data.buckets.map((b, i) => (
          <BucketRow key={`${b.label}-${i}`} bucket={b} />
        ))}
      </div>
    </div>
  )
}

function BucketRow({ bucket }: { bucket: UsageBucket }) {
  const color = colorFor(bucket.percentage)
  return (
    <div className="rs-plan-limits-row">
      <div className="rs-plan-limits-row-top">
        <span className="rs-plan-limits-label">{shortLabel(bucket.label)}</span>
        <span className="rs-plan-limits-pct" style={{ color }}>{bucket.percentage}%</span>
      </div>
      <div className="rs-plan-limits-bar-track">
        <div
          className="rs-plan-limits-bar-fill"
          style={{ width: `${Math.min(bucket.percentage, 100)}%`, background: color }}
        />
      </div>
      {bucket.resetCountdown && (
        <div className="rs-plan-limits-countdown">resets in {bucket.resetCountdown}</div>
      )}
    </div>
  )
}
