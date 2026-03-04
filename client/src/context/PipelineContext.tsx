import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import { useApp } from './AppContext'
import type { PipelineTask, PipelineColumn, PipelineEvent } from '@shared/types'

interface PipelineContextValue {
  tasks: PipelineTask[]
  loading: boolean
  error: string | null
  tasksByColumn: Record<PipelineColumn, PipelineTask[]>
  createTask: (data: Partial<PipelineTask>) => Promise<PipelineTask | null>
  updateTask: (taskId: string, data: Partial<PipelineTask>) => Promise<void>
  deleteTask: (taskId: string) => Promise<void>
  moveTask: (taskId: string, column: PipelineColumn) => Promise<void>
  claimTask: (taskId: string, agent: string) => Promise<void>
  blockTask: (taskId: string, reason: string) => Promise<void>
  unblockTask: (taskId: string) => Promise<void>
  refresh: () => Promise<void>
}

const COLUMNS: PipelineColumn[] = ['backlog', 'spec', 'build', 'qa', 'staging', 'ship', 'done']

const emptyByColumn: Record<PipelineColumn, PipelineTask[]> = {
  backlog: [],
  spec: [],
  build: [],
  qa: [],
  staging: [],
  ship: [],
  done: [],
}

const PipelineContext = createContext<PipelineContextValue | null>(null)

export function PipelineProvider({ children }: { children: React.ReactNode }) {
  const { state } = useApp()
  const { activePipelineId } = state
  const [tasks, setTasks] = useState<PipelineTask[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchTasks = useCallback(async () => {
    if (!activePipelineId) {
      setTasks([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await api.getProjectPipeline(activePipelineId)
      setTasks(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pipeline')
    } finally {
      setLoading(false)
    }
  }, [activePipelineId])

  // Fetch when active pipeline changes
  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  // Subscribe to pipeline WS events
  useEffect(() => {
    const unsub = api.onPipelineUpdated((payload: PipelineEvent) => {
      if (payload.projectId === activePipelineId) {
        // Refetch all tasks on any pipeline event for simplicity
        fetchTasks()
      }
    })
    return unsub
  }, [activePipelineId, fetchTasks])

  // Group tasks by column
  const tasksByColumn = tasks.reduce<Record<PipelineColumn, PipelineTask[]>>(
    (acc, task) => {
      if (acc[task.column]) {
        acc[task.column].push(task)
      }
      return acc
    },
    { ...emptyByColumn, backlog: [], spec: [], build: [], qa: [], staging: [], ship: [], done: [] }
  )

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
    async (taskId: string, column: PipelineColumn) => {
      if (!activePipelineId) return
      try {
        const updated = await api.moveTask(activePipelineId, taskId, column)
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)))
      } catch (err) {
        console.error('Failed to move task:', err)
      }
    },
    [activePipelineId]
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

  const value: PipelineContextValue = {
    tasks,
    loading,
    error,
    tasksByColumn,
    createTask,
    updateTask,
    deleteTask,
    moveTask,
    claimTask,
    blockTask,
    unblockTask,
    refresh: fetchTasks,
  }

  return <PipelineContext.Provider value={value}>{children}</PipelineContext.Provider>
}

export function usePipeline(): PipelineContextValue {
  const ctx = useContext(PipelineContext)
  if (!ctx) throw new Error('usePipeline must be used within a PipelineProvider')
  return ctx
}
