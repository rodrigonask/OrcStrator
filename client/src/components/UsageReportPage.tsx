import { useState, useEffect, useMemo, useCallback } from 'react'
import { api } from '../api'
import { useAppDispatch } from '../context/AppDispatchContext'
import type {
  UsageTrendDay,
  UsageByColumn,
  UsageForecast,
  UsageAnomaly,
  UsageEfficiencyDay,
} from '@shared/types'

type TimeRange = 7 | 14 | 30

interface SessionLogRow {
  session_id: string
  instance_id: string | null
  instance_name: string | null
  role: string
  task_title: string | null
  project_name: string | null
  cost_usd: number
  input_tokens: number
  output_tokens: number
  created_at: number
}

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

interface FolderCostRow {
  folderId: string
  folderName: string
  folderPath: string
  emoji: string | null
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheRead: number
  totalCacheCreation: number
  turnCount: number
  sessionCount: number
  cacheHitRatio: number
}

interface FolderCostNode {
  data: FolderCostRow
  children: FolderCostNode[]
  aggregatedCost: number
  aggregatedInput: number
  aggregatedOutput: number
  aggregatedCacheRead: number
  aggregatedTurns: number
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
  const [byFolder, setByFolder] = useState<FolderCostRow[]>([])
  const [weekdays, setWeekdays] = useState<WeekdayData[]>([])
  const [sessionLog, setSessionLog] = useState<SessionLogRow[]>([])
  const [logSortCol, setLogSortCol] = useState<string>('created_at')
  const [logSortAsc, setLogSortAsc] = useState(false)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const dispatch = useAppDispatch()

  const handleInstanceClick = useCallback((instanceId: string) => {
    dispatch({ type: 'SELECT_INSTANCE', payload: instanceId })
    dispatch({ type: 'SET_VIEW', payload: 'chat' })
  }, [dispatch])

  const fetchData = () => {
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
      api.getUsageLog(200, days),
      api.getUsageByFolder(days),
    ]).then(([t, c, f, a, e, s, s2, p, log, bf]) => {
      setTrend(t)
      setByColumn(c)
      setForecast(f)
      setAnomalies(a)
      setEfficiency(e)
      setStats(s)
      setPriorStats(s2)
      setByProject(p as unknown as ProjectUsage[])
      setWeekdays((s as UsageStats).byWeekday as unknown as WeekdayData[] ?? [])
      setSessionLog(log as unknown as SessionLogRow[])
      setByFolder(bf as unknown as FolderCostRow[])
    }).catch(err => console.error('Usage fetch error:', err))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchData() }, [days])

  const handleSyncUntracked = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/usage/sync-untracked', { method: 'POST' })
      const data = await res.json() as { imported: number; scanned: number; errors: number }
      setSyncResult(`Imported ${data.imported} of ${data.scanned} sessions${data.errors ? ` (${data.errors} errors)` : ''}`)
      if (data.imported > 0) fetchData()
    } catch (err) {
      setSyncResult('Sync failed')
      console.error('Sync error:', err)
    } finally {
      setSyncing(false)
    }
  }

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className="usage-range-btn font-mono"
            onClick={handleSyncUntracked}
            disabled={syncing}
            title="Import token usage from direct Claude CLI sessions"
          >
            {syncing ? 'Syncing...' : 'Sync Untracked'}
          </button>
          {syncResult && <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{syncResult}</span>}
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
      </div>

      {/* KPI Cards */}
      <div className="usage-kpi-row">
        <KpiCard label="Total Cost" value={`$${totalCost.toFixed(2)}`} sub={`${days}d`} delta={spendDelta} />
        <KpiCard label="Tokens Used" value={fmtTokens(totalInput + totalOutput)} sub={`${fmtTokens(totalInput)} in / ${fmtTokens(totalOutput)} out`} />
        <KpiCard label="Burn Rate" value={`$${(totalCost / Math.max(1, days)).toFixed(2)}/d`} sub={forecast ? `~$${forecast.projectedMonthly.toFixed(0)}/mo` : ''} />
        <KpiCard label="Cache Grade" value={cacheGradeLetter(cacheHit)} sub={`${(cacheHit * 100).toFixed(0)}% hit`} accent={cacheHit >= 0.6} />
        <KpiCard label="Tasks/Dollar" value={totalCost > 0 ? (totalSessions / totalCost).toFixed(1) : '0'} sub={`${totalSessions} tasks`} />
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

        {/* Project Attribution (legacy) */}
        <div className="usage-section">
          <h3 className="usage-section-title font-pixel">By Project</h3>
          <ProjectBars projects={byProject} totalCost={totalCost} />
        </div>
      </div>

      {/* Hierarchical Project Costs */}
      {byFolder.length > 0 && (
        <div className="usage-section">
          <h3 className="usage-section-title font-pixel">Project Cost Breakdown</h3>
          <FolderCostTree rows={byFolder} />
        </div>
      )}

      {/* Weekday Breakdown */}
      {weekdays.length > 0 && (
        <div className="usage-section">
          <h3 className="usage-section-title font-pixel">Cost by Weekday</h3>
          <WeekdayBars weekdays={weekdays} />
        </div>
      )}

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

      {/* Top Tasks by Cost */}
      {anomalies.length > 0 && (
        <div className="usage-section">
          <h3 className="usage-section-title font-pixel">Top Tasks by Cost</h3>
          <TopTasksTable tasks={anomalies} />
        </div>
      )}

      {/* Anomalies */}
      {anomalyCount > 0 && (
        <div className="usage-section">
          <h3 className="usage-section-title font-pixel">Anomalies ({anomalyCount})</h3>
          <AnomalyList anomalies={anomalies.filter(a => a.isAnomaly)} />
        </div>
      )}

      {/* Session Log */}
      {sessionLog.length > 0 && (
        <div className="usage-section">
          <h3 className="usage-section-title font-pixel">Session Log</h3>
          <SessionLogTable
            rows={sessionLog}
            sortCol={logSortCol}
            sortAsc={logSortAsc}
            onSort={(col) => {
              if (logSortCol === col) setLogSortAsc(a => !a)
              else { setLogSortCol(col); setLogSortAsc(true) }
            }}
            onInstanceClick={handleInstanceClick}
          />
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
  const columnOrder = ['ready', 'in_progress', 'in_review', 'other']
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

function TopTasksTable({ tasks }: { tasks: UsageAnomaly[] }) {
  const top = [...tasks].sort((a, b) => b.costUsd - a.costUsd).slice(0, 10)
  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th className="font-mono">Task</th>
          <th className="font-mono">Role</th>
          <th className="font-mono">Cost</th>
          <th className="font-mono">vs Median</th>
        </tr>
      </thead>
      <tbody>
        {top.map(t => (
          <tr key={t.sessionId}>
            <td className="font-mono">{t.taskTitle || '—'}</td>
            <td className="font-mono">{t.role}</td>
            <td className="font-mono">${t.costUsd.toFixed(3)}</td>
            <td className="font-mono">{t.multiplier}x</td>
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

function RecommendationsCard({ cacheHit, anomalyCount, forecast, efficiency, trend, roles, weekdays }: {
  cacheHit: number
  anomalyCount: number
  forecast: UsageForecast | null
  efficiency: UsageEfficiencyDay[]
  trend: UsageTrendDay[]
  roles: UsageStats['byRole']
  weekdays: WeekdayData[]
}) {
  const recs: Array<{ text: string; severity: 'warn' | 'info' }> = []

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

function WeekdayBars({ weekdays }: { weekdays: WeekdayData[] }) {
  const maxCost = Math.max(1, ...weekdays.map(w => w.total_cost_usd))
  const dayOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const sorted = [...weekdays].sort((a, b) => dayOrder.indexOf(a.label) - dayOrder.indexOf(b.label))

  return (
    <div className="usage-project-bars">
      {sorted.map(w => (
        <div key={w.label} className="usage-project-row">
          <span className="usage-project-name font-mono" style={{ width: 36, minWidth: 36 }}>{w.label}</span>
          <div className="usage-project-bar-track">
            <div className="usage-project-bar-fill" style={{ width: `${(w.total_cost_usd / maxCost) * 100}%` }} />
          </div>
          <span className="usage-project-cost font-mono">
            ${w.total_cost_usd.toFixed(2)}
            <span className="usage-pct"> ({w.session_count}s)</span>
          </span>
        </div>
      ))}
    </div>
  )
}

function SessionLogTable({ rows, sortCol, sortAsc, onSort, onInstanceClick }: {
  rows: SessionLogRow[]
  sortCol: string
  sortAsc: boolean
  onSort: (col: string) => void
  onInstanceClick?: (id: string) => void
}) {
  const sorted = useMemo(() => {
    if (!sortCol) return rows
    return [...rows].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortCol] ?? 0
      const bv = (b as Record<string, unknown>)[sortCol] ?? 0
      if (typeof av === 'number' && typeof bv === 'number') return sortAsc ? av - bv : bv - av
      return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
  }, [rows, sortCol, sortAsc])

  const sortIcon = (col: string) => sortCol === col ? (sortAsc ? ' \u25B2' : ' \u25BC') : ''

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="usage-table">
        <thead>
          <tr>
            <th className="font-mono" style={{ cursor: 'pointer' }} onClick={() => onSort('created_at')}>Date{sortIcon('created_at')}</th>
            <th className="font-mono" style={{ cursor: 'pointer' }} onClick={() => onSort('session_id')}>Session{sortIcon('session_id')}</th>
            <th className="font-mono" style={{ cursor: 'pointer' }} onClick={() => onSort('task_title')}>Task{sortIcon('task_title')}</th>
            <th className="font-mono" style={{ cursor: 'pointer' }} onClick={() => onSort('project_name')}>Project{sortIcon('project_name')}</th>
            <th className="font-mono" style={{ cursor: 'pointer' }} onClick={() => onSort('role')}>Role{sortIcon('role')}</th>
            <th className="font-mono" style={{ cursor: 'pointer' }} onClick={() => onSort('input_tokens')}>Input{sortIcon('input_tokens')}</th>
            <th className="font-mono" style={{ cursor: 'pointer' }} onClick={() => onSort('output_tokens')}>Output{sortIcon('output_tokens')}</th>
            <th className="font-mono" style={{ cursor: 'pointer' }} onClick={() => onSort('cost_usd')}>Cost{sortIcon('cost_usd')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr><td colSpan={8} className="font-mono" style={{ textAlign: 'center', color: 'var(--text-tertiary)', padding: 16 }}>No usage data</td></tr>
          ) : sorted.map((row, i) => (
            <tr key={i}>
              <td className="font-mono">{new Date(row.created_at).toLocaleDateString()}</td>
              <td className="font-mono">{row.session_id ? row.session_id.slice(0, 8) : '\u2014'}</td>
              <td className="font-mono">{row.task_title || '\u2014'}</td>
              <td className="font-mono">{row.project_name || '\u2014'}</td>
              <td className="font-mono" style={{ textTransform: 'capitalize' }}>
              {row.instance_id ? (
                <span style={{ cursor: 'pointer', color: 'var(--accent)', textDecoration: 'underline' }} onClick={() => onInstanceClick?.(row.instance_id!)}>{row.instance_name || row.role || '\u2014'}</span>
              ) : (row.role || '\u2014')}
            </td>
              <td className="font-mono">{(row.input_tokens ?? 0).toLocaleString()}</td>
              <td className="font-mono">{(row.output_tokens ?? 0).toLocaleString()}</td>
              <td className="font-mono">${(row.cost_usd ?? 0).toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// === Hierarchical Folder Cost Tree ===

function buildFolderCostTree(rows: FolderCostRow[]): FolderCostNode[] {
  const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')

  // Sort by path length so parents come before children
  const sorted = [...rows].sort((a, b) => a.folderPath.length - b.folderPath.length)
  const nodes: FolderCostNode[] = []

  const makeNode = (row: FolderCostRow): FolderCostNode => ({
    data: row,
    children: [],
    aggregatedCost: row.totalCostUsd,
    aggregatedInput: row.totalInputTokens,
    aggregatedOutput: row.totalOutputTokens,
    aggregatedCacheRead: row.totalCacheRead,
    aggregatedTurns: row.turnCount,
  })

  const findParent = (roots: FolderCostNode[], normalPath: string): FolderCostNode | null => {
    for (const node of roots) {
      const nodePath = normalize(node.data.folderPath)
      if (normalPath.startsWith(nodePath + '/') && normalPath !== nodePath) {
        const deeper = findParent(node.children, normalPath)
        return deeper || node
      }
    }
    return null
  }

  for (const row of sorted) {
    const newNode = makeNode(row)
    const parent = findParent(nodes, normalize(row.folderPath))
    if (parent) {
      parent.children.push(newNode)
    } else {
      nodes.push(newNode)
    }
  }

  // Aggregate costs up the tree
  const aggregate = (node: FolderCostNode): void => {
    for (const child of node.children) {
      aggregate(child)
      node.aggregatedCost += child.aggregatedCost
      node.aggregatedInput += child.aggregatedInput
      node.aggregatedOutput += child.aggregatedOutput
      node.aggregatedCacheRead += child.aggregatedCacheRead
      node.aggregatedTurns += child.aggregatedTurns
    }
  }
  for (const root of nodes) aggregate(root)

  return nodes
}

function FolderCostTree({ rows }: { rows: FolderCostRow[] }) {
  const tree = useMemo(() => buildFolderCostTree(rows), [rows])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const toggle = useCallback((id: string) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }, [])

  if (tree.length === 0) return <p className="font-mono" style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>No per-turn cost data yet</p>

  return (
    <div className="usage-folder-tree">
      {tree.map(node => (
        <FolderCostNodeRow key={node.data.folderId} node={node} depth={0} expanded={expanded} onToggle={toggle} />
      ))}
    </div>
  )
}

function FolderCostNodeRow({ node, depth, expanded, onToggle }: {
  node: FolderCostNode; depth: number;
  expanded: Record<string, boolean>; onToggle: (id: string) => void
}) {
  const hasChildren = node.children.length > 0
  const isOpen = expanded[node.data.folderId] ?? (depth === 0)
  const cacheRatio = node.aggregatedInput > 0 ? node.aggregatedCacheRead / node.aggregatedInput : 0
  const cacheColor = cacheRatio >= 0.7 ? '#22c55e' : cacheRatio >= 0.4 ? '#eab308' : '#ef4444'

  return (
    <>
      <div
        className="usage-folder-row"
        style={{ paddingLeft: depth * 20 + 8, cursor: hasChildren ? 'pointer' : 'default' }}
        onClick={() => hasChildren && onToggle(node.data.folderId)}
      >
        <span className="usage-folder-toggle" style={{ width: 16, display: 'inline-block', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
          {hasChildren ? (isOpen ? '▾' : '▸') : ' '}
        </span>
        <span style={{ marginRight: 6 }}>{node.data.emoji || '📁'}</span>
        <span className="font-mono" style={{ flex: 1, fontSize: 12 }}>{node.data.folderName}</span>
        <span className="font-mono" style={{ color: '#22c55e', fontSize: 12, minWidth: 70, textAlign: 'right' }}>
          ${node.aggregatedCost.toFixed(4)}
        </span>
        <span className="font-mono" style={{ opacity: 0.6, fontSize: 11, minWidth: 90, textAlign: 'right' }}>
          {fmtTokens(node.aggregatedInput)}in / {fmtTokens(node.aggregatedOutput)}out
        </span>
        <span className="font-mono" style={{ color: cacheColor, fontSize: 11, minWidth: 50, textAlign: 'right' }}>
          {Math.round(cacheRatio * 100)}%$
        </span>
        <span className="font-mono" style={{ opacity: 0.4, fontSize: 11, minWidth: 30, textAlign: 'right' }}>
          {node.aggregatedTurns}t
        </span>
      </div>
      {hasChildren && isOpen && node.children
        .sort((a, b) => b.aggregatedCost - a.aggregatedCost)
        .map(child => (
          <FolderCostNodeRow key={child.data.folderId} node={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} />
        ))
      }
    </>
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
