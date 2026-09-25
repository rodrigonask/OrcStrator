import { useRef, useEffect } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * Traps keyboard focus within the referenced element (e.g., a modal).
 * On mount, focuses the first focusable child. Tab/Shift+Tab wrap
 * around within the container. Returns a ref to attach to the trap
 * container.
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  active = true
): React.RefObject<T | null> {
  const containerRef = useRef<T | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return

    const el = containerRef.current
    if (!el) return

    // Store currently focused element to restore on cleanup
    previouslyFocused.current = document.activeElement as HTMLElement | null

    // Focus the first focusable element inside the trap
    const focusableElements = el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    if (focusableElements.length > 0) {
      focusableElements[0].focus()
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return

      const focusables = el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (focusables.length === 0) return

      const first = focusables[0]
      const last = focusables[focusables.length - 1]

      if (e.shiftKey) {
        // Shift+Tab: wrap from first to last
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        // Tab: wrap from last to first
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    el.addEventListener('keydown', handleKeyDown)

    return () => {
      el.removeEventListener('keydown', handleKeyDown)
      // Restore focus to previously focused element
      previouslyFocused.current?.focus()
    }
  }, [active])

  return containerRef
}
