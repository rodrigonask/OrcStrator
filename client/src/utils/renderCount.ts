import { useLayoutEffect } from 'react'

// Dev-only render counter. Counts COMMITS, not render calls: a layout effect with
// no dependency list runs once per committed render, so StrictMode's double render call does
// not inflate the number. The counts live on window.__orcRenders for a measuring script to
// read and reset. Production builds compile the body away (import.meta.env.DEV is false).
export function useRenderCount(name: string): void {
  useLayoutEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as unknown as { __orcRenders?: Record<string, number> }
    const counts = (w.__orcRenders ??= {})
    counts[name] = (counts[name] ?? 0) + 1
  })
}
