import { useState, useEffect, useMemo } from 'react'
import { api } from '../api'
import type {
  UsageTrendDay,
  UsageByColumn,
  UsageForecast,
  UsageAnomaly,
  UsageEfficiencyDay,
} from '@shared/types'

type TimeRange = 7 | 14 | 30

interface WeekdayData {
  weekday: number
  label: string
  session_count: number
  total_cost_usd: number
}

interface UsageStats {
  summary: {
    total_cost_usd: number
    total_sessions: number
    avg_cost_per_session: number
    cache_hit_ratio: number
    total_input_tokens: number
    total_output_tokens: number
  }
  byRole: Array<{
    role: string
    session_count: number
    total_cost_usd: number
    avg_cost_usd: number
    cache_hit_ratio: number
  }>
  byWeekday?: WeekdayData[]
  byDay: Array<{ day: string; session_count: number; total_cost_usd: number }>
}

interface ProjectUsage {
  project_name: string
  total_cost_usd: number
  session_count: number
}

interface SavingsData {
  overdrivePct: number
  savedUsd: number
}

export function UsageReportPage() {
  const [days, setDays] = useState<TimeRange>(14)
  const [trend, setTrend] = useState<UsageTrendDay[]>([])
  const [byColumn, setByColumn] = useState<UsageByColumn[]>([])
  const [forecast, setForecast] = useState<UsageForecast | null>(null)
  const [anomalies, setAnomalies] = useState<UsageAnomaly[]>([])
  const [efficiency, setEfficiency] = useState<UsageEfficiencyDay[]>([])
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [priorStats, setPriorStats] = useState<UsageStats | null>(null)
  const [byProject, setByProject] = useState<ProjectUsage[]>([])
  const [savings, setSavings] = useState<SavingsData | null>(null)
  const [weekdays, setWeekdays] = useState<WeekdayData[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.getUsageTrend(days),
      api.getUsageByColumn(days),
      api.getUsageForecast(days),
      api.getUsageAnomalies(days),
      api.getUsageEfficiency(days),
      api.getUsageStats(days),
      api.getUsageStats(days * 2),
      api.getUsageByProject(days),
      api.getSavings(days),
    ]).then(([t, c, f, a, e, s, s2, p, sv]) => {
      setTrend(t)
      setByColumn(c)
      setForecast(f)
      setAnomalies(a)
      setEfficiency(e)
      setStats(s)
      setPriorStats(s2)
      setByProject(p as unknown as ProjectUsage[])
      setSavings(sv as unknown as SavingsData)
      setWeekdays((s as UsageStats).byWeekday as unknown as WeekdayData[] ?? [])
    }).catch(err => console.error('Usage fetch error:', err))
      .finally(() => setLoading(false))
  }, [days])

  if (loading) {
    return <div className="usage-page"><div className="usage-loading font-mono">Loading analytics...</div></div>
  }

  const totalCost = stats?.summary.total_cost_usd ?? 0
  const totalSessions = stats?.summary.total_sessions ?? 0
  const avgCost = stats?.summary.avg_cost_per_session ?? 0
  const cacheHit = stats?.summary.cache_hit_ratio ?? 0
  const totalInput = stats?.summary.total_input_tokens ?? 0
  const totalOutput = stats?.summary.total_output_tokens ?? 0
  const anomalyCount = anomalies.filter(a => a.isAnomaly).length

  // Compute spend delta vs prior equal window
  const priorTotalCost = (priorStats?.summary.total_cost_usd ?? 0) - totalCost
  const spendDelta = priorTotalCost > 0 ? ((totalCost - priorTotalCost) / priorTotalCost) * 100 : 0

  return (
    <div className="usage-page">
      <div className="usage-header">
        <h2 className="font-pixel" style={{ fontSize: 14, margin: 0 }}>Usage Analytics</h2>
        <div className="usage-range-selector">
          {([7, 14, 30] as TimeRange[]).map(d => (
            <button
              key={d}
              className={`usage-range-btn font-mono${days === d ? ' active' : ''}`}
              onClick={() => setDays(d)}
            >{d}d</button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="usage-kpi-row">
        <KpiCard label="Total Cost" value={`$${totalCost.toFixed(2)}`} sub={`${days}d`} delta={spendDelta} />
        <KpiCard label="Burn Rate" value={`$${(totalCost / Math.max(1, days)).toFixed(2)}/d`} sub={forecast ? `~$${forecast.projectedMonthly.toFixed(0)}/mo` : ''} />
        <KpiCard label="Cache Grade" value={cacheGradeLetter(cacheHit)} sub={`${(cacheHit * 100).toFixed(0)}% hit`} accent={cacheHit >= 0.6} />
        <KpiCard label="Tasks/Dollar" value={totalCost > 0 ? (totalSessions / totalCost).toFixed(1) : '0'} sub={`${totalSessions} tasks`} />
        <KpiCard label="Token Yield" value={totalInput > 0 ? (totalOutput / totalInput).toFixed(2) : '0'} sub="out/in ratio" />
      </div>

      {/* Forecast Card */}
      {forecast && forecast.projectedMonthly > 0 && (
        <div className="usage-forecast-card">
          <span className="font-mono usage-forecast-label">30d Forecast</span>
          <span className="font-pixel usage-forecast-value">${forecast.projectedMonthly.toFixed(2)}</span>
          <span className="font-mono usage-forecast-detail">
            ${forecast.dailyRate.toFixed(3)}/day &middot; R&sup2;={forecast.r2.toFixed(2)}
          </span>
        </div>
      )}

      {/* Timeline Chart */}
      <div className="usage-section">
        <h3 className="usage-section-title font-pixel">Token Trend</h3>
        <StackedAreaChart data={trend} />
      </div>

      {/* Two-column layout */}
      <div className="usage-two-col">
        {/* Role Efficiency Table */}
        <div className="usage-section">
          <h3 className="usage-section-title font-pixel">Role Efficiency</h3>
          <RoleTable roles={stats?.byRole ?? []} />
        </div>

        {/* Project Attribution */}
        <div className="usage-section">
          <h3 className="usage-section-title font-pixel">By Project</h3>
          <ProjectBars projects={byProject} totalCost={totalCost} />
        </div>
      </div>

      {/* Pipeline Heatmap */}
      <div className="usage-section">
        <h3 className="usage-section-title font-pixel">Pipeline Cost Heatmap</h3>
        <PipelineHeatmap columns={byColumn} />
      </div>

      {/* Efficiency Timeline */}
      <div className="usage-section">
        <h3 className="usage-section-title font-pixel">Daily Efficiency</h3>
        <EfficiencyTable data={efficiency} />
      </div>

      {/* Anomalies */}
      {anomalyCount > 0 && (
        <div className="usage-section">
          <h3 className="usage-section-title font-pixel">Anomalies ({anomalyCount})</h3>
          <AnomalyList anomalies={anomalies.filter(a => a.isAnomaly)} />
        </div>
      )}

      {/* Recommendations */}
      <RecommendationsCard
        cacheHit={cacheHit}
        anomalyCount={anomalyCount}
        forecast={forecast}
        efficiency={efficiency}
        trend={trend}
        roles={stats?.byRole ?? []}
        overdrivePct={savings?.overdrivePct ?? 100}
        weekdays={weekdays}
      />
    </div>
  )
}

// === Sub-components ===

function KpiCard({ label, value, sub, accent, delta }: { label: string; value: string; sub: string; accent?: boolean; delta?: number }) {
  return (
    <div className={`usage-kpi-card${accent ? ' accent' : ''}`}>
      <span className="usage-kpi-label font-mono">{label}</span>
      <span className="usage-kpi-value font-pixel">{value}</span>
      <span className="usage-kpi-sub font-mono">
        {sub}
        {delta !== undefined && delta !== 0 && (
          <span className={`usage-kpi-delta ${delta > 0 ? 'up' : 'down'}`}>
            {delta > 0 ? '+' : ''}{delta.toFixed(0)}%
          </span>
        )}
      </span>
    </div>
  )
}

function StackedAreaChart({ data }: { data: UsageTrendDay[] }) {
  const maxTokens = useMemo(() => {
    if (data.length === 0) return 1
    return Math.max(1, ...data.map(d => d.coldInput + d.cacheCreation + d.cacheRead + d.outputTokens))
  }, [data])

  if (data.length === 0) {
    return <div className="usage-empty font-mono">No data for this period</div>
  }

  return (
    <div className="usage-chart">
      <div className="usage-chart-bars">
        {data.map((d, i) => {
          const total = d.coldInput + d.cacheCreation + d.cacheRead + d.outputTokens
          const pct = (total / maxTokens) * 100
          const coldPct = total > 0 ? (d.coldInput / total) * 100 : 0
          const createPct = total > 0 ? (d.cacheCreation / total) * 100 : 0
          const readPct = total > 0 ? (d.cacheRead / total) * 100 : 0
          const outPct = total > 0 ? (d.outputTokens / total) * 100 : 0

          return (
            <div key={i} className="usage-chart-col" title={`${d.day}\nCost: $${d.costUsd.toFixed(3)}\nSessions: ${d.sessions}`}>
              <div className="usage-chart-bar" style={{ height: `${pct}%` }}>
                <div className="usage-bar-segment bar-output" style={{ height: `${outPct}%` }} />
                <div className="usage-bar-segment bar-cache-read" style={{ height: `${readPct}%` }} />
                <div className="usage-bar-segment bar-cache-create" style={{ height: `${createPct}%` }} />
                <div className="usage-bar-segment bar-cold" style={{ height: `${coldPct}%` }} />
              </div>
              <span className="usage-chart-label font-mono">{d.day.slice(5)}</span>
            </div>
          )
        })}
      </div>
      <div className="usage-chart-legend">
        <span className="usage-legend-item"><span className="usage-dot bar-cold" />Cold</span>
        <span className="usage-legend-item"><span className="usage-dot bar-cache-create" />Cache Write</span>
        <span className="usage-legend-item"><span className="usage-dot bar-cache-read" />Cache Read</span>
        <span className="usage-legend-item"><span className="usage-dot bar-output" />Output</span>
      </div>
    </div>
  )
}

function RoleTable({ roles }: { roles: UsageStats['byRole'] }) {
  if (roles.length === 0) return <div className="usage-empty font-mono">No role data</div>
  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th className="font-mono">Role</th>
          <th className="font-mono">Sessions</th>
          <th className="font-mono">Cost</th>
          <th className="font-mono">Avg</th>
          <th className="font-mono">Cache</th>
        </tr>
      </thead>
      <tbody>
        {roles.map(r => (
          <tr key={r.role}>
            <td className="font-mono">{r.role}</td>
            <td className="font-mono">{r.session_count}</td>
            <td className="font-mono">${r.total_cost_usd.toFixed(3)}</td>
            <td className="font-mono">${r.avg_cost_usd.toFixed(3)}</td>
            <td className="font-mono">{(r.cache_hit_ratio * 100).toFixed(0)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ProjectBars({ projects, totalCost }: { projects: ProjectUsage[]; totalCost: number }) {
  if (projects.length === 0) return <div className="usage-empty font-mono">No project data</div>
  const maxCost = Math.max(1, ...projects.map(p => p.total_cost_usd))
  return (
    <div className="usage-project-bars">
      {projects.map(p => (
        <div key={p.project_name} className="usage-project-row">
          <span className="usage-project-name font-mono">{p.project_name}</span>
          <div className="usage-project-bar-track">
            <div
              className="usage-project-bar-fill"
              style={{ width: `${(p.total_cost_usd / maxCost) * 100}%` }}
            />
          </div>
          <span className="usage-project-cost font-mono">
            ${p.total_cost_usd.toFixed(2)}
            {totalCost > 0 && <span className="usage-pct"> ({(p.total_cost_usd / totalCost * 100).toFixed(0)}%)</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

function PipelineHeatmap({ columns }: { columns: UsageByColumn[] }) {
  if (columns.length === 0) return <div className="usage-empty font-mono">No pipeline data</div>
  const maxCost = Math.max(1, ...columns.map(c => c.costUsd))
  const columnOrder = ['spec', 'build', 'qa', 'ship', 'other']
  const sorted = [...columns].sort((a, b) => {
    const ai = columnOrder.indexOf(a.column)
    const bi = columnOrder.indexOf(b.column)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  return (
    <div className="usage-heatmap">
      {sorted.map(c => {
        const intensity = c.costUsd / maxCost
        const hue = 120 - intensity * 120 // green to red
        return (
          <div
            key={c.column}
            className="usage-heatmap-cell"
            style={{ backgroundColor: `hsla(${hue}, 70%, 50%, ${0.2 + intensity * 0.6})` }}
          >
            <span className="usage-heatmap-col font-pixel">{c.column}</span>
            <span className="usage-heatmap-cost font-mono">${c.costUsd.toFixed(2)}</span>
            <span className="usage-heatmap-sessions font-mono">{c.sessions}s</span>
          </div>
        )
      })}
    </div>
  )
}

function EfficiencyTable({ data }: { data: UsageEfficiencyDay[] }) {
  if (data.length === 0) return <div className="usage-empty font-mono">No efficiency data</div>
  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th className="font-mono">Day</th>
          <th className="font-mono">Yield</th>
          <th className="font-mono">Avg Prompt</th>
          <th className="font-mono">Cache</th>
        </tr>
      </thead>
      <tbody>
        {data.map(d => (
          <tr key={d.day}>
            <td className="font-mono">{d.day.slice(5)}</td>
            <td className="font-mono">{d.yieldRatio.toFixed(2)}</td>
            <td className="font-mono">{d.avgPromptChars.toLocaleString()}</td>
            <td className={`font-mono usage-grade-${d.cacheGrade}`}>{d.cacheGrade}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function AnomalyList({ anomalies }: { anomalies: UsageAnomaly[] }) {
  return (
    <div className="usage-anomaly-list">
      {anomalies.slice(0, 10).map(a => (
        <div key={a.sessionId} className="usage-anomaly-row">
          <span className="usage-anomaly-role font-mono">{a.role}</span>
          <span className="usage-anomaly-cost font-mono">${a.costUsd.toFixed(3)}</span>
          <span className="usage-anomaly-mult font-mono">{a.multiplier}x median</span>
          {a.taskTitle && <span className="usage-anomaly-task font-mono">{a.taskTitle}</span>}
        </div>
      ))}
    </div>
  )
}

function RecommendationsCard({ cacheHit, anomalyCount, forecast, efficiency, trend, roles, overdrivePct, weekdays }: {
  cacheHit: number
  anomalyCount: number
  forecast: UsageForecast | null
  efficiency: UsageEfficiencyDay[]
  trend: UsageTrendDay[]
  roles: UsageStats['byRole']
  overdrivePct: number
  weekdays: WeekdayData[]
}) {
  const recs: Array<{ text: string; severity: 'warn' | 'info' }> = []

  // Overdrive nudge
  if (overdrivePct < 50) {
    recs.push({ severity: 'warn', text: `Only ${overdrivePct}% of sessions use Overdrive cache. Run tasks consecutively within 1h to cut input costs by up to 85%.` })
  }

  // Role imbalance: builder avg > 3x planner avg
  const builderRole = roles.find(r => r.role === 'builder')
  const plannerRole = roles.find(r => r.role === 'planner')
  if (builderRole && plannerRole && plannerRole.avg_cost_usd > 0 && builderRole.avg_cost_usd > 3 * plannerRole.avg_cost_usd) {
    recs.push({ severity: 'info', text: `Builder sessions cost ${(builderRole.avg_cost_usd / plannerRole.avg_cost_usd).toFixed(1)}x more than Planner. Consider splitting large build tasks into smaller units.` })
  }

  // Peak-day tip: Mon/Tue top-2 spend days
  if (weekdays.length >= 2) {
    const sorted = [...weekdays].sort((a, b) => b.total_cost_usd - a.total_cost_usd)
    const top2Labels = sorted.slice(0, 2).map(w => w.label)
    if (top2Labels.includes('Mon') && top2Labels.includes('Tue')) {
      recs.push({ severity: 'info', text: 'Mon and Tue are your highest-spend days. Spread pipeline work across the week to avoid cache cold starts.' })
    }
  }

  // Cache warm-up tip: cache_creation > cache_read
  const totalCacheCreate = trend.reduce((s, d) => s + d.cacheCreation, 0)
  const totalCacheRead = trend.reduce((s, d) => s + d.cacheRead, 0)
  if (totalCacheCreate > totalCacheRead && totalCacheCreate > 0) {
    recs.push({ severity: 'warn', text: 'Cache creation exceeds cache reads — most sessions are cold starts. Batch related tasks per project to warm the cache.' })
  }

  // Anomaly alert
  if (anomalyCount > 0) {
    recs.push({ severity: 'warn', text: `${anomalyCount} anomalous session${anomalyCount > 1 ? 's' : ''} detected (>2x median cost). Review for prompt bloat or infinite tool loops.` })
  }

  // Forecast warning
  if (forecast && forecast.projectedMonthly > 50) {
    recs.push({ severity: 'info', text: `At current rate, projected monthly spend is $${forecast.projectedMonthly.toFixed(2)}. Consider setting per-task token budgets.` })
  }

  // Poor cache grades
  const recentGrades = efficiency.slice(-7)
  const poorGrades = recentGrades.filter(e => e.cacheGrade === 'F' || e.cacheGrade === 'D').length
  if (poorGrades >= 3) {
    recs.push({ severity: 'warn', text: `${poorGrades} of last 7 days have D/F cache grades. Ensure agents reuse sessions and avoid cold starts.` })
  }

  if (recs.length === 0) return null

  return (
    <div className="usage-section">
      <h3 className="usage-section-title font-pixel">Recommendations</h3>
      <div className="usage-recs-list">
        {recs.map((r, i) => (
          <div key={i} className={`usage-rec-item usage-rec-${r.severity} font-mono`}>{r.text}</div>
        ))}
      </div>
    </div>
  )
}

// === Helpers ===

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function cacheGradeLetter(ratio: number): string {
  if (ratio >= 0.8) return 'A'
  if (ratio >= 0.6) return 'B'
  if (ratio >= 0.4) return 'C'
  if (ratio >= 0.2) return 'D'
  return 'F'
}
