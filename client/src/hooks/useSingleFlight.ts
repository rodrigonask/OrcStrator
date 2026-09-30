import { useCallback, useRef } from 'react'

/**
 * Wrap an async action so a second call while the first is still running is ignored.
 *
 * A `saving` state flag is not enough: two Enter presses land in the same tick, before React has
 * re-rendered, so both handlers read `saving === false` and the card is created twice. For a
 * scheduled card that is two runs. The guard here is a plain variable, set synchronously.
 */
export function singleFlight<A extends unknown[]>(run: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  let busy = false
  return async (...args: A) => {
    if (busy) return
    busy = true
    try { await run(...args) } finally { busy = false }
  }
}

/** The hook form: stable across renders, always runs the latest `fn`. */
export function useSingleFlight<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  const latest = useRef(fn)
  latest.current = fn
  const guarded = useRef<((...args: A) => Promise<void>) | null>(null)
  if (!guarded.current) guarded.current = singleFlight((...args: A) => latest.current(...args))
  return useCallback((...args: A) => guarded.current!(...args), [])
}
