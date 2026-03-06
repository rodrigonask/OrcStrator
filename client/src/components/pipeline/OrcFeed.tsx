import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { useInstances } from '../../context/InstancesContext'

interface FeedEntry {
  id: string
  timestamp: number
  text: string
  type: 'assign' | 'release' | 'move' | 'status'
}

export function OrcFeed({ folderId }: { folderId: string }) {
  const { instances } = useInstances()
  const [entries, setEntries] = useState<FeedEntry[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  function addEntry(entry: Omit<FeedEntry, 'id' | 'timestamp'>) {
    const newEntry = { ...entry, id: crypto.randomUUID(), timestamp: Date.now() }
    setEntries(prev => [...prev.slice(-49), newEntry])
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }

  useEffect(() => {
    const unsub1 = api.onOrchestratorAssigned((p: any) => {
      if (p.folderId !== folderId) return
      const instanceName = instances.find(i => i.id === p.instanceId)?.name ?? p.instanceId.slice(0, 6)
      addEntry({ type: 'assign', text: `Assigned "${p.taskTitle}" to ${instanceName}` })
    })

    const unsub2 = api.onOrchestratorLockReleased((p: any) => {
      addEntry({ type: 'release', text: `Released lock on task (${p.reason})` })
    })

    return () => { unsub1(); unsub2() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId])

  const fmt = (ts: number) => {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
  }

  return (
    <div className="orc-feed">
      <div className="orc-feed-header">
        <span className="orc-feed-title">The Orc</span>
        <span className="orc-feed-subtitle">Live activity</span>
      </div>
      <div className="orc-feed-list">
        {entries.length === 0 && (
          <div className="orc-feed-empty">Watching for activity...</div>
        )}
        {entries.map(e => (
          <div key={e.id} className={`orc-feed-entry orc-feed-${e.type}`}>
            <span className="orc-feed-time">{fmt(e.timestamp)}</span>
            <span className="orc-feed-text">{e.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
