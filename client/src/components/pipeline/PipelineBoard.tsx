import { useState, useCallback, useMemo, useEffect } from 'react'
import type { PipelineTask, PipelineColumn } from '@shared/types'
import { PIPELINE_COLUMNS, DEFAULT_COLUMN_LABELS } from '@shared/constants'
import { usePipeline } from '../../context/PipelineContext'
import { useUI, COLUMN_TO_ROLE } from '../../context/UIContext'
import { useInstances } from '../../context/InstancesContext'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { api } from '../../api'
import { TaskCard } from './TaskCard'
import { TaskDetailPanel } from './TaskDetailPanel'
import { CreateTaskModal } from './CreateTaskModal'

export function PipelineBoard() {
  const { activePipelineId, settings } = useUI()
  const { folders, instances } = useInstances()
  const { dispatch: appDispatch, selectInstance } = useAppDispatch()
  const pipeline = usePipeline()
  const [selectedTask, setSelectedTask] = useState<PipelineTask | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [editingColumn, setEditingColumn] = useState<PipelineColumn | null>(null)
  const [editValue, setEditValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [taskContextMenu, setTaskContextMenu] = useState<{ x: number; y: number; task: PipelineTask } | null>(null)

  const columnLabels = { ...DEFAULT_COLUMN_LABELS, ...(settings.columnLabels || {}) }

  const sortedTasksByColumn = useMemo(() => {
    const result: Record<string, PipelineTask[]> = { ...pipeline.tasksByColumn }
    // Backlog: stuck tasks sort to top (by priority), then normal tasks (by priority)
    const backlog = result['backlog'] || []
    if (backlog.some(t => t.labels.includes('stuck'))) {
      result['backlog'] = [
        ...backlog.filter(t => t.labels.includes('stuck')).sort((a, b) => a.priority - b.priority),
        ...backlog.filter(t => !t.labels.includes('stuck')).sort((a, b) => a.priority - b.priority),
      ]
    }
    return result
  }, [pipeline.tasksByColumn])

  const filteredTasksByColumn = useMemo(() => {
    if (!searchQuery.trim()) return sortedTasksByColumn
    const q = searchQuery.toLowerCase()
    const result: Record<string, PipelineTask[]> = {}
    for (const col of PIPELINE_COLUMNS) {
      result[col] = (sortedTasksByColumn[col] || []).filter(task =>
        task.title.toLowerCase().includes(q) ||
        (task.description || '').toLowerCase().includes(q) ||
        task.labels.some(l => l.toLowerCase().includes(q))
      )
    }
    return result
  }, [sortedTasksByColumn, searchQuery])

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

  const handleTaskContextMenu = useCallback((e: React.MouseEvent, task: PipelineTask) => {
    setTaskContextMenu({ x: e.clientX, y: e.clientY, task })
  }, [])

  const contextMenuInstances = useMemo(() => {
    if (!taskContextMenu) return []
    const role = COLUMN_TO_ROLE[taskContextMenu.task.column]
    if (!role) return []
    return instances.filter(i => i.folderId === projectId && i.agentRole === role)
  }, [taskContextMenu, instances, projectId])

  const handleAssignAgent = useCallback((task: PipelineTask, agentRole: string) => {
    pipeline.moveTask(task.id, task.column, agentRole)
    setTaskContextMenu(null)
  }, [pipeline])

  // Close context menu on mousedown outside
  useEffect(() => {
    if (!taskContextMenu) return
    const handler = () => setTaskContextMenu(null)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [taskContextMenu])

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
        <span className="pipeline-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>Pipeline Board</span>
        <div className="pipeline-search-wrapper">
          <input
            className="pipeline-search-input"
            style={{ fontFamily: 'var(--font-mono)' }}
            type="text"
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setSearchQuery('') }}
          />
          {searchQuery && (
            <button
              className="pipeline-search-clear"
              onClick={() => setSearchQuery('')}
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>
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
          const colTasks = filteredTasksByColumn[col] || []
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
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
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
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: `var(--col-${col})` }}
                  >
                    {columnLabels[col]}
                  </span>
                )}
                <span className="pipeline-column-count" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {searchQuery
                    ? `${colTasks.length}/${(pipeline.tasksByColumn[col] || []).length}`
                    : colTasks.length}
                </span>
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
                    onContextMenu={handleTaskContextMenu}
                  />
                ))}
                {colTasks.length === 0 && (
                  <div style={{
                    textAlign: 'center',
                    padding: '16px 8px',
                    color: 'var(--text-tertiary)',
                    fontSize: 12,
                    fontFamily: 'var(--font-mono)',
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

      {taskContextMenu && (
        <div
          className="context-menu"
          style={{ position: 'fixed', top: taskContextMenu.y, left: taskContextMenu.x, zIndex: 200 }}
          onMouseDown={e => e.stopPropagation()}
        >
          {COLUMN_TO_ROLE[taskContextMenu.task.column] ? (
            <>
              <div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                Assign to {COLUMN_TO_ROLE[taskContextMenu.task.column]}
              </div>
              {contextMenuInstances.length > 0 ? (
                contextMenuInstances.map(inst => (
                  <button
                    key={inst.id}
                    className={`context-menu-item${taskContextMenu.task.assignedAgent === inst.agentRole ? ' active' : ''}`}
                    onClick={() => handleAssignAgent(taskContextMenu.task, inst.agentRole!)}
                  >
                    {inst.name}
                    {inst.specialization && <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 10 }}>{inst.specialization}</span>}
                  </button>
                ))
              ) : (
                <span className="context-menu-item" style={{ opacity: 0.5, cursor: 'default', fontSize: 11 }}>
                  No matching agents
                </span>
              )}
            </>
          ) : (
            <span className="context-menu-item" style={{ opacity: 0.5, cursor: 'default', fontSize: 11 }}>
              No agent role for this column
            </span>
          )}
        </div>
      )}
    </div>
  )
}
