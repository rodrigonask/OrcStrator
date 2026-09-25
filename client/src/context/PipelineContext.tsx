import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '../api'
import { rest } from '../api/rest'
import { useUI } from './UIContext'
import { useAppDispatch } from './AppDispatchContext'
import { isAllProjects } from '../utils/pipelineView'
import type { PipelineTask, PipelineColumn, PipelineEvent } from '@shared/types'

interface PipelineContextValue {
  tasks: PipelineTask[]
  loading: boolean
  error: string | null
  tasksByColumn: Record<PipelineColumn, PipelineTask[]>
  createTask: (data: Partial<PipelineTask>) => Promise<PipelineTask | null>
  updateTask: (taskId: string, data: Partial<PipelineTask>, explicitProjectId?: string) => Promise<void>
  deleteTask: (taskId: string, explicitProjectId?: string) => Promise<void>
  moveTask: (taskId: string, column: PipelineColumn, explicitProjectId?: string) => Promise<void>
  startTask: (taskId: string, instanceId?: string, projectId?: string) => Promise<{ instanceId: string; created: boolean } | null>
  blockTask: (taskId: string, reason: string, projectId?: string) => Promise<void>
  unblockTask: (taskId: string, projectId?: string) => Promise<void>
  refresh: () => Promise<void>
}

const PipelineContext = createContext<PipelineContextValue | null>(null)

export function PipelineProvider({ children }: { children: React.ReactNode }) {
  const { activePipelineId } = useUI()
  const { addToGridBackground } = useAppDispatch()
  const [tasks, setTasks] = useState<PipelineTask[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Monotonic counter — stale fetches (incremented ID != current) are discarded
  const fetchSeqRef = useRef(0)

  const fetchTasks = useCallback(async () => {
    // The all-projects sentinel is not a real project id: fetching it would ask the server
    // for /api/pipelines/__all__, which returns an empty list for a project that does not
    // exist. The all-projects board has its own data source (AllTasksContext).
    if (!activePipelineId || isAllProjects(activePipelineId)) {
      setTasks([])
      return
    }
    const seq = ++fetchSeqRef.current
    setLoading(true)
    setError(null)
    try {
      const data = await api.getProjectPipeline(activePipelineId, true)
      if (seq === fetchSeqRef.current) setTasks(data)
    } catch (err) {
      if (seq === fetchSeqRef.current) setError(err instanceof Error ? err.message : 'Failed to load pipeline')
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false)
    }
  }, [activePipelineId])

  // Fetch when active pipeline changes — clear stale tasks immediately
  useEffect(() => {
    setTasks([])
    fetchTasks()
  }, [fetchTasks])

  // Subscribe to pipeline WS events with incremental updates
  useEffect(() => {
    const unsub = api.onPipelineUpdated((payload: PipelineEvent) => {
      if (payload.projectId !== activePipelineId) return

      if (payload.action === 'moved' && payload.newColumn) {
        // Patch the column immediately so the card lands in the right place with no
        // flicker, then pull the whole row. Patching ONLY the column used to leave every
        // other field stale in every tab that did not originate the move: after the task
        // runner moved a task to in_review, the card kept showing no cost and no instance
        // link, so a finished task looked unstarted and clicking its start arrow would
        // have spawned a second instance. completedAt was stale too, which is the key the
        // done column sorts on.
        setTasks(prev => prev.map(t =>
          t.id === payload.taskId ? { ...t, column: payload.newColumn! } : t
        ))
        const projectId = payload.projectId
        rest.getTask(projectId, payload.taskId)
          .then(full => setTasks(prev => prev.map(t => (t.id === full.id ? full : t))))
          .catch(() => { /* the column patch above already applied */ })
      } else if (payload.action === 'deleted') {
        // Incremental: remove the task locally
        setTasks(prev => prev.filter(t => t.id !== payload.taskId))
      } else {
        // created, updated, blocked, unblocked -- need full data, refetch
        fetchTasks()
      }
    })
    return unsub
  }, [activePipelineId, fetchTasks])

  // Group tasks by column (memoized to avoid recomputing on unrelated renders)
  const tasksByColumn = useMemo(() => {
    const groups = tasks.reduce<Record<PipelineColumn, PipelineTask[]>>(
      (acc, task) => {
        if (acc[task.column]) {
          acc[task.column].push(task)
        }
        return acc
      },
      { backlog: [], ready: [], in_progress: [], in_review: [], done: [] } as Record<PipelineColumn, PipelineTask[]>
    )
    // Most recently completed first; fall back to updatedAt for tasks missing completedAt
    groups.done.sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
    return groups
  }, [tasks])

  const createTask = useCallback(
    async (data: Partial<PipelineTask>) => {
      if (!activePipelineId) return null
      try {
        const task = await api.createTask(activePipelineId, data)
        setTasks((prev) => [...prev, task])
        return task
      } catch (err) {
        console.error('Failed to create task:', err)
        return null
      }
    },
    [activePipelineId]
  )

  const updateTask = useCallback(
    async (taskId: string, data: Partial<PipelineTask>, explicitProjectId?: string) => {
      // Same resolution as moveTask and startTask: the all-projects board has no active
      // project, so its context menu passes the task's own project in.
      const projectId = explicitProjectId || tasks.find(t => t.id === taskId)?.projectId || activePipelineId
      if (!projectId) return
      try {
        const updated = await api.updateTask(projectId, taskId, data)
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)))
      } catch (err) {
        console.error('Failed to update task:', err)
      }
    },
    [tasks, activePipelineId]
  )

  const deleteTask = useCallback(
    async (taskId: string, explicitProjectId?: string) => {
      const projectId = explicitProjectId || tasks.find(t => t.id === taskId)?.projectId || activePipelineId
      if (!projectId) return
      try {
        await api.deleteTask(projectId, taskId)
        setTasks((prev) => prev.filter((t) => t.id !== taskId))
      } catch (err) {
        console.error('Failed to delete task:', err)
      }
    },
    [tasks, activePipelineId]
  )

  const moveTask = useCallback(
    async (taskId: string, column: PipelineColumn, explicitProjectId?: string) => {
      // Same resolution as startTask: the all-projects board has no activePipelineId, so
      // a move fired from there used to return silently and the card never went anywhere.
      const projectId = explicitProjectId || tasks.find(t => t.id === taskId)?.projectId || activePipelineId
      if (!projectId) return
      try {
        const updated = await api.moveTask(projectId, taskId, column)
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)))
      } catch (err) {
        console.error('Failed to move task:', err)
      }
    },
    [tasks, activePipelineId]
  )

  const startTask = useCallback(
    async (taskId: string, instanceId?: string, explicitProjectId?: string) => {
      // Prefer the task's own project — quick-start also fires from the
      // all-projects kanban where activePipelineId may not match (or be unset).
      const projectId = explicitProjectId || tasks.find(t => t.id === taskId)?.projectId || activePipelineId
      if (!projectId) return null
      // No try/catch — callers surface the error (busy instance, spawn failure)
      const result = await api.startTask(projectId, taskId, instanceId)
      setTasks((prev) => prev.map((t) => (t.id === taskId ? result.task : t)))
      // The run has to be VISIBLE without hunting for it. Starting a task still does not
      // navigate (that was deliberate and stays), but the instance it started becomes a
      // grid tile right now, so switching to the grid shows the work already running
      // instead of nothing. Background add: no focus change, no un-maximizing.
      addToGridBackground(result.instanceId)
      return { instanceId: result.instanceId, created: result.created }
    },
    [tasks, activePipelineId, addToGridBackground]
  )

  const blockTask = useCallback(
    async (taskId: string, reason: string, explicitProjectId?: string) => {
      // Same resolution as the four above. The detail panel opens on the all-projects
      // board now, where there is no active project, so blocking from there returned
      // silently on the guard and the chip flipped in the UI with nothing saved.
      const projectId = explicitProjectId || tasks.find(t => t.id === taskId)?.projectId || activePipelineId
      if (!projectId) return
      try {
        const updated = await api.blockTask(projectId, taskId, reason)
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)))
      } catch (err) {
        console.error('Failed to block task:', err)
      }
    },
    [tasks, activePipelineId]
  )

  const unblockTask = useCallback(
    async (taskId: string, explicitProjectId?: string) => {
      const projectId = explicitProjectId || tasks.find(t => t.id === taskId)?.projectId || activePipelineId
      if (!projectId) return
      try {
        const updated = await api.unblockTask(projectId, taskId)
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)))
      } catch (err) {
        console.error('Failed to unblock task:', err)
      }
    },
    [tasks, activePipelineId]
  )

  const value = useMemo<PipelineContextValue>(
    () => ({
      tasks,
      loading,
      error,
      tasksByColumn,
      createTask,
      updateTask,
      deleteTask,
      moveTask,
      startTask,
      blockTask,
      unblockTask,
      refresh: fetchTasks,
    }),
    [tasks, loading, error, tasksByColumn, createTask, updateTask, deleteTask, moveTask, startTask, blockTask, unblockTask, fetchTasks]
  )

  return <PipelineContext.Provider value={value}>{children}</PipelineContext.Provider>
}

export function usePipeline(): PipelineContextValue {
  const ctx = useContext(PipelineContext)
  if (!ctx) throw new Error('usePipeline must be used within a PipelineProvider')
  return ctx
}
