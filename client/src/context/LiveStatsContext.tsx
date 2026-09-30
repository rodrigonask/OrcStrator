import { createContext } from 'react'
import type { UsageData, SessionCostState } from '@shared/types'
import { createStore, useStoreSelector, type Store } from './store'

/**
 * The two UI values that tick on their own: plan usage (polled) and per-chat session cost
 * (every turn, every cache touch). They used to live in UIContext, whose value then changed on
 * each tick and re-rendered every consumer of the UI context, which is every Grid tile.
 * Here they are a store with per-chat selectors, like messages and instances.
 */
export interface LiveStatsValue {
  usage: UsageData | null
  sessionCosts: Record<string, SessionCostState>
}

export type LiveStatsStore = Store<LiveStatsValue>

export function createLiveStatsStore(initial: LiveStatsValue = { usage: null, sessionCosts: {} }): LiveStatsStore {
  return createStore(initial)
}

export const LiveStatsContext = createContext<LiveStatsStore>(createLiveStatsStore())

export function useUsage(): UsageData | null {
  return useStoreSelector(LiveStatsContext, s => s.usage)
}

/** One chat's session cost. Re-renders only when that chat's entry changes. */
export function useSessionCost(instanceId: string | null | undefined): SessionCostState | undefined {
  return useStoreSelector(LiveStatsContext, s => (instanceId ? s.sessionCosts[instanceId] : undefined))
}

/** Every chat's session cost. For components that exist once (the top bar's active list). */
export function useSessionCosts(): Record<string, SessionCostState> {
  return useStoreSelector(LiveStatsContext, s => s.sessionCosts)
}
