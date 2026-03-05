import { useState, useMemo } from 'react'
import type { PipelineTask, PipelineColumn } from '@shared/types'
import { PIPELINE_COLUMNS, COLUMN_COLORS } from '@shared/constants'
import { usePipeline } from '../../context/PipelineContext'
import { useApp } from '../../context/AppContext'
import { TaskCard } from './TaskCard'
import { TaskDetailPanel } from './TaskDetailPanel'
import { CreateTaskModal } from './CreateTaskModal'

const COLUMN_LABELS: Record<PipelineColumn, string> = {
  backlog: 'Backlog',
  spec: 'Spec',
  build: 'Build',
  qa: 'QA',
  staging: 'Staging',
  ship: 'Ship',
  done: 'Done',
}

export function PipelineBoard() {
  const { state: appState, dispatch: appDispatch } = useApp()
  const pipeline = usePipeline()
  const [selectedTask, setSelectedTask] = useState<PipelineTask | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const projectId = appState.activePipelineId || appState.folders[0]?.id || ''
  const tasks = pipeline.tasks

  const tasksByColumn = useMemo(() => {
    const map: Record<PipelineColumn, PipelineTask[]> = {
      backlog: [],
      spec: [],
      build: [],
      qa: [],
      staging: [],
      ship: [],
      done: [],
    }
    for (const task of tasks) {
      if (task.projectId === projectId && map[task.column]) {
        map[task.column].push(task)
      }
    }
    // Sort by priority (1=urgent first), then by creation date
    for (const col of PIPELINE_COLUMNS) {
      map[col].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
    }
    return map
  }, [tasks, projectId])

  return (
    <div className="pipeline-board">
      <div className="pipeline-header">
        <span className="pipeline-title">Pipeline Board</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-sm"
            onClick={() => appDispatch({ type: 'SET_VIEW', view: 'chat' })}
          >
            Back to Chat
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => setShowCreate(true)}
          >
            + Add Task
          </button>
        </div>
      </div>

      <div className="pipeline-columns">
        {PIPELINE_COLUMNS.map(col => {
          const colTasks = tasksByColumn[col]
          return (
            <div key={col} className="pipeline-column">
              <div className={`pipeline-column-header ${col}`}>
                <span className="pipeline-column-name">{COLUMN_LABELS[col]}</span>
                <span className="pipeline-column-count">{colTasks.length}</span>
              </div>
              <div className="pipeline-column-tasks">
                {colTasks.map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onClick={() => setSelectedTask(task)}
                  />
                ))}
                {colTasks.length === 0 && (
                  <div style={{
                    textAlign: 'center',
                    padding: '16px 8px',
                    color: 'var(--text-muted)',
                    fontSize: 12,
                  }}>
                    No tasks
                  </div>
                )}
              </div>
              {col === 'backlog' && (
                <button
                  className="pipeline-add-btn"
                  onClick={() => setShowCreate(true)}
                >
                  + Add Task
                </button>
              )}
            </div>
          )
        })}
      </div>

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
        />
      )}

      {showCreate && (
        <CreateTaskModal
          projectId={projectId}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  )
}
