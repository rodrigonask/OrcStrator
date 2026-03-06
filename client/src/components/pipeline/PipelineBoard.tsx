import { useState, useCallback } from 'react'
import type { PipelineTask, PipelineColumn } from '@shared/types'
import { PIPELINE_COLUMNS, DEFAULT_COLUMN_LABELS } from '@shared/constants'
import { usePipeline } from '../../context/PipelineContext'
import { useUI } from '../../context/UIContext'
import { useInstances } from '../../context/InstancesContext'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { api } from '../../api'
import { TaskCard } from './TaskCard'
import { TaskDetailPanel } from './TaskDetailPanel'
import { CreateTaskModal } from './CreateTaskModal'

const COLUMN_TO_ROLE: Partial<Record<PipelineColumn, string>> = {
  spec: 'planner',
  build: 'builder',
  qa: 'tester',
  ship: 'promoter',
}

export function PipelineBoard() {
  const { activePipelineId, settings } = useUI()
  const { folders, instances } = useInstances()
  const { dispatch: appDispatch, selectInstance } = useAppDispatch()
  const pipeline = usePipeline()
  const [selectedTask, setSelectedTask] = useState<PipelineTask | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [editingColumn, setEditingColumn] = useState<PipelineColumn | null>(null)
  const [editValue, setEditValue] = useState('')

  const columnLabels = { ...DEFAULT_COLUMN_LABELS, ...(settings.columnLabels || {}) }

  const projectId = activePipelineId || folders[0]?.id || ''
  const [dragOverColumn, setDragOverColumn] = useState<PipelineColumn | null>(null)

  const handleDragOver = useCallback((e: React.DragEvent, col: PipelineColumn) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverColumn(col)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverColumn(null)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, col: PipelineColumn) => {
    e.preventDefault()
    setDragOverColumn(null)
    const taskId = e.dataTransfer.getData('text/plain')
    if (taskId) {
      pipeline.moveTask(taskId, col)
    }
  }, [pipeline])

  const handleColumnLabelDoubleClick = useCallback((col: PipelineColumn) => {
    setEditingColumn(col)
    setEditValue(columnLabels[col])
  }, [columnLabels])

  const handleColumnLabelSave = useCallback(async (col: PipelineColumn) => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== columnLabels[col]) {
      const newLabels = { ...columnLabels, [col]: trimmed }
      appDispatch({ type: 'UPDATE_SETTINGS', payload: { columnLabels: newLabels } })
      await api.updateSettings({ columnLabels: newLabels })
    }
    setEditingColumn(null)
  }, [editValue, columnLabels, appDispatch])

  const handleColumnLabelKeyDown = useCallback((e: React.KeyboardEvent, col: PipelineColumn) => {
    if (e.key === 'Enter') {
      handleColumnLabelSave(col)
    } else if (e.key === 'Escape') {
      setEditingColumn(null)
    }
  }, [handleColumnLabelSave])

  return (
    <div className="pipeline-board">
      <div className="pipeline-header">
        <span className="pipeline-title">Pipeline Board</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-sm"
            onClick={() => appDispatch({ type: 'SET_VIEW', payload: 'chat' })}
          >
            Back to Chat
          </button>
          <button
            className="btn btn-sm"
            onClick={pipeline.refresh}
            disabled={pipeline.loading}
          >
            {pipeline.loading ? 'Syncing...' : 'Sync'}
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => setShowCreate(true)}
          >
            + Add Task
          </button>
        </div>
      </div>

      <div className="pipeline-content">
      <div className="pipeline-columns">
        {PIPELINE_COLUMNS.map(col => {
          const colTasks = pipeline.tasksByColumn[col]
          const isDragOver = dragOverColumn === col
          return (
            <div
              key={col}
              className={`pipeline-column${isDragOver ? ' drag-over' : ''}`}
              onDragOver={(e) => handleDragOver(e, col)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, col)}
            >
              <div className={`pipeline-column-header ${col}`}>
                {editingColumn === col ? (
                  <input
                    className="pipeline-column-name-input"
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onBlur={() => handleColumnLabelSave(col)}
                    onKeyDown={e => handleColumnLabelKeyDown(e, col)}
                    onFocus={e => e.target.select()}
                    autoFocus
                  />
                ) : (
                  <span
                    className="pipeline-column-name"
                    onDoubleClick={() => handleColumnLabelDoubleClick(col)}
                  >
                    {columnLabels[col]}
                  </span>
                )}
                <span className="pipeline-column-count">{colTasks.length}</span>
                {COLUMN_TO_ROLE[col] && (() => {
                  const role = COLUMN_TO_ROLE[col]!
                  const match = instances.find(
                    i => i.folderId === projectId && i.agentRole === role
                  )
                  return (
                    <button
                      className="pipeline-open-agent-btn"
                      title={match ? `Open ${role} agent` : 'No agent assigned'}
                      disabled={!match}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (match) {
                          selectInstance(match.id)
                          appDispatch({ type: 'SET_VIEW', payload: 'chat' })
                        }
                      }}
                    >
                      👤
                    </button>
                  )
                })()}
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
