import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import type { PipelineTask, PipelineColumn, PipelineBlueprint } from '@shared/types'
import { PIPELINE_COLUMNS, DEFAULT_COLUMN_LABELS } from '@shared/constants'
import { usePipeline } from '../../context/PipelineContext'
import { useUI } from '../../context/UIContext'
import { useInstances } from '../../context/InstancesContext'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { useAgentNames } from '../../hooks/useAgentNames'
import { api } from '../../api'
import { TaskCard } from './TaskCard'
import { TaskDetailPanel } from './TaskDetailPanel'
import { CreateTaskModal } from './CreateTaskModal'
import { BlueprintEditorModal } from './BlueprintEditorModal'
import { useConfirm } from '../ConfirmModal'

export function PipelineBoard() {
  const { activePipelineId, settings } = useUI()
  const { folders, instances } = useInstances()
  const { dispatch: appDispatch, selectInstance } = useAppDispatch()
  const pipeline = usePipeline()
  const { confirm } = useConfirm()
  const [selectedTask, setSelectedTask] = useState<PipelineTask | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showBlueprintEditor, setShowBlueprintEditor] = useState(false)
  const [editingColumn, setEditingColumn] = useState<PipelineColumn | null>(null)
  const [editValue, setEditValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [taskFilter, setTaskFilter] = useState<'all' | 'tasks' | 'scheduled'>('all')
  const [taskContextMenu, setTaskContextMenu] = useState<{ x: number; y: number; task: PipelineTask } | null>(null)
  const [blueprints, setBlueprints] = useState<PipelineBlueprint[]>([])
  const [subMenu, setSubMenu] = useState<'pipeline' | 'priority' | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  // Clamp context menu to viewport bounds after it renders
  useEffect(() => {
    if (!taskContextMenu || !contextMenuRef.current) return
    const el = contextMenuRef.current
    const rect = el.getBoundingClientRect()
    const maxX = window.innerWidth - 8
    const maxY = window.innerHeight - 8
    let x = taskContextMenu.x
    let y = taskContextMenu.y
    if (x + rect.width > maxX) x = maxX - rect.width
    if (y + rect.height > maxY) y = maxY - rect.height
    if (x < 8) x = 8
    if (y < 8) y = 8
    if (x !== taskContextMenu.x || y !== taskContextMenu.y) {
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }, [taskContextMenu])

  const columnLabels = { ...DEFAULT_COLUMN_LABELS, ...(settings.columnLabels || {}) }
  const agentNames = useAgentNames()
  const roleName = (role: string) => agentNames[role] || role

  // Separate scheduled tasks from column-grouped tasks
  const scheduledTasks = useMemo(() => {
    return pipeline.tasksByColumn['scheduled' as PipelineColumn] || []
  }, [pipeline.tasksByColumn])

  const sortedTasksByColumn = useMemo(() => {
    const result: Record<string, PipelineTask[]> = { ...pipeline.tasksByColumn }
    // In Review: stuck tasks sort to top (by priority), then normal tasks (by priority)
    const inReview = result['in_review'] || []
    if (inReview.some(t => t.labels.includes('stuck'))) {
      result['in_review'] = [
        ...inReview.filter(t => t.labels.includes('stuck')).sort((a, b) => a.priority - b.priority),
        ...inReview.filter(t => !t.labels.includes('stuck')).sort((a, b) => a.priority - b.priority),
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

  const filteredScheduledTasks = useMemo(() => {
    if (!searchQuery.trim()) return scheduledTasks
    const q = searchQuery.toLowerCase()
    return scheduledTasks.filter(task =>
      task.title.toLowerCase().includes(q) ||
      (task.description || '').toLowerCase().includes(q) ||
      task.labels.some(l => l.toLowerCase().includes(q))
    )
  }, [scheduledTasks, searchQuery])

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
    const role = taskContextMenu.task.currentStepRole
    if (!role) return []
    return instances.filter(i => i.folderId === projectId && i.agentRole === role)
  }, [taskContextMenu, instances, projectId])

  const handleAssignAgent = useCallback((task: PipelineTask, agentRole: string) => {
    pipeline.moveTask(task.id, task.column, agentRole)
    setTaskContextMenu(null)
  }, [pipeline])

  const handleCreateAndAssign = useCallback(async (task: PipelineTask) => {
    if (!task.currentStepRole) return
    try {
      await api.createInstance({ folderId: projectId, agentRole: task.currentStepRole, name: task.currentStepRole + ' Agent' })
      pipeline.moveTask(task.id, task.column, task.currentStepRole)
    } catch (err) {
      console.error('Failed to create and assign agent:', err)
    }
    setTaskContextMenu(null)
  }, [projectId, pipeline])

  const handleDeleteTask = useCallback(async (task: PipelineTask) => {
    const ok = await confirm(`Delete task "${task.title}"?`)
    if (!ok) return
    try {
      await api.deleteTask(projectId, task.id)
    } catch (err) {
      console.error('Failed to delete task:', err)
    }
    setTaskContextMenu(null)
  }, [projectId, confirm])

  // Fetch blueprints once on mount
  useEffect(() => {
    api.getBlueprints().then(setBlueprints).catch(console.error)
  }, [])

  const handleToggleLabel = useCallback((task: PipelineTask, label: string) => {
    const has = task.labels.includes(label)
    const newLabels = has ? task.labels.filter(l => l !== label) : [...task.labels, label]
    pipeline.updateTask(task.id, { labels: newLabels })
    setTaskContextMenu(null)
  }, [pipeline])

  const handleResetPipeline = useCallback(async (task: PipelineTask, blueprintId?: string) => {
    try {
      await api.resetTaskPipeline(projectId, task.id, blueprintId)
    } catch (err) {
      console.error('Failed to reset pipeline:', err)
    }
    setTaskContextMenu(null)
  }, [projectId])

  const handleSetPriority = useCallback((task: PipelineTask, p: number) => {
    pipeline.updateTask(task.id, { priority: p })
    setTaskContextMenu(null)
  }, [pipeline])

  // Close context menu on mousedown outside
  useEffect(() => {
    if (!taskContextMenu) return
    const handler = () => { setTaskContextMenu(null); setSubMenu(null) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [taskContextMenu])

  const handleColumnLabelDoubleClick = useCallback((col: PipelineColumn) => {
    setEditingColumn(col)
    setEditValue(columnLabels[col] || col)
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
        <span className="pipeline-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>Pipeline Project</span>
        {(() => {
          const f = folders.find(f => f.id === projectId)
          return f?.cloudSync ? (
            <span title={f.lastSyncedAt ? `Last synced: ${new Date(f.lastSyncedAt).toLocaleTimeString()}` : 'Synced to Cloud'} style={{ fontSize: 12, color: 'var(--accent)', marginLeft: 4 }}>{'\u2601'}</span>
          ) : null
        })()}
        {folders.length > 1 ? (
          <select
            className="pipeline-project-select"
            value={activePipelineId || folders[0]?.id || ''}
            onChange={e => appDispatch({ type: 'SET_PIPELINE_PROJECT', projectId: e.target.value })}
          >
            {folders.map(f => (
              <option key={f.id} value={f.id}>
                {f.emoji ? `${f.emoji} ` : ''}{f.displayName || f.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="pipeline-project-label font-mono">
            {(() => { const f = folders.find(f => f.id === projectId); return f ? (f.displayName || f.name) : '' })()}
          </span>
        )}
        <div style={{ display: 'flex', background: 'var(--surface-elevated)', borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden', flexShrink: 0 }}>
          {(['all', 'tasks', 'scheduled'] as const).map((f, i, arr) => (
            <button
              key={f}
              onClick={() => setTaskFilter(f)}
              style={{
                padding: '3px 10px',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                background: taskFilter === f ? 'var(--accent)' : 'transparent',
                color: taskFilter === f ? '#fff' : 'var(--text-secondary)',
                border: 'none',
                borderRight: i < arr.length - 1 ? '1px solid var(--border)' : undefined,
                cursor: 'pointer',
                transition: 'background 0.1s',
              }}
            >
              {f === 'all' ? 'All' : f === 'tasks' ? 'Tasks' : 'Scheduled'}
              {f === 'scheduled' && scheduledTasks.length > 0 && (
                <span style={{ marginLeft: 4, opacity: 0.7 }}>({scheduledTasks.length})</span>
              )}
            </button>
          ))}
        </div>
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
            style={{ opacity: 0.7 }}
            onClick={() => setShowBlueprintEditor(true)}
            title="Manage Pipelines"
          >
            Pipelines
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
      {taskFilter !== 'scheduled' && <div className="pipeline-columns">
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
                    {columnLabels[col] || col}
                  </span>
                )}
                <span className="pipeline-column-count" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {searchQuery
                    ? `${colTasks.length}/${(pipeline.tasksByColumn[col] || []).length}`
                    : colTasks.length}
                </span>
              </div>
              <div className="pipeline-column-tasks">
                {colTasks.map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    column={col}
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
      </div>}

      {/* Scheduled section */}
      {taskFilter !== 'tasks' && filteredScheduledTasks.length > 0 && (
        <div style={{ marginTop: taskFilter === 'all' ? 12 : 0, padding: '0 8px' }}>
          {taskFilter === 'all' && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
              Scheduled
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {filteredScheduledTasks.map(task => (
              <TaskCard
                key={task.id}
                task={task}
                onClick={() => setSelectedTask(task)}
                onContextMenu={handleTaskContextMenu}
              />
            ))}
          </div>
        </div>
      )}
      {taskFilter === 'scheduled' && filteredScheduledTasks.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-tertiary)', fontSize: 13, fontFamily: 'var(--font-mono)' }}>
          No scheduled tasks
        </div>
      )}
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

      {showBlueprintEditor && (
        <BlueprintEditorModal
          onClose={() => setShowBlueprintEditor(false)}
        />
      )}

      {taskContextMenu && (() => {
        const t = taskContextMenu.task
        const isStuck = t.labels.includes('stuck')
        const isPaused = t.labels.includes('paused')
        return (
          <div
            ref={contextMenuRef}
            className="context-menu"
            style={{ position: 'fixed', top: taskContextMenu.y, left: taskContextMenu.x, zIndex: 200 }}
            onMouseDown={e => e.stopPropagation()}
          >
            {/* Assign section */}
            {t.currentStepRole ? (
              <>
                <div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  Assign to {roleName(t.currentStepRole!)}
                </div>
                {contextMenuInstances.length > 0 ? (
                  contextMenuInstances.map(inst => (
                    <button
                      key={inst.id}
                      className={`context-menu-item${t.assignedAgent === inst.agentRole ? ' active' : ''}`}
                      onClick={() => handleAssignAgent(t, inst.agentRole!)}
                    >
                      {inst.name}
                      {inst.specialization && <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 10 }}>{inst.specialization}</span>}
                    </button>
                  ))
                ) : (
                  <>
                    <span className="context-menu-item" style={{ opacity: 0.5, cursor: 'default', fontSize: 11 }}>
                      No matching agents
                    </span>
                    <button
                      className="context-menu-item"
                      onClick={() => handleCreateAndAssign(t)}
                    >
                      + Create {roleName(t.currentStepRole!)} agent
                    </button>
                  </>
                )}
              </>
            ) : (
              <span className="context-menu-item" style={{ opacity: 0.5, cursor: 'default', fontSize: 11 }}>
                No agent role for this step
              </span>
            )}

            <div className="context-menu-separator" />

            {/* Stuck toggle */}
            <button className="context-menu-item" onClick={() => handleToggleLabel(t, 'stuck')}>
              {isStuck ? 'Unstuck' : 'Mark Stuck'}
            </button>

            {/* Pause toggle */}
            <button className="context-menu-item" onClick={() => handleToggleLabel(t, 'paused')}>
              {isPaused ? 'Unpause' : 'Pause'}
            </button>

            {/* Pipeline submenu */}
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setSubMenu('pipeline')}
              onMouseLeave={() => setSubMenu(s => s === 'pipeline' ? null : s)}
            >
              <button className="context-menu-item">
                Pipeline <span className="submenu-arrow">&#9656;</span>
              </button>
              {subMenu === 'pipeline' && (
                <div className="context-menu context-menu-sub" onMouseDown={e => e.stopPropagation()}>
                  <button className="context-menu-item" onClick={() => handleResetPipeline(t)}>
                    Restart current
                  </button>
                  {blueprints.length > 0 && <div className="context-menu-separator" />}
                  {blueprints.map(bp => (
                    <button key={bp.id} className="context-menu-item" onClick={() => handleResetPipeline(t, bp.id)}>
                      {bp.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Priority submenu */}
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setSubMenu('priority')}
              onMouseLeave={() => setSubMenu(s => s === 'priority' ? null : s)}
            >
              <button className="context-menu-item">
                Priority <span className="submenu-arrow">&#9656;</span>
              </button>
              {subMenu === 'priority' && (
                <div className="context-menu context-menu-sub" onMouseDown={e => e.stopPropagation()}>
                  {[1, 2, 3, 4].map(p => (
                    <button
                      key={p}
                      className={`context-menu-item${t.priority === p ? ' active' : ''}`}
                      onClick={() => handleSetPriority(t, p)}
                    >
                      P{p} {t.priority === p ? '\u2713' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="context-menu-separator" />
            <button
              className="context-menu-item danger"
              onClick={() => handleDeleteTask(t)}
            >
              Delete task
            </button>
          </div>
        )
      })()}
    </div>
  )
}
