import type { PipelineTask } from '@shared/types'
import { useCallback } from 'react'

interface TaskCardProps {
  task: PipelineTask
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent, task: PipelineTask) => void
}

const PRIORITY_CLASSES: Record<number, string> = {
  1: 'p1',
  2: 'p2',
  3: 'p3',
  4: 'p4',
}

export function TaskCard({ task, onClick, onContextMenu }: TaskCardProps) {
  const isStuck = task.labels.includes('stuck')
  const isRunning = task.schedule?.currentlyRunning

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', task.id)
    e.dataTransfer.setData('application/json', JSON.stringify({ taskId: task.id, column: task.column }))
    e.dataTransfer.setData(`application/x-task-column-${task.column}`, task.id)
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
      style={{ '--card-glow': `var(--col-${task.column})` } as React.CSSProperties}
    >
      <div className="task-card-header">
        <div className={`task-priority-dot ${PRIORITY_CLASSES[task.priority] || 'p4'}`} />
        <div className="task-card-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{task.title}</div>
      </div>
      <div className="task-card-footer">
        <div className="task-labels">
          {isStuck ? (
            <span className="task-stuck-badge">STUCK</span>
          ) : (
            task.labels.slice(0, 3).map(label => (
              <span key={label} className="task-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{label}</span>
            ))
          )}
          {!isStuck && task.labels.length > 3 && (
            <span className="task-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>+{task.labels.length - 3}</span>
          )}
          {task.skill && (
            <span className="task-skill-badge">{task.skill}</span>
          )}
        </div>
        {task.totalCostUsd != null && task.totalCostUsd > 0 && (
          <span className="task-cost-badge" style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>
            ${task.totalCostUsd < 0.01 ? task.totalCostUsd.toFixed(4) : task.totalCostUsd.toFixed(2)}
          </span>
        )}
        {isRunning ? (
          <span className="task-agent-badge" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--col-build)' }}>running</span>
        ) : !isStuck && task.assignedAgent ? (
          <span className="task-agent-badge" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: `var(--role-${task.assignedAgent})` }}>{task.assignedAgent}</span>
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
