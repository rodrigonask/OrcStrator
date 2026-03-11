// Fetch all projects' pipeline tasks, WebSocket sync, moveTask mutation

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../api'
import type { PipelineTask, PipelineColumn } from '@shared/types'

export interface AllPipelineData {
  /** tasks grouped by projectId */
  byProject: Record<string, PipelineTask[]>
  /** flat list of all tasks */
  allTasks: PipelineTask[]
  loading: boolean
  moveTask: (projectId: string, taskId: string, column: PipelineColumn) => Promise<void>
  refetch: () => void
}

export function useAllPipelineTasks(): AllPipelineData {
  const [byProject, setByProject] = useState<Record<string, PipelineTask[]>>({})
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  const fetchAll = useCallback(async () => {
    try {
      const data = await api.getPipelines()
      if (mountedRef.current) {
        setByProject(data)
        setLoading(false)
      }
    } catch {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    fetchAll()

    const unsub = api.onPipelineUpdated((payload: any) => {
      if (!mountedRef.current) return
      // Incremental for moved/deleted; full refetch for created/updated
      if (payload?.action === 'moved' && payload.projectId && payload.taskId && payload.newColumn) {
        setByProject(prev => {
          const tasks = prev[payload.projectId] || []
          return {
            ...prev,
            [payload.projectId]: tasks.map(t =>
              t.id === payload.taskId ? { ...t, column: payload.newColumn } : t
            ),
          }
        })
      } else if (payload?.action === 'deleted' && payload.projectId && payload.taskId) {
        setByProject(prev => {
          const tasks = prev[payload.projectId] || []
          return {
            ...prev,
            [payload.projectId]: tasks.filter(t => t.id !== payload.taskId),
          }
        })
      } else {
        // Full refetch for created/updated/unknown
        fetchAll()
      }
    })

    return () => {
      mountedRef.current = false
      unsub()
    }
  }, [fetchAll])

  const moveTask = useCallback(async (projectId: string, taskId: string, column: PipelineColumn) => {
    try {
      await api.moveTask(projectId, taskId, column, 'human')
    } catch (err) {
      console.error('Failed to move task:', err)
    }
  }, [])

  const allTasks = Object.values(byProject).flat()

  return { byProject, allTasks, loading, moveTask, refetch: fetchAll }
}
