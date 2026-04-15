import { useState, useCallback, useEffect } from 'react'

const STORAGE_KEY = 'orcstrator.pinnedChats'

let listeners: Array<() => void> = []

function notify() {
  listeners.forEach(fn => fn())
}

function readPinned(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch {
    return []
  }
}

export function usePinnedChats() {
  const [pinnedIds, setPinnedIds] = useState<string[]>(readPinned)

  // Sync across hook instances (e.g. Sidebar + InstanceItem)
  useEffect(() => {
    const sync = () => setPinnedIds(readPinned())
    listeners.push(sync)
    return () => { listeners = listeners.filter(l => l !== sync) }
  }, [])

  const pin = useCallback((id: string) => {
    const current = readPinned()
    if (!current.includes(id)) {
      const next = [id, ...current]
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      setPinnedIds(next)
      notify()
    }
  }, [])

  const unpin = useCallback((id: string) => {
    const current = readPinned()
    const next = current.filter(x => x !== id)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setPinnedIds(next)
    notify()
  }, [])

  const isPinned = useCallback((id: string) => pinnedIds.includes(id), [pinnedIds])

  return { pinnedIds, pin, unpin, isPinned }
}
