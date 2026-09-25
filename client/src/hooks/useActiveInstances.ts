import { useMemo, useEffect, useReducer } from 'react'
import { useInstances } from '../context/InstancesContext'
import { useUI } from '../context/UIContext'
import type { InstanceConfig } from '@shared/types'

export interface CacheInfo {
  ratio: number | null
  minsLeft: number
  /** 0..1 of the full cache TTL still remaining — drives the chip progress bar. */
  ttlFraction: number
}

export interface ActiveInstance {
  inst: InstanceConfig
  cache: CacheInfo | null
  isRunning: boolean
  /** Blocked on the user: a turn hard-stopped on a question or a plan and is waiting. */
  awaitingInput: InstanceConfig['awaitingInput']
  lastAt: number
}

// Mirrors the cache tiers used by InstanceItem's badge
export function cacheTier(pct: number): string {
  if (pct >= 90) return 'purple'
  if (pct >= 80) return 'green'
  if (pct >= 65) return 'yellow'
  if (pct >= 50) return 'orange'
  return 'red'
}

/**
 * Instances that are genuinely OCCUPIED, which is three things and not one:
 *
 *   1. waiting on the user  - a turn hard-stopped on a question or a plan card,
 *   2. currently running    - a live process,
 *   3. cache still warm     - touched within the prompt-cache TTL.
 *
 * (1) exists because AskUserQuestion / ExitPlanMode deliberately kill the process, after
 * which the server marks the instance idle. Without the server's awaiting_input flag such an
 * instance looks finished, and on a FIRST turn it has no warm cache either, so it vanished
 * from the strip entirely - the single case where the user most needs to see it.
 *
 * Order: blocked on the user first (oldest block first, it has waited longest), then running,
 * then most-recent cache. Self-refreshes every 30s so TTLs tick down and cold entries drop.
 * Shared by the sidebar Cache Active panel and the top-bar tabs.
 */
export function useActiveInstances(): ActiveInstance[] {
  const { instances } = useInstances()
  const { sessionCosts, settings } = useUI()

  // Keep cache TTLs fresh (drops expired actives, ticks the minutes-left)
  const [, tick] = useReducer(x => x + 1, 0)
  useEffect(() => {
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [])

  const cacheTtlMs = settings.promptCache1h !== false ? 3_600_000 : 300_000
  const now = Date.now()

  return useMemo(() => {
    return instances
      .map(inst => {
        const isRunning = inst.state === 'running'
        const awaitingInput = inst.awaitingInput
        const sc = sessionCosts[inst.id]
        let cache: CacheInfo | null = null
        let cacheAt = 0
        if (sc && sc.totalCacheRead > 0 && sc.lastCacheCreatedAt != null) {
          const expiry = sc.lastCacheCreatedAt + cacheTtlMs
          if (now < expiry) {
            const remaining = expiry - now
            const ratio = sc.totalInput > 0
              ? Math.round((sc.totalCacheRead / sc.totalInput) * 100)
              : null
            cache = {
              ratio,
              minsLeft: Math.max(0, Math.floor(remaining / 60_000)),
              ttlFraction: Math.max(0, Math.min(1, remaining / cacheTtlMs)),
            }
            cacheAt = sc.lastCacheCreatedAt
          }
        }
        if (!awaitingInput && !isRunning && !cache) return null
        const lastAt = isRunning ? (inst.taskStartedAt ?? inst.lastTaskAt ?? now) : cacheAt
        return { inst, cache, isRunning, awaitingInput, lastAt }
      })
      .filter((x): x is ActiveInstance => x !== null)
      .sort((a, b) => {
        // Blocked on the user outranks everything: it is the only group that cannot make
        // progress without the user. Oldest block first, since it has been waiting longest.
        const aWait = a.awaitingInput != null
        const bWait = b.awaitingInput != null
        if (aWait !== bWait) return aWait ? -1 : 1
        if (aWait && bWait) return (a.inst.awaitingInputAt ?? 0) - (b.inst.awaitingInputAt ?? 0)
        // Then running, then most-recent cache.
        if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1
        return b.lastAt - a.lastAt
      })
  }, [instances, sessionCosts, cacheTtlMs, now])
}
