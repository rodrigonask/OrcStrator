import { useState, useEffect, useCallback } from 'react'
import type { AgentConfig } from '@shared/types'
import { api } from '../api'

export function useAgents() {
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await api.getAgents()
      setAgents(data)
    } catch (err) {
      console.error('Failed to fetch agents:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // This used to also ask the server to sync "native" agents on every open, from a
  // server folder that no longer exists, so it always synced nothing. That endpoint is gone.
  useEffect(() => {
    refresh()
  }, [refresh])

  // Listen for WebSocket agent events
  useEffect(() => {
    const unsubs = [
      api.onEvent('agent:created', () => refresh()),
      api.onEvent('agent:updated', () => refresh()),
      api.onEvent('agent:deleted', () => refresh()),
      // No 'agents:synced' listener: only the removed sync endpoint ever sent that event.
    ]
    return () => unsubs.forEach(u => u())
  }, [refresh])

  return { agents, loading, refresh }
}
