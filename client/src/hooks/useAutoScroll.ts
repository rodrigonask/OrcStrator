import { useRef, useEffect, useCallback } from 'react'

/**
 * Auto-scrolls a container to the bottom when new content arrives,
 * unless the user has scrolled up. Returns a ref to attach to the
 * scrollable container element.
 */
export function useAutoScroll<T extends HTMLElement = HTMLDivElement>(
  deps: unknown[] = []
): React.RefObject<T | null> {
  const containerRef = useRef<T | null>(null)
  const userScrolledUp = useRef(false)
  const lastScrollTop = useRef(0)

  // Track whether user has scrolled away from bottom
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      // Consider "at bottom" if within 80px of the bottom
      const atBottom = distanceFromBottom < 80

      // Detect upward scroll
      if (scrollTop < lastScrollTop.current && !atBottom) {
        userScrolledUp.current = true
      }

      // Reset when user scrolls back to bottom
      if (atBottom) {
        userScrolledUp.current = false
      }

      lastScrollTop.current = scrollTop
    }

    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  // Scroll to bottom when deps change (new messages, streaming content)
  useEffect(() => {
    const el = containerRef.current
    if (!el || userScrolledUp.current) return

    el.scrollTop = el.scrollHeight
  }, deps)

  return containerRef
}
