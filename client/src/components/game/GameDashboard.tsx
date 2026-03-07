import type { InstanceConfig, PipelineTask } from '@shared/types'
import { ScheduledPanel } from '../dashboard/ScheduledPanel'

interface Props {
  instances: InstanceConfig[]
  tasks: PipelineTask[]
  projectId?: string
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

  return (
    <div className="gdb-root">
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
  )
}
