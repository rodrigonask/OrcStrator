import { useState, useEffect, useCallback } from 'react'

export type FontSizeOption = 'small' | 'medium' | 'large' | 'giant'

export const FONT_SIZE_ZOOM: Record<FontSizeOption, number> = {
  small: 0.82,
  medium: 1.0,
  large: 1.18,
  giant: 1.38,
}

const STORAGE_KEY = 'orc_font_size'
const SYNC_EVENT = 'orc-font-size-change'

export function useFontSize() {
  const [fontSize, setFontSizeState] = useState<FontSizeOption>(
    () => (localStorage.getItem(STORAGE_KEY) as FontSizeOption) || 'medium'
  )

  const setFontSize = useCallback((size: FontSizeOption) => {
    localStorage.setItem(STORAGE_KEY, size)
    setFontSizeState(size)
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: size }))
  }, [])

  useEffect(() => {
    const handler = (e: Event) => {
      const size = (e as CustomEvent<FontSizeOption>).detail
      setFontSizeState(size)
    }
    window.addEventListener(SYNC_EVENT, handler)
    return () => window.removeEventListener(SYNC_EVENT, handler)
  }, [])

  return { fontSize, setFontSize, zoom: FONT_SIZE_ZOOM[fontSize] }
}
