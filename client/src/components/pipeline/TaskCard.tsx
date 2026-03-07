import type { PipelineTask } from '@shared/types'
import { useCallback } from 'react'

interface TaskCardProps {
  task: PipelineTask
  onClick: () => void
}

const PRIORITY_CLASSES: Record<number, string> = {
  1: 'p1',
  2: 'p2',
  3: 'p3',
  4: 'p4',
}

export function TaskCard({ task, onClick }: TaskCardProps) {
  const isStuck = task.labels.includes('stuck')
  const isRunning = task.schedule?.currentlyRunning

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', task.id)
    e.dataTransfer.effectAllowed = 'move'
    ;(e.currentTarget as HTMLElement).classList.add('dragging')
  }, [task.id])

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
