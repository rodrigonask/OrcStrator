import { useState, useCallback } from 'react'
import type { InstanceConfig } from '@shared/types'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'

// A context is "heavy" enough that a cold re-read (or its per-turn input billing) is
// worth one click to compact, so the compact button only appears past this. Kept in
// sync with the server advisor's ADVISOR_CTX_MIN (cache-advisor.ts).
const HEAVY_CTX = 250_000

/**
 * Shared keep-warm 🔥 + compact controls for an instance, so the grid-tile header and the
 * full chat header stay in lockstep. Keep-warm flips optimistically and reverts on error
 * (the 🔥 must never lie about whether the session is actually being kept warm).
 */
export function useCacheKeeper(instance: InstanceConfig | undefined) {
  const { dispatch } = useAppDispatch()
  const [compacting, setCompacting] = useState(false)

  const keepWarm = !!instance?.keepWarm
  const ctxHeavy = (instance?.ctxTokens ?? 0) >= HEAVY_CTX
  const hasSession = !!instance?.sessionId

  const toggleKeepWarm = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!instance) return
    const next = !instance.keepWarm
    dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { keepWarm: next } } })
    api.setKeepWarm(instance.id, next).catch(() => {
      dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { keepWarm: !next } } })
    })
  }, [instance, dispatch])

  const doCompact = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!instance || compacting) return
    setCompacting(true)
    api.compactInstance(instance.id).catch(() => {}).finally(() => setCompacting(false))
  }, [instance, compacting])

  return { keepWarm, ctxHeavy, hasSession, compacting, toggleKeepWarm, doCompact }
}
