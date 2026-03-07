import { useState, useEffect, useCallback } from 'react'
import type { InstanceConfig, PipelineTask } from '@shared/types'
import { ScheduledPanel } from '../dashboard/ScheduledPanel'
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
  spec: 'SPEC', build: 'BUILD', qa: 'QA', ship: 'SHIP',
}
const COL_COLOR: Record<string, string> = {
  spec: '#3b82f6', build: '#10b981', qa: '#f59e0b', ship: '#ef4444',
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

const ACTIVE_COLS = new Set(['spec', 'build', 'qa', 'ship'])

export function GameDashboard({ instances, tasks, projectId }: Props) {
  const [health, setHealth] = useState<HealthData | null>(null)
  const [killing, setKilling] = useState<Set<string>>(new Set())

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

  const killInstance = useCallback(async (id: string) => {
    setKilling(prev => new Set(prev).add(id))
    try { await api.killInstance(id) } catch { /* ignore */ }
    finally { setKilling(prev => { const s = new Set(prev); s.delete(id); return s }) }
  }, [])

  const idleAgents    = instances.filter(i => i.state !== 'running')
  const activeAgents  = instances.filter(i => i.state === 'running')
  const fightingTasks = tasks.filter(t => ACTIVE_COLS.has(t.column))
  const queuedTasks   = tasks.filter(t => !ACTIVE_COLS.has(t.column) && t.column !== 'done' && t.column !== 'backlog' && t.column !== 'scheduled')

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
    { label: 'INSTANCES', value: health ? `${health.runningInstances}/${health.totalInstances}` : '—' },
    { label: 'MEMORY', value: health ? `${health.memoryMb}MB` : '—' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
      {/* Top: zone columns */}
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

      {/* Bottom: Process Monitor bar */}
      <div style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        padding: '8px 12px',
        fontFamily: 'var(--font-mono)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#10b981', fontSize: 8 }}>■</span>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: 'var(--text-primary)' }}>PROCESS MONITOR</span>
          </div>

          {/* Health stats — single horizontal row */}
          <div style={{ display: 'flex', gap: 6, flex: 1 }}>
            {healthStats.map(s => (
              <div key={s.label} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 7, color: 'var(--text-muted)', letterSpacing: 1.5 }}>{s.label}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: s.color || 'var(--text-primary)' }}>{s.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Instance cards — horizontal scrollable row */}
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
          {sortedInstances.map(inst => {
            const sc = STATE_COLOR[inst.state] ?? '#4a4a60'
            const rc = ROLE_COLOR[inst.agentRole ?? ''] ?? '#6b7280'
            const isKilling = killing.has(inst.id)
            return (
              <div key={inst.id} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 8px', background: 'var(--bg-primary)',
                border: '1px solid var(--border)', borderRadius: 4,
                flexShrink: 0, minWidth: 140, maxWidth: 220,
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: sc, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {inst.name}
                  </div>
                  {inst.agentRole && (
                    <span style={{ fontSize: 7, color: rc, fontWeight: 700, letterSpacing: 1 }}>
                      {inst.agentRole.toUpperCase()}
                    </span>
                  )}
                </div>
                {inst.state === 'running' && (
                  <button
                    onClick={() => killInstance(inst.id)}
                    disabled={isKilling}
                    style={{
                      background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)',
                      borderRadius: 3, color: '#ef4444', padding: '2px 8px',
                      fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    {isKilling ? '...' : 'KILL'}
                  </button>
                )}
                {inst.state === 'paused' && (
                  <button
                    onClick={() => api.resumeInstance(inst.id)}
                    style={{
                      background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)',
                      borderRadius: 3, color: '#10b981', padding: '2px 8px',
                      fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    RESUME
                  </button>
                )}
              </div>
            )
          })}
          {sortedInstances.length === 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: 8 }}>No instances</div>
          )}
        </div>
      </div>
    </div>
  )
}
