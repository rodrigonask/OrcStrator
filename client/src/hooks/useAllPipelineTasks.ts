// Fetch all projects' pipeline tasks, WebSocket sync, moveTask mutation

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '../api'
import { rest } from '../api/rest'
import type { PipelineTask, PipelineColumn } from '@shared/types'

export interface AllPipelineData {
  /** tasks grouped by projectId */
  byProject: Record<string, PipelineTask[]>
  /** flat list of all tasks */
  allTasks: PipelineTask[]
  /** open (not done) task count per projectId, for the sidebar badges */
  pendingByProject: Record<string, number>
  loading: boolean
  /** set when the last fetch failed, so an error is never rendered as an empty board */
  error: string | null
  moveTask: (projectId: string, taskId: string, column: PipelineColumn) => Promise<void>
  refetch: () => void
}

export function useAllPipelineTasks(): AllPipelineData {
  const [byProject, setByProject] = useState<Record<string, PipelineTask[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  // Monotonic counter. Every created/updated/blocked/unblocked event triggers a full
  // refetch, so two quick edits put two GETs in flight and the slower one could land last
  // and reinstate the older snapshot. PipelineContext guards its fetch the same way.
  const fetchSeqRef = useRef(0)

  const fetchAll = useCallback(async () => {
    const seq = ++fetchSeqRef.current
    try {
      // includeDone: the all-projects board renders a Done column, and without this the
      // server filters done tasks out, so that column can never show anything.
      const data = await api.getPipelines(true)
      if (mountedRef.current && seq === fetchSeqRef.current) {
        setByProject(data)
        setError(null)
        setLoading(false)
      }
    } catch (err) {
      // Do NOT leave byProject empty and call it done. An empty object renders as "No
      // pipeline tasks" and makes every sidebar badge vanish, which reads as "you have no
      // work" rather than "the fetch failed". The server restarting under dev-watch is
      // enough to trigger this.
      if (mountedRef.current && seq === fetchSeqRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load tasks')
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    fetchAll()

    const unsub = api.onPipelineUpdated((payload: any) => {
      if (!mountedRef.current) return
      // Incremental for moved/deleted; full refetch for created/updated
      if (payload?.action === 'moved' && payload.projectId && payload.taskId && payload.newColumn) {
        // Patch the column first so the card lands in the right place with no flicker,
        // then pull the whole row.
        //
        // Patching ONLY the column is the bug PipelineContext already fixed once and this
        // hook reintroduced. The task runner writes instance_id and the cost roll-up with
        // raw SQL and broadcasts nothing; the single 'moved' event is all we get. So a task
        // started from this board kept instanceId undefined, TaskCard rendered the start
        // arrow instead of the open arrow, and clicking it again spawned a SECOND Claude
        // process on the same task. Refetching the row closes that.
        setByProject(prev => {
          const tasks = prev[payload.projectId] || []
          return {
            ...prev,
            [payload.projectId]: tasks.map(t =>
              t.id === payload.taskId ? { ...t, column: payload.newColumn } : t
            ),
          }
        })
        rest.getTask(payload.projectId, payload.taskId)
          .then(full => {
            if (!mountedRef.current) return
            setByProject(prev => {
              const tasks = prev[payload.projectId] || []
              return {
                ...prev,
                [payload.projectId]: tasks.map(t => (t.id === full.id ? full : t)),
              }
            })
          })
          .catch(() => { /* the column patch above already applied */ })
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

    // Every pipeline event that arrives while the socket is down is gone for good, so the
    // snapshot has to be rebuilt on reconnect rather than drifting for the rest of the
    // session. AppContext does the same thing for instance state.
    const unsubConn = api.onConnection((payload: { connected: boolean }) => {
      if (payload?.connected && mountedRef.current) fetchAll()
    })

    return () => {
      mountedRef.current = false
      unsub()
      unsubConn()
    }
  }, [fetchAll])

  const moveTask = useCallback(async (projectId: string, taskId: string, column: PipelineColumn) => {
    // Optimistic: the WS echo confirms it, but without this the card sits in the old
    // column until the round trip lands, and on a dropped socket it never moves at all.
    setByProject(prev => {
      const tasks = prev[projectId] || []
      return { ...prev, [projectId]: tasks.map(t => (t.id === taskId ? { ...t, column } : t)) }
    })
    try {
      const updated = await api.moveTask(projectId, taskId, column)
      if (updated && mountedRef.current) {
        setByProject(prev => {
          const tasks = prev[projectId] || []
          return { ...prev, [projectId]: tasks.map(t => (t.id === taskId ? updated : t)) }
        })
      }
    } catch (err) {
      console.error('Failed to move task:', err)
      fetchAll()
    }
  }, [fetchAll])

  const allTasks = useMemo(() => Object.values(byProject).flat(), [byProject])

  // "Pending" is open work: everything that is not done. in_progress counts, because a
  // task Claude is holding is still work the project owes.
  const pendingByProject = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const [projectId, tasks] of Object.entries(byProject)) {
      const open = tasks.filter(t => t.column !== 'done').length
      if (open > 0) counts[projectId] = open
    }
    return counts
  }, [byProject])

  return { byProject, allTasks, pendingByProject, loading, error, moveTask, refetch: fetchAll }
}
