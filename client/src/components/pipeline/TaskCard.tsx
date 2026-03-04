import type { PipelineTask } from '@shared/types'

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
  return (
    <div className="task-card" onClick={onClick}>
      <div className="task-card-header">
        <div className={`task-priority-dot ${PRIORITY_CLASSES[task.priority] || 'p4'}`} />
        <div className="task-card-title">{task.title}</div>
      </div>
      <div className="task-card-footer">
        <div className="task-labels">
          {task.labels.slice(0, 3).map(label => (
            <span key={label} className="task-label">{label}</span>
          ))}
          {task.labels.length > 3 && (
            <span className="task-label">+{task.labels.length - 3}</span>
          )}
        </div>
        {task.assignedAgent && (
          <span className="task-agent-badge">{task.assignedAgent}</span>
        )}
      </div>
      {task.groupId && task.groupIndex !== undefined && task.groupTotal !== undefined && (
        <div style={{
          fontSize: 10,
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
