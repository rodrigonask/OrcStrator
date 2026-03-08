import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '../api'
import { useUI } from './UIContext'
import type { PipelineTask, PipelineColumn, PipelineEvent } from '@shared/types'

interface PipelineContextValue {
  tasks: PipelineTask[]
  loading: boolean
  error: string | null
  tasksByColumn: Record<PipelineColumn, PipelineTask[]>
  createTask: (data: Partial<PipelineTask>) => Promise<PipelineTask | null>
  updateTask: (taskId: string, data: Partial<PipelineTask>) => Promise<void>
  deleteTask: (taskId: string) => Promise<void>
  moveTask: (taskId: string, column: PipelineColumn, agent?: string) => Promise<void>
  assignAgent: (taskId: string, agentRole: string) => Promise<void>
  claimTask: (taskId: string, agent: string) => Promise<void>
  blockTask: (taskId: string, reason: string) => Promise<void>
  unblockTask: (taskId: string) => Promise<void>
  refresh: () => Promise<void>
}

const COLUMNS: PipelineColumn[] = ['backlog', 'scheduled', 'spec', 'build', 'qa', 'ship', 'done']

const emptyByColumn: Record<PipelineColumn, PipelineTask[]> = {
  backlog: [],
  scheduled: [],
  spec: [],
  build: [],
  qa: [],
  ship: [],
  done: [],
}

const PipelineContext = createContext<PipelineContextValue | null>(null)

export function PipelineProvider({ children }: { children: React.ReactNode }) {
  const { activePipelineId } = useUI()
  const [tasks, setTasks] = useState<PipelineTask[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Monotonic counter — stale fetches (incremented ID != current) are discarded
  const fetchSeqRef = useRef(0)

  const fetchTasks = useCallback(async () => {
    if (!activePipelineId) {
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
        // Incremental: just update the column field locally
        setTasks(prev => prev.map(t =>
          t.id === payload.taskId ? { ...t, column: payload.newColumn! } : t
        ))
      } else if (payload.action === 'deleted') {
        // Incremental: remove the task locally
        setTasks(prev => prev.filter(t => t.id !== payload.taskId))
      } else {
        // created, updated, claimed, blocked, unblocked -- need full data, refetch
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
      { backlog: [], scheduled: [], spec: [], build: [], qa: [], ship: [], done: [] }
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
    async (taskId: string, data: Partial<PipelineTask>) => {
      if (!activePipelineId) return
      try {
        const updated = await api.updateTask(activePipelineId, taskId, data)
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)))
      } catch (err) {
        console.error('Failed to update task:', err)
      }
    },
    [activePipelineId]
  )

  const deleteTask = useCallback(
    async (taskId: string) => {
      if (!activePipelineId) return
      try {
        await api.deleteTask(activePipelineId, taskId)
        setTasks((prev) => prev.filter((t) => t.id !== taskId))
      } catch (err) {
        console.error('Failed to delete task:', err)
      }
    },
    [activePipelineId]
  )

  const moveTask = useCallback(
    async (taskId: string, column: PipelineColumn, agent?: string) => {
      if (!activePipelineId) return
      try {
        const updated = await api.moveTask(activePipelineId, taskId, column, agent)
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)))
      } catch (err) {
        console.error('Failed to move task:', err)
      }
    },
    [activePipelineId]
  )

  const assignAgent = useCallback(
    async (taskId: string, agentRole: string) => {
      if (!activePipelineId) return
      try {
        const task = tasks.find(t => t.id === taskId)
        if (!task) return
        const updated = await api.moveTask(activePipelineId, taskId, task.column, agentRole)
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)))
      } catch (err) {
        console.error('Failed to assign agent:', err)
      }
    },
    [activePipelineId, tasks]
  )

  const claimTask = useCallback(
    async (taskId: string, agent: string) => {
      if (!activePipelineId) return
      try {
        const updated = await api.claimTask(activePipelineId, taskId, agent)
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)))
      } catch (err) {
        console.error('Failed to claim task:', err)
      }
    },
    [activePipelineId]
  )

  const blockTask = useCallback(
    async (taskId: string, reason: string) => {
      if (!activePipelineId) return
      try {
        const updated = await api.blockTask(activePipelineId, taskId, reason)
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)))
      } catch (err) {
        console.error('Failed to block task:', err)
      }
    },
    [activePipelineId]
  )

  const unblockTask = useCallback(
    async (taskId: string) => {
      if (!activePipelineId) return
      try {
        const updated = await api.unblockTask(activePipelineId, taskId)
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)))
      } catch (err) {
        console.error('Failed to unblock task:', err)
      }
    },
    [activePipelineId]
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
      assignAgent,
      claimTask,
      blockTask,
      unblockTask,
      refresh: fetchTasks,
    }),
    [tasks, loading, error, tasksByColumn, createTask, updateTask, deleteTask, moveTask, assignAgent, claimTask, blockTask, unblockTask, fetchTasks]
  )

  return <PipelineContext.Provider value={value}>{children}</PipelineContext.Provider>
}

export function usePipeline(): PipelineContextValue {
  const ctx = useContext(PipelineContext)
  if (!ctx) throw new Error('usePipeline must be used within a PipelineProvider')
  return ctx
}
