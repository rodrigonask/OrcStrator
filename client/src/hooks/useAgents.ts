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

  const syncNative = useCallback(async () => {
    try {
      const result = await api.syncNativeAgents()
      if (result.agents) setAgents(result.agents)
    } catch (err) {
      console.error('Failed to sync native agents:', err)
    }
  }, [])

  useEffect(() => {
    refresh()
    syncNative()
  }, [refresh, syncNative])

  // Listen for WebSocket agent events
  useEffect(() => {
    const unsubs = [
      api.onEvent('agent:created', () => refresh()),
      api.onEvent('agent:updated', () => refresh()),
      api.onEvent('agent:deleted', () => refresh()),
      api.onEvent('agents:synced', () => refresh()),
    ]
    return () => unsubs.forEach(u => u())
  }, [refresh])

  return { agents, loading, refresh, syncNative }
}
