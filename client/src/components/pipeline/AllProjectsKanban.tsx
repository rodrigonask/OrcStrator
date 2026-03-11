// All-projects pipeline kanban: flat columns with project dividers

import { useState, useCallback, useMemo } from 'react'
import { useAllPipelineTasks } from '../../hooks/useAllPipelineTasks'
import { useInstances } from '../../context/InstancesContext'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { TaskCard } from './TaskCard'
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

type ColumnItem =
  | { type: 'divider'; project: FolderConfig }
  | { type: 'task'; task: PipelineTask; project: FolderConfig }

function ProjectDivider({ project, collapsed, onToggle }: {
  project: FolderConfig
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <div className={`project-divider${collapsed ? ' collapsed' : ''}`} onClick={onToggle}>
      <span className="project-divider-chevron">{collapsed ? '\u25B6' : '\u25BC'}</span>
      <span>{project.emoji || '\u{1F4C1}'}</span>
      <span className="project-divider-name">{project.displayName || project.name}</span>
    </div>
  )
}

export function AllProjectsKanban() {
  const { byProject, allTasks, loading, moveTask } = useAllPipelineTasks()
  const { folders } = useInstances()
  const { dispatch } = useAppDispatch()

  const [dragOverCol, setDragOverCol] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)

  const toggleCollapse = useCallback((projectId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      saveCollapsed(next)
      return next
    })
  }, [])

  // Sidebar order: stealth first, then sortOrder ascending; hide empty
  const sortedProjects = useMemo(() => {
    return [...folders]
      .sort((a, b) => {
        if (a.stealthMode && !b.stealthMode) return -1
        if (!a.stealthMode && b.stealthMode) return 1
        return (a.sortOrder ?? 999) - (b.sortOrder ?? 999)
      })
      .filter(f => (byProject[f.id]?.length ?? 0) > 0)
  }, [folders, byProject])

  // Build flat list of items for a column
  const buildColumnItems = useCallback((column: PipelineColumn): ColumnItem[] => {
    const items: ColumnItem[] = []
    for (const folder of sortedProjects) {
      const tasks = (byProject[folder.id] || []).filter(t => t.column === column)
      if (tasks.length === 0) continue
      items.push({ type: 'divider', project: folder })
      if (!collapsed.has(folder.id)) {
        for (const task of tasks) items.push({ type: 'task', task, project: folder })
      }
    }
    return items
  }, [sortedProjects, byProject, collapsed])

  const handleTaskClick = useCallback((task: PipelineTask) => {
    dispatch({ type: 'SET_PIPELINE_PROJECT', projectId: task.projectId })
    dispatch({ type: 'SET_VIEW', payload: 'pipeline' })
  }, [dispatch])

  const handleDragOver = useCallback((e: React.DragEvent, column: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverCol(column)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverCol(null)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, column: PipelineColumn) => {
    setDragOverCol(null)
    const jsonData = e.dataTransfer.getData('application/json')
    if (!jsonData) return
    try {
      const { taskId } = JSON.parse(jsonData)
      if (!taskId) return
      // Look up projectId from allTasks
      const task = allTasks.find(t => t.id === taskId)
      if (task) {
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

  if (sortedProjects.length === 0) {
    return (
      <div className="all-kanban" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 24, opacity: 0.4 }}>No pipeline tasks</span>
        <span style={{ fontSize: 12 }}>Create tasks in the Pipeline Project view</span>
      </div>
    )
  }

  return (
    <div className="all-kanban">
      {/* Column headers */}
      <div className="all-kanban-headers">
        {COLUMNS.map(col => (
          <div key={col} className="all-kanban-header" style={{ borderBottomColor: COLUMN_COLORS[col] + '66' }}>
            <span style={{ color: COLUMN_COLORS[col] }}>{DEFAULT_COLUMN_LABELS[col] || col}</span>
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
            {buildColumnItems(col).map(item =>
              item.type === 'divider'
                ? <ProjectDivider
                    key={`d-${item.project.id}-${col}`}
                    project={item.project}
                    collapsed={collapsed.has(item.project.id)}
                    onToggle={() => toggleCollapse(item.project.id)}
                  />
                : <TaskCard
                    key={item.task.id}
                    task={item.task}
                    projectColor={item.project.color}
                    onClick={() => handleTaskClick(item.task)}
                  />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
