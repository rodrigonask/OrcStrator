import { useCallback, useEffect } from 'react'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'

/**
 * Ultra Compact Mode: one switch, every density change at once.
 *
 * Everything it does is CSS hung off `data-ultra` on <html> plus two component swaps
 * (the horizontal top bar becomes the vertical rail, and the task panel collapses to its
 * live row). Deliberately a single boolean rather than a family of sub-settings: the
 * point of the mode is that you flip it when the grid gets crowded and flip it back when
 * it doesn't, not that you tune eight numbers.
 *
 * Optimistic: the reducer flips first so the whole layout re-renders on the same frame as
 * the click, and the PUT follows. A failed write only costs the persistence, not the mode.
 */
export function useUltraCompact(): { on: boolean; toggle: () => void } {
  const { settings } = useUI()
  const { dispatch } = useAppDispatch()
  const on = settings.ultraCompact === true

  const toggle = useCallback(() => {
    const next = !on
    dispatch({ type: 'UPDATE_SETTINGS', payload: { ultraCompact: next } })
    api.updateSettings({ ultraCompact: next }).catch(err => {
      console.error('Could not save Ultra Compact Mode:', err)
    })
  }, [on, dispatch])

  return { on, toggle }
}

/**
 * Ctrl+Shift+U, from anywhere.
 *
 * The rail is the primary way out and it never hides, so this is the belt to its braces.
 * It deliberately does NOT bail out when the event came from a textarea: being mid-reply
 * in a tile is exactly when you notice you want the space back, and no editor shortcut in
 * this app claims Ctrl+Shift+U.
 */
export function useUltraCompactHotkey(toggle: () => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return
      if (e.key.toLowerCase() !== 'u') return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggle])
}
