// All-projects pipeline kanban: flat columns with project dividers

import { useState, useCallback, useMemo } from 'react'
import { useAllTasks } from '../../context/AllTasksContext'
import { useInstances } from '../../context/InstancesContext'
import { useUI } from '../../context/UIContext'
import { TaskCard } from './TaskCard'
import { TaskDetailPanel } from './TaskDetailPanel'
import { TaskContextMenu } from './TaskContextMenu'
import type { TaskMenuAnchor } from './TaskContextMenu'
import { folderColor } from '../../utils/folderColor'
import { isScheduled } from '../../utils/taskSchedule'
import type { ScheduleKindFilter } from './PipelineBoard'
import { PIPELINE_COLUMNS, COLUMN_COLORS, DEFAULT_COLUMN_LABELS } from '@shared/constants'
import type { PipelineTask, PipelineColumn, FolderConfig } from '@shared/types'

const COLUMNS = PIPELINE_COLUMNS // backlog, ready, in_progress, in_review, done
const STORAGE_KEY = 'allkanban-collapsed'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch { /* ignore */ }
  return new Set()
}

function saveCollapsed(set: Set<string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]))
}

// A scheduled card used to need its own item type here, because it was a different object
// that had to be interleaved into a column it did not belong to. It is a task now.
type ColumnItem =
  | { type: 'divider'; project: FolderConfig; count: number }
  | { type: 'task'; task: PipelineTask; project: FolderConfig }

function ProjectDivider({ project, collapsed, count, onToggle }: {
  project: FolderConfig
  collapsed: boolean
  count: number
  onToggle: () => void
}) {
  return (
    <div
      className={`project-divider${collapsed ? ' collapsed' : ''}`}
      onClick={onToggle}
      style={{ '--project-color': folderColor(project) } as React.CSSProperties}
    >
      <span className="project-divider-chevron">{collapsed ? '▶' : '▼'}</span>
      <span>{project.emoji || '\u{1F4C1}'}</span>
      <span className="project-divider-name">{project.displayName || project.name}</span>
      {/* Collapsed groups would otherwise read as empty projects, which is the opposite of
          what this board is for. */}
      <span className="project-divider-count">{count}</span>
    </div>
  )
}

interface AllProjectsKanbanProps {
  /** Title/label substring filter, shared with the board header's search box. */
  searchQuery?: string
  /** The header's pressed kind chips. Non-empty narrows to cards with that kind of schedule. */
  kindFilter?: ReadonlySet<ScheduleKindFilter>
}

const NO_KINDS: ReadonlySet<ScheduleKindFilter> = new Set()

export function AllProjectsKanban({ searchQuery = '', kindFilter = NO_KINDS }: AllProjectsKanbanProps) {
  const { byProject, allTasks, loading, error, moveTask, refetch } = useAllTasks()
  const { folders } = useInstances()
  const { settings } = useUI()

  const [dragOverCol, setDragOverCol] = useState<string | null>(null)
  // Same menu as the per-project board. Every action inside it is scoped to the card's own
  // project, which is the only reason it can live on a board that has no active project.
  const [taskMenu, setTaskMenu] = useState<TaskMenuAnchor | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)

  // The user can rename columns, and that setting is global. Hardcoding the defaults here
  // meant renaming Ready to "Queued" changed the per-project board and not this one.
  const columnLabels = useMemo(
    () => ({ ...DEFAULT_COLUMN_LABELS, ...(settings.columnLabels || {}) }),
    [settings.columnLabels]
  )

  const toggleCollapse = useCallback((projectId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      saveCollapsed(next)
      return next
    })
  }, [])

  // A scheduled card belongs to its own project, like every other card. It used to be
  // bucketed by the project of the instance it fired on, because a routine had no project
  // of its own to be placed by.

  // Sidebar order: stealth first, then sortOrder ascending; hide projects with nothing on the board
  const sortedProjects = useMemo(() => {
    return [...folders]
      .sort((a, b) => {
        if (a.stealthMode && !b.stealthMode) return -1
        if (!a.stealthMode && b.stealthMode) return 1
        return (a.sortOrder ?? 999) - (b.sortOrder ?? 999)
      })
      .filter(f => (byProject[f.id]?.length ?? 0) > 0)
  }, [folders, byProject])

  const matchesSearch = useCallback((t: PipelineTask) => {
    if (kindFilter.size > 0) {
      if (!isScheduled(t)) return false
      const kind: ScheduleKindFilter = t.scheduleKind === 'once' ? 'scheduled' : 'routine'
      if (!kindFilter.has(kind)) return false
    }
    const q = searchQuery.trim().toLowerCase()
    if (!q) return true
    // The all-projects payload is the light shape, so description is always '' here.
    // Title and labels are all there is to match on.
    return t.title.toLowerCase().includes(q) || t.labels.some(l => l.toLowerCase().includes(q))
  }, [searchQuery, kindFilter])

  // Build flat list of items for a column
  const buildColumnItems = useCallback((column: PipelineColumn): ColumnItem[] => {
    const items: ColumnItem[] = []
    for (const folder of sortedProjects) {
      let tasks: PipelineTask[] = (byProject[folder.id] || []).filter(t => t.column === column && matchesSearch(t))
      if (tasks.length === 0) continue
      // Done arrives in the server's priority/created order, which puts the oldest
      // finished work on top. The per-project board sorts it newest-first; match that or
      // recent completions sink under a growing pile.
      if (column === 'done') {
        tasks = [...tasks].sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
      }
      items.push({ type: 'divider', project: folder, count: tasks.length })
      if (!collapsed.has(folder.id)) {
        for (const task of tasks) items.push({ type: 'task', task, project: folder })
      }
    }
    return items
  }, [sortedProjects, byProject, collapsed, matchesSearch])

  const columnCounts = useMemo(() => {
    const counts = {} as Record<PipelineColumn, number>
    for (const col of COLUMNS) {
      counts[col] = allTasks.filter(t => t.column === col && matchesSearch(t)).length
    }
    return counts
  }, [allTasks, matchesSearch])

  // Open the task HERE. Clicking used to switch the board to the task's own project,
  // because the panel's mutations were scoped to the active project; they now take the
  // task's project explicitly, so the panel works from this board and the cross-project
  // view survives a click. Reading one task is not a request to leave the overview.
  //
  // Held by id, not by the task object: every 'created'/'updated' event refetches the
  // whole board and replaces every task object, so a snapshot would keep rendering the
  // state from the moment of the click. Looking it up each render also closes the panel
  // by itself when the task is deleted.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const selectedTask = useMemo(
    () => (selectedTaskId ? allTasks.find(t => t.id === selectedTaskId) ?? null : null),
    [allTasks, selectedTaskId]
  )
  const handleTaskClick = useCallback((task: PipelineTask) => {
    setSelectedTaskId(task.id)
  }, [])

  const handleTaskContextMenu = useCallback((e: React.MouseEvent, task: PipelineTask) => {
    setTaskMenu({ x: e.clientX, y: e.clientY, task })
  }, [])

  const closeTaskMenu = useCallback(() => setTaskMenu(null), [])

  const handleDragOver = useCallback((e: React.DragEvent, column: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverCol(column)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverCol(null)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, column: PipelineColumn) => {
    e.preventDefault()
    setDragOverCol(null)
    const jsonData = e.dataTransfer.getData('application/json')
    if (!jsonData) return
    try {
      const { taskId } = JSON.parse(jsonData)
      if (!taskId) return
      // Look up projectId from allTasks
      const task = allTasks.find(t => t.id === taskId)
      // Dropping a card back where it started still costs a POST and a history entry.
      if (task && task.column !== column) {
        moveTask(task.projectId, taskId, column)
      }
    } catch { /* ignore */ }
  }, [moveTask, allTasks])

  if (loading) {
    return (
      <div className="all-kanban" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
        Loading pipeline...
      </div>
    )
  }

  // A failed fetch must not masquerade as an empty board. Without this branch a server
  // restart mid-load told the user they had no work at all.
  if (error) {
    return (
      <div className="all-kanban" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', flexDirection: 'column', gap: 10 }}>
        <span style={{ fontSize: 14, color: 'var(--danger, #ef4444)' }}>Could not load tasks</span>
        <span style={{ fontSize: 12 }}>{error}</span>
        <button className="btn btn-sm" onClick={refetch}>Retry</button>
      </div>
    )
  }

  if (sortedProjects.length === 0) {
    return (
      <div className="all-kanban" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 24, opacity: 0.4 }}>No pipeline tasks</span>
        <span style={{ fontSize: 12 }}>Press Alt+N to capture one</span>
      </div>
    )
  }

  return (
    <div className="all-kanban">
      {/* Column headers */}
      <div className="all-kanban-headers">
        {COLUMNS.map(col => (
          <div key={col} className="all-kanban-header" style={{ borderBottomColor: COLUMN_COLORS[col] + '66' }}>
            <span style={{ color: COLUMN_COLORS[col] }}>{columnLabels[col] || col}</span>
            <span className="all-kanban-header-count">{columnCounts[col]}</span>
          </div>
        ))}
      </div>

      {/* Flat columns */}
      <div className="all-kanban-columns">
        {COLUMNS.map(col => (
          <div
            key={col}
            className={`all-kanban-col${dragOverCol === col ? ' drag-over' : ''}`}
            onDragOver={(e) => handleDragOver(e, col)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, col)}
          >
            {buildColumnItems(col).map(item => {
              if (item.type === 'divider') {
                return (
                  <ProjectDivider
                    key={`d-${item.project.id}-${col}`}
                    project={item.project}
                    collapsed={collapsed.has(item.project.id)}
                    count={item.count}
                    onToggle={() => toggleCollapse(item.project.id)}
                  />
                )
              }
              return (
                <TaskCard
                  key={item.task.id}
                  task={item.task}
                  onClick={() => handleTaskClick(item.task)}
                  onContextMenu={handleTaskContextMenu}
                />
              )
            })}
          </div>
        ))}
      </div>

      {selectedTask && (
        <TaskDetailPanel task={selectedTask} onClose={() => setSelectedTaskId(null)} />
      )}

      {taskMenu && <TaskContextMenu anchor={taskMenu} onClose={closeTaskMenu} />}
    </div>
  )
}
