import type { PipelineTask } from '@shared/types'
import { useCallback, useState } from 'react'
import { usePipeline } from '../../context/PipelineContext'
import { useInstances } from '../../context/InstancesContext'
import { useOpenInstance } from '../../hooks/useOpenInstance'
import { schedulePill } from '../../utils/taskSchedule'
import { useConfirm } from '../ConfirmModal'

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
  // The server coerces labels on read; this is the second line, so one bad row can never
  // take the board down with it.
  const labels = Array.isArray(task.labels) ? task.labels.filter(l => typeof l === 'string') : []
  const isStuck = labels.includes('stuck')
  const { startTask } = usePipeline()
  const { alert } = useConfirm()
  const { instances } = useInstances()
  const openInstance = useOpenInstance()
  const [starting, setStarting] = useState(false)

  // instanceId, not targetInstanceId: this is the chat that is working or last worked the
  // card, which is what the arrow opens. targetInstanceId is where the NEXT scheduled fire
  // is aimed, and opening that one would show a chat this card has not run in yet.
  const linkedInstance = task.instanceId ? instances.find(i => i.id === task.instanceId) : undefined
  const isWorking = linkedInstance?.state === 'running'
  const pill = schedulePill(task)

  const handleQuickStart = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (starting) return
    // Already linked to a live instance: the arrow becomes an OPEN affordance, and
    // opening is the one case that is allowed to navigate, into Grid.
    if (linkedInstance) {
      openInstance(linkedInstance)
      return
    }
    setStarting(true)
    try {
      // Deliberately no navigation. Starting a task from the board keeps you on the
      // board: the card's dot turns green and the work runs in the background. Being
      // thrown into a chat on every play press was the behaviour this removes.
      await startTask(task.id, undefined, task.projectId)
    } catch (err) {
      console.error('Quick start failed:', err)
      // Say why (the agent limit, a chat already working), as the card menu does. A spinner that
      // just stops read as the button doing nothing.
      const reason = err instanceof Error ? err.message : ''
      // Stopped by the user before it began: their Stop already said so, no second message.
      if (!/^Stopped before the chat started/.test(reason)) {
        await alert(reason || 'Something went wrong starting this task. Try again, or open the chat from the card menu.', 'Could not start')
      }
    } finally {
      setStarting(false)
    }
  }, [starting, linkedInstance, openInstance, startTask, alert, task.id, task.projectId])

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
        <div className="task-card-title" title={task.title}>{task.title}</div>
        <button
          className="task-start-btn"
          onClick={handleQuickStart}
          disabled={starting}
          title={linkedInstance ? `Open ${linkedInstance.name} in Grid` : 'Start this task. You stay on the board.'}
          style={{
            marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer',
            fontSize: 11, color: isWorking ? '#22c55e' : 'var(--text-muted)', padding: '0 2px',
          }}
        >
          {starting ? '…' : isWorking ? '●' : linkedInstance ? '↗' : '▶'}
        </button>
      </div>
      <div className="task-card-footer">
        <div className="task-labels">
          {isStuck ? (
            <span className="task-stuck-badge">STUCK</span>
          ) : (
            labels.slice(0, 3).map(label => (
              <span key={label} className="task-label">{label}</span>
            ))
          )}
          {!isStuck && labels.length > 3 && (
            <span className="task-label">+{labels.length - 3}</span>
          )}
          {/* When this card next runs, or why it will not. Drawn by the card itself now:
              a schedule used to need a whole separate RoutineCard because a routine had no
              column to sit in, and it has one. */}
          {pill && (
            <span className={`task-schedule-badge task-schedule-badge--${pill.tone}`} title={pill.title}>
              {pill.label}
            </span>
          )}
          {task.silent && (
            <span className="task-schedule-badge task-schedule-badge--silent" title="Runs without pulling its chat into the grid.">
              Silent
            </span>
          )}
        </div>
        {task.totalCostUsd != null && task.totalCostUsd > 0 && (
          <span className="task-cost-badge" style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>
            ${task.totalCostUsd < 0.01 ? task.totalCostUsd.toFixed(4) : task.totalCostUsd.toFixed(2)}
          </span>
        )}
      </div>
    </div>
  )
}
