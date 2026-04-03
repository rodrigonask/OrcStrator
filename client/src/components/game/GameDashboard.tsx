import { useState, useEffect, useCallback } from 'react'
import type { InstanceConfig, PipelineTask } from '@shared/types'
import { ScheduledPanel } from '../dashboard/ScheduledPanel'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { useInstances } from '../../context/InstancesContext'
import { useUI } from '../../context/UIContext'
import { api } from '../../api'

interface HealthData {
  status: string
  uptime: number
  clients: number
  processes: number
  totalInstances: number
  runningInstances: number
  memoryMb: number
  heapMb: number
}

interface ProcessInfo {
  instanceId: string
  instanceName: string
  agentRole: string | null
  pid: number
  state: string
  runningSec: number
  taskId: string | null
  taskTitle: string | null
  lastCostUsd: number | null
  lastInputTokens: number | null
  lastOutputTokens: number | null
}

interface Props {
  instances: InstanceConfig[]
  tasks: PipelineTask[]
  projectId?: string
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

const PRIORITY_COLOR: Record<number, string> = {
  1: '#cc2222', 2: '#448833', 3: '#88bb22', 4: '#4488cc',
}
const ROLE_ICON: Record<string, string> = {
  planner: 'P', builder: 'B', tester: 'T', promoter: 'S', scheduler: 'C',
}
const ROLE_COLOR: Record<string, string> = {
  planner: '#3b82f6', builder: '#10b981', tester: '#f59e0b', promoter: '#a855f7', scheduler: '#6366f1',
}
const COL_LABEL: Record<string, string> = {
  in_progress: 'IN PROGRESS',
}
const COL_COLOR: Record<string, string> = {
  in_progress: '#3b82f6',
}
const STATE_COLOR: Record<string, string> = {
  running: '#10b981', idle: '#4a4a60', paused: '#f59e0b',
}

function parseTitle(title: string) {
  const actionNeeded = /^\[ACTION NEEDED\]/i.test(title)
  const raw = title.replace(/^\[ACTION NEEDED\]\s*/i, '')
  const m = raw.match(/^(.+?)(?:\s*:\s*|\s+[-–—]\s*)(.+)$/)
  const id   = (actionNeeded ? '⚠ ' : '') + (m ? m[1].trim() : raw.slice(0, 20))
  const desc = m ? m[2].trim() : raw
  return { id, desc }
}

function AgentCard({ agent }: { agent: InstanceConfig }) {
  const role  = agent.agentRole ?? 'default'
  const color = ROLE_COLOR[role] ?? '#6b7280'
  const icon  = ROLE_ICON[role] ?? '?'
  const sc    = STATE_COLOR[agent.state] ?? '#4a4a60'

  return (
    <div className="gdb-card">
      <div className="gdb-agent-left">
        <div className="gdb-role-badge" style={{ background: color + '22', color, borderColor: color + '55' }}>
          {icon}
        </div>
      </div>
      <div className="gdb-agent-body">
        <div className="gdb-agent-name">{agent.name}</div>
        {agent.activeTaskTitle && (
          <div className="gdb-agent-task">{agent.activeTaskTitle.slice(0, 32)}{agent.activeTaskTitle.length > 32 ? '…' : ''}</div>
        )}
      </div>
      <div className="gdb-agent-right">
        {agent.level != null && <span className="gdb-level">Lv{agent.level}</span>}
        <span className="gdb-state-dot" style={{ background: sc }} title={agent.state} />
      </div>
    </div>
  )
}

function TaskCard({ task }: { task: PipelineTask }) {
  const { id, desc } = parseTitle(task.title)
  const pc = PRIORITY_COLOR[task.priority] ?? '#888'
  const cc = COL_COLOR[task.column] ?? '#888'
  const cl = COL_LABEL[task.column] ?? task.column.toUpperCase()

  return (
    <div className="gdb-card">
      <div className="gdb-priority-badge" style={{ background: pc + '22', color: pc, borderColor: pc + '55' }}>
        P{task.priority}
      </div>
      <div className="gdb-task-body">
        <div className="gdb-task-id">{id}</div>
        <div className="gdb-task-desc">{desc.slice(0, 36)}{desc.length > 36 ? '…' : ''}</div>
      </div>
      <div className="gdb-col-badge" style={{ background: cc + '22', color: cc, borderColor: cc + '55' }}>
        {cl}
      </div>
    </div>
  )
}

const ACTIVE_COLS = new Set(['in_progress'])

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}m${s > 0 ? ` ${s}s` : ''}`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function fmtTokens(n: number | null): string {
  if (n == null || n === 0) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function GameDashboard({ instances, tasks, projectId }: Props) {
  const { dispatch } = useAppDispatch()
  const { folders } = useInstances()
  const { activePipelineId } = useUI()
  const [health, setHealth] = useState<HealthData | null>(null)
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [killing, setKilling] = useState<Set<string>>(new Set())
  const [monitorOpen, setMonitorOpen] = useState(false)

  // Health poll (2s)
  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const data = await api.getHealth()
        if (active) setHealth(data)
      } catch { /* ignore */ }
    }
    poll()
    const t = setInterval(poll, 2000)
    return () => { active = false; clearInterval(t) }
  }, [])

  // Process monitor poll (5s)
  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const data = await api.getProcesses()
        if (active) setProcesses(data.processes)
      } catch { /* ignore */ }
    }
    poll()
    const t = setInterval(poll, 5000)
    return () => { active = false; clearInterval(t) }
  }, [])

  const killInstance = useCallback(async (id: string) => {
    setKilling(prev => new Set(prev).add(id))
    try { await api.killInstance(id) } catch { /* ignore */ }
    finally { setKilling(prev => { const s = new Set(prev); s.delete(id); return s }) }
  }, [])

  const idleAgents    = instances.filter(i => i.state !== 'running')
  const activeAgents  = instances.filter(i => i.state === 'running')
  const fightingTasks = tasks.filter(t => t.column === 'in_progress')
  const queuedTasks   = tasks.filter(t => t.column === 'ready')

  const zones = [
    { key: 'idle',     label: 'IDLE',     count: idleAgents.length,    accent: '#3b82f6' },
    { key: 'active',   label: 'ACTIVE',   count: activeAgents.length,  accent: '#10b981' },
    { key: 'fighting', label: 'FIGHTING', count: fightingTasks.length, accent: '#f59e0b' },
    { key: 'queued',   label: 'QUEUED',   count: queuedTasks.length,   accent: '#a855f7' },
  ]

  const sortedInstances = [...instances].sort((a, b) => {
    const order: Record<string, number> = { running: 0, paused: 1, idle: 2 }
    return (order[a.state] ?? 3) - (order[b.state] ?? 3)
  })

  const healthStats = [
    { label: 'UPTIME', value: health ? fmtUptime(health.uptime) : '—' },
    { label: 'RUNNING', value: health ? String(health.processes) : '—', color: health && health.processes > 0 ? '#10b981' : undefined },
    { label: 'CHATS', value: health ? `${health.runningInstances}/${health.totalInstances}` : '—' },
    { label: 'MEMORY', value: health ? `${health.memoryMb}MB` : '—' },
  ]

  // Compute total session cost from running processes
  const totalSessionCost = processes.reduce((s, p) => s + (p.lastCostUsd ?? 0), 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
      {/* Quick-nav cards */}
      <div className="gdb-quicknav">
        <button
          className="gdb-quicknav-card"
          onClick={() => {
            const pipelineId = activePipelineId || folders[0]?.id || null
            if (pipelineId) dispatch({ type: 'SET_PIPELINE_PROJECT', projectId: pipelineId })
            dispatch({ type: 'SELECT_INSTANCE', payload: null })
            dispatch({ type: 'SET_VIEW', payload: 'pipeline' })
          }}
        >
          <span className="gdb-quicknav-icon">▤</span>
          <span className="gdb-quicknav-label">Pipeline Project</span>
        </button>
        <button
          className="gdb-quicknav-card"
          onClick={() => {
            dispatch({ type: 'SELECT_INSTANCE', payload: null })
            dispatch({ type: 'SET_VIEW', payload: 'usage' })
          }}
        >
          <span className="gdb-quicknav-icon">$</span>
          <span className="gdb-quicknav-label">Usage Report</span>
        </button>
        <button
          className="gdb-quicknav-card"
          onClick={() => dispatch({ type: 'OPEN_SETTINGS' })}
        >
          <span className="gdb-quicknav-icon">⚙</span>
          <span className="gdb-quicknav-label">Settings</span>
        </button>
      </div>

      {/* Zone columns */}
      <div className="gdb-root" style={{ flex: 1, minHeight: 0 }}>
        {zones.map(z => (
          <div key={z.key} className="gdb-col">
            <div className="gdb-col-header" style={{ borderBottomColor: z.accent + '44' }}>
              <span className="gdb-col-title" style={{ color: z.accent }}>{z.label}</span>
              {z.count > 0 && (
                <span className="gdb-col-count" style={{ background: z.accent + '22', color: z.accent, borderColor: z.accent + '44' }}>
                  {z.count}
                </span>
              )}
            </div>
            <div className="gdb-col-body">
              {z.key === 'idle'     && (idleAgents.length    > 0 ? idleAgents.map(a    => <AgentCard key={a.id} agent={a} />)    : <div className="gdb-empty">No idle agents</div>)}
              {z.key === 'active'   && (activeAgents.length  > 0 ? activeAgents.map(a  => <AgentCard key={a.id} agent={a} />)    : <div className="gdb-empty">No active agents</div>)}
              {z.key === 'fighting' && (fightingTasks.length > 0 ? fightingTasks.map(t => <TaskCard  key={t.id} task={t} />)    : <div className="gdb-empty">No tasks in progress</div>)}
              {z.key === 'queued'   && (queuedTasks.length   > 0 ? queuedTasks.map(t   => <TaskCard  key={t.id} task={t} />)    : <div className="gdb-empty">Queue is empty</div>)}
            </div>
          </div>
        ))}
        {projectId && (
          <div className="gdb-col" style={{ minWidth: 200, maxWidth: 260 }}>
            <div className="gdb-col-header" style={{ borderBottomColor: '#6366f144' }}>
              <span className="gdb-col-title" style={{ color: '#6366f1' }}>SCHEDULED</span>
            </div>
            <div className="gdb-col-body">
              <ScheduledPanel projectId={projectId} />
            </div>
          </div>
        )}
      </div>

      {/* Collapsible Process Monitor */}
      <div style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        fontFamily: 'var(--font-mono)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        ...(monitorOpen ? { flex: 1, minHeight: 0 } : {}),
      }}>
        {/* Monitor header (clickable to toggle) */}
        <div
          className="gdb-monitor-header"
          onClick={() => setMonitorOpen(o => !o)}
          style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', flexShrink: 0, cursor: 'pointer' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: processes.length > 0 ? '#10b981' : '#4a4a60', fontSize: 8 }}>
              {monitorOpen ? '▼' : '▶'}
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: 'var(--text-primary)' }}>PROCESS MONITOR</span>
            {processes.length > 0 && (
              <span style={{ fontSize: 9, color: '#10b981', fontWeight: 600 }}>({processes.length} live)</span>
            )}
          </div>

          {/* Health stats */}
          <div style={{ display: 'flex', gap: 6, flex: 1 }}>
            {healthStats.map(s => (
              <div key={s.label} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 7, color: 'var(--text-muted)', letterSpacing: 1.5 }}>{s.label}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: s.color || 'var(--text-primary)' }}>{s.value}</span>
              </div>
            ))}
            {totalSessionCost > 0 && (
              <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 7, color: 'var(--text-muted)', letterSpacing: 1.5 }}>SESSION $</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b' }}>${totalSessionCost.toFixed(4)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Process table (collapsible) */}
        {monitorOpen && <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 8px' }}>
          {/* Table header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '6px 1fr 70px 60px 70px 80px 70px 60px',
            gap: 8,
            padding: '4px 8px',
            fontSize: 7,
            color: 'var(--text-muted)',
            letterSpacing: 1.5,
            fontWeight: 700,
            borderBottom: '1px solid var(--border)',
            marginBottom: 4,
            position: 'sticky',
            top: 0,
            background: 'var(--bg-secondary)',
          }}>
            <span />
            <span>INSTANCE / TASK</span>
            <span>ROLE</span>
            <span>PID</span>
            <span>DURATION</span>
            <span>TOKENS</span>
            <span>COST</span>
            <span />
          </div>

          {/* Live processes */}
          {processes.map(proc => {
            const rc = ROLE_COLOR[proc.agentRole ?? ''] ?? '#6b7280'
            const isKilling = killing.has(proc.instanceId)
            const durationColor = proc.runningSec > 600 ? '#ef4444' : proc.runningSec > 300 ? '#f59e0b' : '#10b981'
            return (
              <div key={proc.instanceId} style={{
                display: 'grid',
                gridTemplateColumns: '6px 1fr 70px 60px 70px 80px 70px 60px',
                gap: 8,
                padding: '6px 8px',
                background: 'var(--bg-primary)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                marginBottom: 3,
                alignItems: 'center',
              }}>
                {/* State dot */}
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: proc.state === 'killing' ? '#ef4444' : '#10b981',
                  animation: proc.state === 'running' ? 'pulse-dot 2s infinite' : undefined,
                }} />

                {/* Instance name + task */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                    {proc.instanceName}
                  </div>
                  {proc.taskTitle && (
                    <div style={{ fontSize: 8, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {proc.taskTitle.slice(0, 50)}
                    </div>
                  )}
                </div>

                {/* Role badge */}
                <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1, color: rc }}>
                  {(proc.agentRole ?? '—').toUpperCase()}
                </span>

                {/* PID */}
                <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {proc.pid}
                </span>

                {/* Duration */}
                <span style={{ fontSize: 9, fontWeight: 600, color: durationColor }}>
                  {fmtDuration(proc.runningSec)}
                </span>

                {/* Tokens (in/out) */}
                <div style={{ fontSize: 8, color: 'var(--text-muted)' }}>
                  <span style={{ color: '#3b82f6' }}>{fmtTokens(proc.lastInputTokens)}</span>
                  <span style={{ margin: '0 2px' }}>/</span>
                  <span style={{ color: '#a855f7' }}>{fmtTokens(proc.lastOutputTokens)}</span>
                </div>

                {/* Cost */}
                <span style={{ fontSize: 9, fontWeight: 600, color: proc.lastCostUsd && proc.lastCostUsd > 0 ? '#f59e0b' : 'var(--text-muted)' }}>
                  {proc.lastCostUsd != null && proc.lastCostUsd > 0 ? `$${proc.lastCostUsd.toFixed(4)}` : '—'}
                </span>

                {/* Kill button */}
                <button
                  onClick={() => killInstance(proc.instanceId)}
                  disabled={isKilling}
                  style={{
                    background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)',
                    borderRadius: 3, color: '#ef4444', padding: '2px 8px',
                    fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  {isKilling ? '...' : 'KILL'}
                </button>
              </div>
            )
          })}

          {/* Idle instances (collapsed view) */}
          {sortedInstances.filter(i => i.state !== 'running').length > 0 && (
            <>
              <div style={{ fontSize: 7, color: 'var(--text-muted)', letterSpacing: 1.5, fontWeight: 700, padding: '8px 8px 4px', borderTop: '1px solid var(--border)', marginTop: 4 }}>
                IDLE / PAUSED
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 8px' }}>
                {sortedInstances.filter(i => i.state !== 'running').map(inst => {
                  const sc = STATE_COLOR[inst.state] ?? '#4a4a60'
                  const rc = ROLE_COLOR[inst.agentRole ?? ''] ?? '#6b7280'
                  return (
                    <div key={inst.id} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '3px 8px', background: 'var(--bg-primary)',
                      border: '1px solid var(--border)', borderRadius: 4,
                    }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: sc }} />
                      <span style={{ fontSize: 9, color: 'var(--text-primary)' }}>{inst.name}</span>
                      {inst.agentRole && (
                        <span style={{ fontSize: 7, color: rc, fontWeight: 700, letterSpacing: 1 }}>
                          {inst.agentRole.toUpperCase()}
                        </span>
                      )}
                      {inst.state === 'paused' && (
                        <button
                          onClick={() => api.resumeInstance(inst.id)}
                          style={{
                            background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)',
                            borderRadius: 3, color: '#10b981', padding: '1px 6px',
                            fontFamily: 'var(--font-mono)', fontSize: 7, fontWeight: 700, cursor: 'pointer',
                          }}
                        >
                          RESUME
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {processes.length === 0 && sortedInstances.length === 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '20px 8px', textAlign: 'center' }}>
              No processes running
            </div>
          )}
        </div>}
      </div>
    </div>
  )
}
