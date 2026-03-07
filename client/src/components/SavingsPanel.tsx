import { useState, useEffect } from 'react'
import type { SavingsSummary } from '@shared/types'
import { api } from '../api'

function fmtK(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

export function SavingsPanel() {
  const [data, setData] = useState<SavingsSummary | null>(null)

  useEffect(() => {
    function load() { api.getSavings(7).then(setData).catch(() => {}) }
    load()
    const id = setInterval(load, 5 * 60_000)
    return () => clearInterval(id)
  }, [])

  if (!data || data.totalSessions === 0) return null

  const maxCacheRead = Math.max(...data.days.map(d => d.cacheRead), 1)

  return (
    <div className="rs-section rs-savings">
      <div className="rs-section-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>Cache Savings (7d)</div>
      <div className="rs-savings-stats">
        <span className="rs-savings-tokens" style={{ fontFamily: 'var(--font-mono)', fontSize: 7 }}>{fmtK(data.savedTokens)} tkns saved</span>
        {data.savedUsd > 0 && (
          <span className="rs-savings-usd" style={{ fontFamily: 'var(--font-mono)', fontSize: 7 }}>~${data.savedUsd.toFixed(2)} est.</span>
        )}
        <span className={`rs-savings-pct ${data.overdrivePct >= 50 ? 'good' : 'warn'}`} style={{ fontFamily: 'var(--font-mono)', fontSize: 7 }}>
          {data.overdrivePct}% OD
        </span>
      </div>

      <div className="rs-savings-chart" title="Daily cache-read tokens (7 days)">
        {data.days.map(d => (
          <div
            key={d.day}
            className="rs-savings-bar"
            style={{ height: `${Math.round(d.cacheRead / maxCacheRead * 100)}%` }}
            title={`${d.day}: ${fmtK(d.cacheRead)} cached, ${d.overdriveSessions}/${d.sessions} OD`}
          />
        ))}
      </div>

      {data.recommendation && (
        <div className="rs-savings-tip">{data.recommendation}</div>
      )}
    </div>
  )
}
