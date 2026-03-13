import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useInstances } from '../../context/InstancesContext'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { useAllPipelineTasks } from '../../hooks/useAllPipelineTasks'
import { useAgentNames } from '../../hooks/useAgentNames'
import { api } from '../../api'
import { fmtUsd, fmtTime, fmtOrcLog } from '../../utils/format'
import {
  COLUMN_COLORS,
  DEFAULT_COLUMN_LABELS,
  PIPELINE_COLUMNS,
  ORC_LOG_FILTER_TYPES,
} from '@shared/constants'
import type { OrcLogEntry, OrcLogFilter, PipelineTask, UsageTrendDay } from '@shared/types'

// --- helpers ---

function fmtUptime(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `${h}h ${m}m`
}

function fmtDuration(startMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - startMs) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

type HealthData = {
  processes: number
  maxProcesses: number
  uptime: number
}

type ProcessInfo = {
  instanceId: string
  instanceName: string
  agentRole: string | null
  taskId: string | null
  taskTitle: string | null
  lastCostUsd: number | null
}

// --- component ---

export function OrcDashboard() {
  const { instances, folders } = useInstances()
  const { dispatch } = useAppDispatch()
  const { allTasks } = useAllPipelineTasks()
  const agentNames = useAgentNames() as Record<string, string>

  // Polled data
  const [health, setHealth] = useState<HealthData | null>(null)
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [todayCost, setTodayCost] = useState<number | null>(null)

  // Orc activity log
  const [orcLogs, setOrcLogs] = useState<OrcLogEntry[]>([])
  const [orcFilter, setOrcFilter] = useState<OrcLogFilter>('all')
  const [orcHovered, setOrcHovered] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  // Live timer for durations
  const [now, setNow] = useState(Date.now())

  // --- Polling effects ---

  // Health: 30s
  useEffect(() => {
    const load = () => api.getHealth().then(setHealth).catch(() => {})
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  // Processes: 10s
  useEffect(() => {
    const load = () =>
      api.getProcesses().then(r => setProcesses(r.processes)).catch(() => {})
    load()
    const id = setInterval(load, 10_000)
    return () => clearInterval(id)
  }, [])

  // Today's cost: 60s
  useEffect(() => {
    const load = () =>
      api.getUsageTrend(1).then((days: UsageTrendDay[]) => {
        if (days.length > 0) setTodayCost(days[0].costUsd)
      }).catch(() => {})
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [])

  // Orc logs: initial + live
  useEffect(() => {
    api.getOrchestratorLogs({ limit: 50 })
      .then(r => setOrcLogs(r.logs.slice(-50).reverse()))
      .catch(() => {})
    const unsub = api.onOrchestratorLog((entry: OrcLogEntry) => {
      setOrcLogs(prev => {
        if (prev.some(l => l.id === entry.id)) return prev
        return [entry, ...prev].slice(0, 80)
      })
    })
    return unsub
  }, [])

  // Auto-scroll log
  useEffect(() => {
    if (!orcHovered && logEndRef.current) {
      logEndRef.current.scrollTop = 0
    }
  }, [orcLogs, orcHovered])

  // 1-second timer for live durations
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // --- Computed ---

  const runningInstances = useMemo(
    () => instances.filter(i => i.state === 'running'),
    [instances]
  )
  const activeFolderIds = useMemo(
    () => new Set(folders.filter(f => f.orchestratorActive).map(f => f.id)),
    [folders]
  )
  const idleCount = useMemo(
    () => instances.filter(i => i.state === 'idle' && activeFolderIds.has(i.folderId)).length,
    [instances, activeFolderIds]
  )

  // Enrich running instances with process data
  const activeAgents = useMemo(() => {
    return runningInstances.map(inst => {
      const proc = processes.find(p => p.instanceId === inst.id)
      const folder = folders.find(f => f.id === inst.folderId)
      return { inst, proc, folder }
    })
  }, [runningInstances, processes, folders])

  // Projects with tasks
  const projectStats = useMemo(() => {
    const projectIds = new Set(allTasks.map(t => t.projectId))
    return [...projectIds]
      .map(pid => {
        const folder = folders.find(f => f.id === pid)
        if (!folder) return null
        const tasks = allTasks.filter(t => t.projectId === pid)
        const running = instances.filter(i => i.folderId === pid && i.state === 'running').length
        const cost = tasks.reduce((s, t) => s + (t.totalCostUsd || 0), 0)
        // Column distribution
        const cols: Record<string, number> = {}
        for (const col of PIPELINE_COLUMNS) {
          cols[col] = tasks.filter(t => t.column === col).length
        }
        return { folder, tasks, running, cost, cols, total: tasks.length }
      })
      .filter(Boolean) as Array<{
        folder: (typeof folders)[0]
        tasks: PipelineTask[]
        running: number
        cost: number
        cols: Record<string, number>
        total: number
      }>
  }, [allTasks, folders, instances])

  // Sort: stealth first, then sortOrder
  const sortedProjects = useMemo(
    () =>
      [...projectStats].sort((a, b) => {
        if (a.folder.stealthMode && !b.folder.stealthMode) return -1
        if (!a.folder.stealthMode && b.folder.stealthMode) return 1
        return (a.folder.sortOrder ?? 999) - (b.folder.sortOrder ?? 999)
      }),
    [projectStats]
  )

  // Alerts
  const alerts = useMemo(() => {
    const items: Array<{
      severity: 'red' | 'orange' | 'yellow' | 'gray'
      icon: string
      task: PipelineTask
      detail: string
      folder: (typeof folders)[0] | undefined
    }> = []

    for (const task of allTasks) {
      const folder = folders.find(f => f.id === task.projectId)
      if (task.labels?.includes('stuck')) {
        items.push({
          severity: 'red',
          icon: '\u{1F534}',
          task,
          detail: 'stuck',
          folder,
        })
      }
      if (
        task.column === 'in_progress' &&
        task.currentStepRole &&
        !instances.some(
          i => i.folderId === task.projectId && i.agentRole === task.currentStepRole
        )
      ) {
        items.push({
          severity: 'orange',
          icon: '\u{1F7E0}',
          task,
          detail: `no ${task.currentStepRole}`,
          folder,
        })
      }
      if ((task.retryCount ?? 0) >= 2) {
        items.push({
          severity: 'yellow',
          icon: '\u{1F7E1}',
          task,
          detail: `retry #${task.retryCount}`,
          folder,
        })
      }
      if (task.labels?.includes('blocked')) {
        items.push({
          severity: 'gray',
          icon: '\u26AA',
          task,
          detail: 'blocked',
          folder,
        })
      }
    }

    // Dedup by taskId (keep highest severity)
    const seen = new Set<string>()
    return items.filter(a => {
      if (seen.has(a.task.id)) return false
      seen.add(a.task.id)
      return true
    })
  }, [allTasks, folders, instances])

  // Filtered orc logs
  const filteredLogs = useMemo(
    () =>
      orcFilter === 'all'
        ? orcLogs
        : orcLogs.filter(l => ORC_LOG_FILTER_TYPES[orcFilter]?.includes(l.type as string)),
    [orcLogs, orcFilter]
  )

  // --- Handlers ---

  const handleAgentClick = useCallback(
    (instanceId: string) => {
      dispatch({ type: 'SELECT_INSTANCE', payload: instanceId })
      dispatch({ type: 'SET_VIEW', payload: 'chat' })
    },
    [dispatch]
  )

  const handleProjectClick = useCallback(
    (projectId: string) => {
      dispatch({ type: 'SET_PIPELINE_PROJECT', projectId })
      dispatch({ type: 'SET_VIEW', payload: 'pipeline' })
    },
    [dispatch]
  )

  const handleAlertClick = useCallback(
    (projectId: string) => {
      dispatch({ type: 'SET_PIPELINE_PROJECT', projectId })
      dispatch({ type: 'SET_VIEW', payload: 'pipeline' })
    },
    [dispatch]
  )

  // --- Render ---

  return (
    <div className="orc-dash">
      {/* === Status Bar === */}
      <div className="orc-dash-status">
        <span className="orc-dash-pill">
          PROCESSES{' '}
          <strong>
            {health ? `${health.processes}/${health.maxProcesses}` : '\u2014'}
          </strong>
        </span>
        <span className="orc-dash-pill">
          {runningInstances.length > 0 && (
            <span className="orc-dash-pulse" />
          )}
          RUNNING <strong>{runningInstances.length}</strong>
        </span>
        <span className="orc-dash-pill">
          IDLE <strong>{idleCount}</strong>
        </span>
        <span className="orc-dash-pill">
          TODAY{' '}
          <strong>{todayCost !== null ? fmtUsd(todayCost) : '\u2014'}</strong>
        </span>
        <span className="orc-dash-pill">
          UP{' '}
          <strong>{health ? fmtUptime(health.uptime / 1000) : '\u2014'}</strong>
        </span>
      </div>

      {/* === Main grid === */}
      <div className="orc-dash-grid">
        {/* Left column */}
        <div className="orc-dash-left">
          {/* Active Agents */}
          <div className="orc-dash-section" style={{ flex: 3 }}>
            <div className="orc-dash-section-label">Active Agents</div>
            {activeAgents.length === 0 ? (
              <div className="orc-dash-empty">All agents idle</div>
            ) : (
              <div className="orc-dash-table">
                <div className="orc-dash-table-header">
                  <span style={{ width: 80 }}>Role</span>
                  <span style={{ flex: 1 }}>Name</span>
                  <span style={{ flex: 1 }}>Project</span>
                  <span style={{ flex: 1.5 }}>Task</span>
                  <span style={{ width: 52, textAlign: 'right' }}>Time</span>
                  <span style={{ width: 52, textAlign: 'right' }}>Cost</span>
                  <span style={{ width: 20, textAlign: 'center' }}>Ctx</span>
                </div>
                {activeAgents.map(({ inst, proc, folder }) => (
                  <div
                    key={inst.id}
                    className="orc-dash-table-row"
                    onClick={() => handleAgentClick(inst.id)}
                  >
                    <span style={{ width: 80 }}>
                      {inst.agentRole && (
                        <span className={`role-pill role-${inst.agentRole} compact`}>
                          {agentNames[inst.agentRole] || inst.agentRole}
                        </span>
                      )}
                    </span>
                    <span style={{ flex: 1 }} className="orc-dash-cell-ellipsis">
                      {inst.name}
                    </span>
                    <span style={{ flex: 1 }} className="orc-dash-cell-ellipsis">
                      {folder?.emoji || ''}{' '}
                      {folder?.displayName || folder?.name || ''}
                    </span>
                    <span style={{ flex: 1.5 }} className="orc-dash-cell-ellipsis">
                      {inst.activeTaskTitle ||
                        proc?.taskTitle ||
                        '\u2014'}
                    </span>
                    <span
                      style={{
                        width: 52,
                        textAlign: 'right',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                      }}
                    >
                      {inst.taskStartedAt
                        ? fmtDuration(inst.taskStartedAt, now)
                        : '\u2014'}
                    </span>
                    <span
                      style={{
                        width: 52,
                        textAlign: 'right',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                      }}
                    >
                      {proc?.lastCostUsd != null
                        ? fmtUsd(proc.lastCostUsd)
                        : '\u2014'}
                    </span>
                    <span style={{ width: 20, textAlign: 'center' }}>
                      <span
                        className={`orc-dash-ctx-dot ctx-${inst.contextHealth || 'cold'}`}
                        title={inst.contextHealth || 'cold'}
                      />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Project Status Bars */}
          <div className="orc-dash-section" style={{ flex: 2 }}>
            <div className="orc-dash-section-label">Projects</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 12px', padding: '0 4px 6px' }}>
              {PIPELINE_COLUMNS.map(col => (
                <span key={col} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                  <span
                    style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: COLUMN_COLORS[col] }}
                  />
                  {DEFAULT_COLUMN_LABELS[col]}
                </span>
              ))}
            </div>
            {sortedProjects.length === 0 ? (
              <div className="orc-dash-empty">No projects with tasks</div>
            ) : (
              <div className="orc-dash-projects">
                {sortedProjects.map(({ folder, running, cost, cols, total }) => (
                  <div
                    key={folder.id}
                    className="orc-dash-project-row"
                    onClick={() => handleProjectClick(folder.id)}
                  >
                    <span className="orc-dash-proj-name">
                      {folder.orchestratorActive && (
                        <span className="orc-dash-orc-dot" title="Orchestrator active" />
                      )}
                      {folder.emoji || '\u{1F4C1}'}{' '}
                      {folder.displayName || folder.name}
                    </span>
                    <span className="orc-dash-bar-wrap">
                      {PIPELINE_COLUMNS.map(col =>
                        cols[col] > 0 ? (
                          <span
                            key={col}
                            className="orc-dash-bar-seg"
                            style={{
                              flex: cols[col],
                              background: COLUMN_COLORS[col],
                            }}
                            title={`${DEFAULT_COLUMN_LABELS[col]}: ${cols[col]}`}
                          />
                        ) : null
                      )}
                    </span>
                    <span className="orc-dash-proj-meta">
                      {running > 0 && (
                        <span className="orc-dash-proj-running">
                          {running}r
                        </span>
                      )}
                      <span className="orc-dash-proj-count">{total} tasks</span>
                      {cost > 0 && (
                        <span className="orc-dash-proj-cost">{fmtUsd(cost)}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right column */}
        <div className="orc-dash-right">
          {/* Alerts */}
          <div className="orc-dash-section" style={{ flex: 2 }}>
            <div className="orc-dash-section-label">Alerts</div>
            {alerts.length === 0 ? (
              <div className="orc-dash-empty orc-dash-all-clear">All clear</div>
            ) : (
              <div className="orc-dash-alerts">
                {alerts.map(a => (
                  <div
                    key={`${a.task.id}-${a.severity}`}
                    className={`orc-dash-alert orc-dash-alert-${a.severity}`}
                    onClick={() => handleAlertClick(a.task.projectId)}
                  >
                    <span className="orc-dash-alert-icon">{a.icon}</span>
                    <span className="orc-dash-alert-title">
                      {a.task.title.length > 30
                        ? a.task.title.slice(0, 30) + '\u2026'
                        : a.task.title}
                    </span>
                    <span className="orc-dash-alert-detail">{a.detail}</span>
                    {a.folder && (
                      <span className="orc-dash-alert-proj">
                        {a.folder.displayName || a.folder.name}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Activity Log */}
          <div className="orc-dash-section" style={{ flex: 3 }}>
            <div className="orc-dash-section-label">
              Activity
              <span className="orc-dash-log-filters">
                {(['all', 'errors', 'assignments'] as OrcLogFilter[]).map(f => (
                  <button
                    key={f}
                    className={`orc-dash-filter-btn${orcFilter === f ? ' active' : ''}`}
                    onClick={() => setOrcFilter(f)}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </span>
            </div>
            <div
              className="orc-dash-log-list"
              ref={logEndRef}
              onMouseEnter={() => setOrcHovered(true)}
              onMouseLeave={() => setOrcHovered(false)}
            >
              {filteredLogs.length === 0 ? (
                <div className="orc-dash-empty">
                  {orcFilter === 'all' ? 'No activity yet' : `No ${orcFilter} events`}
                </div>
              ) : (
                filteredLogs.map(log => (
                  <div
                    key={log.id}
                    className={`orc-dash-log-entry orc-dash-log-${log.type}`}
                  >
                    <span className="orc-dash-log-time">
                      {fmtTime(log.timestamp)}
                    </span>
                    <span className="orc-dash-log-text" title={log.taskTitle || undefined}>{fmtOrcLog(log)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
