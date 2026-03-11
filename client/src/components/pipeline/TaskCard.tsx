import type { PipelineTask } from '@shared/types'
import { useCallback } from 'react'
import { useInstances } from '../../context/InstancesContext'
import { useAgentNames } from '../../hooks/useAgentNames'

interface TaskCardProps {
  task: PipelineTask
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent, task: PipelineTask) => void
  /** Optional project color for cross-project kanban view */
  projectColor?: string
}

const PRIORITY_CLASSES: Record<number, string> = {
  1: 'p1',
  2: 'p2',
  3: 'p3',
  4: 'p4',
}

export function TaskCard({ task, onClick, onContextMenu, projectColor }: TaskCardProps) {
  const { instances } = useInstances()
  const agentNames = useAgentNames()
  const roleName = (role: string) => agentNames[role] || role
  const isStuck = task.labels.includes('stuck')
  const isRunning = task.schedule?.currentlyRunning
  const hasMultipleSteps = (task.totalSteps || 1) > 1
  // Red badge: task in in_progress where current step needs a role but no instance exists for it
  const missingRoleAgent = task.column === 'in_progress' && task.currentStepRole
    && !instances.some(i => i.folderId === task.projectId && i.agentRole === task.currentStepRole)

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', task.id)
    e.dataTransfer.setData('application/json', JSON.stringify({ taskId: task.id, column: task.column }))
    e.dataTransfer.setData(`application/x-task-column-${task.column}`, task.id)
    if (task.currentStepRole) {
      e.dataTransfer.setData(`application/x-task-role-${task.currentStepRole}`, task.id)
    }
    e.dataTransfer.effectAllowed = 'move'
    ;(e.currentTarget as HTMLElement).classList.add('dragging')
  }, [task.id, task.column])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    ;(e.currentTarget as HTMLElement).classList.remove('dragging')
  }, [])

  return (
    <div
      className={`task-card${isStuck ? ' stuck' : ''}`}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={onClick}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, task) } : undefined}
      style={{
        '--card-glow': `var(--col-${task.column})`,
        ...(projectColor ? {
          borderLeft: `3px solid color-mix(in srgb, ${projectColor} 50%, transparent)`,
          background: `color-mix(in srgb, ${projectColor} 6%, var(--bg-secondary))`,
        } : {}),
      } as React.CSSProperties}
    >
      <div className="task-card-header">
        <div className={`task-priority-dot ${PRIORITY_CLASSES[task.priority] || 'p4'}`} />
        <div className="task-card-title">{task.title}</div>
      </div>
      <div className="task-card-footer">
        <div className="task-labels">
          {isStuck ? (
            <span className="task-stuck-badge">STUCK</span>
          ) : (
            task.labels.slice(0, 3).map(label => (
              <span key={label} className="task-label">{label}</span>
            ))
          )}
          {!isStuck && task.labels.length > 3 && (
            <span className="task-label">+{task.labels.length - 3}</span>
          )}
          {task.skill && (
            <span className="task-skill-badge">{task.skill}</span>
          )}
          {hasMultipleSteps && (
            <span className="task-step-badge" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--bg-tertiary)', padding: '1px 5px', borderRadius: 3 }}>
              {task.currentStep}/{task.totalSteps}
            </span>
          )}
          {missingRoleAgent && (
            <span
              className="task-missing-role-badge"
              title={`No ${roleName(task.currentStepRole!)} agent in this project`}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#ef4444', fontWeight: 600 }}
            >
              !{roleName(task.currentStepRole!)}
            </span>
          )}
        </div>
        {task.totalCostUsd != null && task.totalCostUsd > 0 && (
          <span className="task-cost-badge" style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>
            ${task.totalCostUsd < 0.01 ? task.totalCostUsd.toFixed(4) : task.totalCostUsd.toFixed(2)}
          </span>
        )}
        {isRunning ? (
          <span className="task-agent-badge" style={{ color: 'var(--col-in_progress)' }}>running</span>
        ) : !isStuck && !missingRoleAgent && task.currentStepRole ? (
          <span className="task-agent-badge" style={{ color: task.lockedBy ? `var(--role-${task.currentStepRole})` : 'var(--text-muted)' }}>{roleName(task.currentStepRole)}</span>
        ) : !isStuck && task.assignedAgent && task.assignedAgent !== task.currentStepRole ? (
          <span className="task-agent-badge" style={{ color: task.lockedBy ? `var(--role-${task.assignedAgent})` : 'var(--text-muted)' }}>{roleName(task.assignedAgent)}</span>
        ) : null}
      </div>
      {task.groupId && task.groupIndex !== undefined && task.groupTotal !== undefined && (
        <div style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          marginTop: 4,
          fontFamily: 'var(--font-mono)',
        }}>
          {task.groupIndex}/{task.groupTotal}
        </div>
      )}
    </div>
  )
}
