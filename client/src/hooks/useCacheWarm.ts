import { useEffect, useReducer } from 'react'
import type { SessionCostState } from '@shared/types'
import { useUI } from '../context/UIContext'
import { useSessionCost } from '../context/LiveStatsContext'

/**
 * The one test for "this chat's prompt cache is still alive", kept as a plain function so
 * callers that only need the answer at a single moment (a click, a confirm) can ask without
 * subscribing to the 30s tick the hook installs.
 *
 * A chat counts as warm only if it has actually read from cache at least once and the last
 * cache write is still inside the TTL (1h by default, 5min when the 1h cache is off).
 */
export function isCacheWarm(sc: SessionCostState | undefined, promptCache1h?: boolean): boolean {
  if (!sc || sc.totalCacheRead <= 0 || sc.lastCacheCreatedAt == null) return false
  const ttlMs = promptCache1h !== false ? 3_600_000 : 300_000
  return Date.now() < sc.lastCacheCreatedAt + ttlMs
}

/**
 * Is this chat's prompt cache still alive?
 *
 * The same test useActiveInstances runs for the rail dots, narrowed to one instance so a
 * grid tile can ask about itself without computing the whole list nine times over. Both
 * read the TTL from settings (1h by default, 5min when the 1h cache is off), so the two
 * can never disagree about what "warm" means.
 *
 * It matters visually because "finished ten seconds ago" and "untouched for ten days" are
 * not the same chat. The first still holds its context and answers instantly; the second
 * pays a full cold start. Ultra Compact greys the cold ones and leaves the warm ones in
 * colour, so the grid separates alive from dead rather than running from not-running.
 *
 * Ticks on its own every 30s: warmth expires with the clock, not with a state change, and
 * nothing else would re-render the tile at the moment it goes cold.
 */
export function useCacheWarm(instanceId: string): boolean {
  const { settings } = useUI()
  const sessionCost = useSessionCost(instanceId)
  const [, tick] = useReducer(x => x + 1, 0)
  useEffect(() => {
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [])

  return isCacheWarm(sessionCost, settings.promptCache1h)
}
