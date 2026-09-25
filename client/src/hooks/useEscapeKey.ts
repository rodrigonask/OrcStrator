import { useEffect, useRef } from 'react'

/**
 * Calls `onEscape` when the Escape key is pressed.
 * Pass `active = false` to temporarily disable (e.g. while an async op is in flight).
 * The latest callback is always used (ref-based), so callers don't need useCallback.
 */
export function useEscapeKey(onEscape: () => void, active = true) {
  const cbRef = useRef(onEscape)
  cbRef.current = onEscape

  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cbRef.current()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [active])
}
