import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { PipelineTask, PipelineColumn } from '@shared/types'
import { PIPELINE_COLUMNS, DEFAULT_COLUMN_LABELS } from '@shared/constants'
import { usePipeline } from '../../context/PipelineContext'
import { useUI } from '../../context/UIContext'
import { useInstances } from '../../context/InstancesContext'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { api } from '../../api'
import { TaskCard } from './TaskCard'
import { TaskContextMenu } from './TaskContextMenu'
import type { TaskMenuAnchor } from './TaskContextMenu'
import { TaskDetailPanel } from './TaskDetailPanel'
import { CreateTaskModal } from './CreateTaskModal'
import { AllProjectsKanban } from './AllProjectsKanban'
import { ALL_PROJECTS_ID, isAllProjects } from '../../utils/pipelineView'
import { isScheduled } from '../../utils/taskSchedule'

/**
 * The header's two chips. Both now describe a PROPERTY of a card rather than a separate
 * kind of object: 'routine' is a card that repeats, 'scheduled' is a card that fires once.
 */
export type ScheduleKindFilter = 'routine' | 'scheduled'

export function PipelineBoard() {
  const { activePipelineId, pendingTaskFocusId, settings } = useUI()
  const { folders, instances } = useInstances()
  const { dispatch: appDispatch } = useAppDispatch()
  const pipeline = usePipeline()
  const [selectedTask, setSelectedTask] = useState<PipelineTask | null>(null)
  // ONE modal, opened by ONE button. There used to be a three-item Add menu whose second
  // and third items opened the same routine form seeded with a value that form already had
  // a select for, which was a click spent choosing something you then chose again.
  const [showCreate, setShowCreate] = useState(false)
  const [editingColumn, setEditingColumn] = useState<PipelineColumn | null>(null)
  const [editValue, setEditValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  // The header's kind chips. Pressed chips only; empty means the board is unfiltered.
  const [kindFilter, setKindFilter] = useState<Set<ScheduleKindFilter>>(() => new Set())
  const [taskContextMenu, setTaskContextMenu] = useState<TaskMenuAnchor | null>(null)


  const columnLabels = { ...DEFAULT_COLUMN_LABELS, ...(settings.columnLabels || {}) }

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
    const q = searchQuery.trim().toLowerCase()
    if (!q && kindFilter.size === 0) return sortedTasksByColumn
    // A pressed chip narrows to cards carrying that kind of schedule. Before the merge this
    // dropped EVERY task, because a routine was a different object living beside them; now
    // it is a property of the card, so the chip is an ordinary filter.
    const matchesKind = (task: PipelineTask) => {
      if (kindFilter.size === 0) return true
      if (!isScheduled(task)) return false
      const kind: ScheduleKindFilter = task.scheduleKind === 'once' ? 'scheduled' : 'routine'
      return kindFilter.has(kind)
    }
    const result: Record<string, PipelineTask[]> = {}
    for (const col of PIPELINE_COLUMNS) {
      result[col] = (sortedTasksByColumn[col] || []).filter(task =>
        matchesKind(task) && (!q ||
          task.title.toLowerCase().includes(q) ||
          (task.description || '').toLowerCase().includes(q) ||
          task.labels.some(l => l.toLowerCase().includes(q)))
      )
    }
    return result
  }, [sortedTasksByColumn, searchQuery, kindFilter])

  // A fresh Set on every toggle: React compares state by reference, so mutating the one it
  // already holds would never re-render.
  const toggleKind = useCallback((kind: ScheduleKindFilter) => {
    setKindFilter(prev => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }, [])

  const allProjects = isAllProjects(activePipelineId)
  // A project can be deleted while it is the active one. Without this fallback the select
  // holds an id matching no <option>, and the browser's reset algorithm silently displays
  // the FIRST option instead, which is now "All Projects" - so the header would claim the
  // global board while the per-project board rendered an empty list.
  const knownProject = !!activePipelineId && folders.some(f => f.id === activePipelineId)
  const projectId = allProjects ? '' : ((knownProject && activePipelineId) || folders[0]?.id || '')
  const [dragOverColumn, setDragOverColumn] = useState<PipelineColumn | null>(null)

  // Scheduled cards need no bucketing of their own any more. utils/routineBoard.ts existed
  // ONLY to fake a board column for an entity that had none. A scheduled card carries a real
  // column now, so it arrives in tasksByColumn with everything else.

  // Either one narrows the board, and the column counts switch to shown/total for both.
  const boardFiltered = !!searchQuery || kindFilter.size > 0

  // Clicking a card on the all-projects board switches here and hands off the task id, so
  // the click opens the task instead of just changing which board you are looking at.
  useEffect(() => {
    if (!pendingTaskFocusId) return
    const target = pipeline.tasks.find(t => t.id === pendingTaskFocusId)
    if (!target) return
    setSelectedTask(target)
    appDispatch({ type: 'SET_PENDING_TASK_FOCUS', taskId: null })
  }, [pendingTaskFocusId, pipeline.tasks, appDispatch])

  // The detail panel's every mutation is scoped to the active project, so leaving it open
  // across a project switch leaves a panel whose Save, Delete and Start all 404 in silence.
  useEffect(() => {
    setSelectedTask(null)
  }, [activePipelineId])

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

  // "+ Add Task" opens the modal directly. It used to open an anchored, portalled menu of
  // three items, with all the clamping and outside-click handling that needs, to ask a
  // question the modal's own When switch now asks better.
  const openCreate = useCallback(() => setShowCreate(true), [])

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
        <span className="pipeline-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>
          {allProjects ? 'All Projects' : 'Pipeline Project'}
        </span>
        {(() => {
          const f = folders.find(f => f.id === projectId)
          return f?.cloudSync ? (
            <span title={f.lastSyncedAt ? `Last synced: ${new Date(f.lastSyncedAt).toLocaleTimeString()}` : 'Synced to Cloud'} style={{ fontSize: 12, color: 'var(--accent)', marginLeft: 4 }}>{'☁'}</span>
          ) : null
        })()}
        <div className="pipeline-kind-filters" role="group" aria-label="Show only">
          <button
            type="button"
            className={`pipeline-kind-chip${kindFilter.has('routine') ? ' is-active' : ''}`}
            aria-pressed={kindFilter.has('routine')}
            onClick={() => toggleKind('routine')}
            title="Show only cards that repeat"
          >
            <span className="pipeline-kind-chip-glyph" aria-hidden="true">⟳</span>Repeating
          </button>
          <button
            type="button"
            className={`pipeline-kind-chip${kindFilter.has('scheduled') ? ' is-active' : ''}`}
            aria-pressed={kindFilter.has('scheduled')}
            onClick={() => toggleKind('scheduled')}
            title="Show only cards that fire once"
          >
            <span className="pipeline-kind-chip-glyph" aria-hidden="true">◷</span>Once
          </button>
        </div>
        {folders.length > 1 ? (
          <select
            className="pipeline-project-select"
            value={allProjects ? ALL_PROJECTS_ID : (activePipelineId || folders[0]?.id || '')}
            onChange={e => appDispatch({ type: 'SET_PIPELINE_PROJECT', projectId: e.target.value })}
          >
            <option value={ALL_PROJECTS_ID}>{'\u{1F310}'} All Projects</option>
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
        {/* Both controls stay on the all-projects board. Hiding them made the toolbar
            reflow every time the board was switched (the select jumped ~350px out from
            under the cursor), and cross-project is where a search is worth the most. The
            query is handed to the global board, which filters on title and labels. */}
        <div className="pipeline-search-wrapper">
          <input
            className="pipeline-search-input"
            style={{ fontFamily: 'var(--font-mono)' }}
            type="text"
            placeholder={allProjects ? 'Search all projects...' : 'Search tasks...'}
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
            className="btn btn-sm btn-primary"
            onClick={openCreate}
          >
            + Add Task
          </button>
        </div>
      </div>

      <div className="pipeline-content">
      {allProjects ? <AllProjectsKanban searchQuery={searchQuery} kindFilter={kindFilter} /> : (
      <div className="pipeline-columns">
        {PIPELINE_COLUMNS.map(col => {
          const colTasks = filteredTasksByColumn[col] || []
          const colShown = colTasks.length
          const colTotal = (pipeline.tasksByColumn[col] || []).length
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
                  {boardFiltered ? `${colShown}/${colTotal}` : colShown}
                </span>
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
                {colShown === 0 && (
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
                  onClick={openCreate}
                >
                  + Add Task
                </button>
              )}
            </div>
          )
        })}
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
          // On the all-projects board there is no active project, so seed the modal the
          // same way the Alt+N hotkey does. The selector inside it stays editable.
          projectId={projectId || folders[0]?.id || ''}
          onClose={() => setShowCreate(false)}
        />
      )}

      {taskContextMenu && (
        <TaskContextMenu anchor={taskContextMenu} onClose={() => setTaskContextMenu(null)} />
      )}
    </div>
  )
}
