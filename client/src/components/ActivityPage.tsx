import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useInstances } from '../context/InstancesContext'
import { useOpenInstance } from '../hooks/useOpenInstance'
import { formatInstant } from '@shared/routine-schedule'
import type { ActivityEntry } from '@shared/types'

// Task Activity: every scheduled fire (a card run or a wake-up) in one list, newest first.
//
// The grid already shows a scheduled run the moment it fires, so this is not where you
// WATCH runs. It is where you FIND them afterwards, and above all it is the one place a
// SILENT card's runs can be found at all, since silence means the grid never shows
// them. A row opens its chat through the same hook the top bar and the rail use.
//
// `kind === 'routine'` below is NOT a leftover. The routines table is gone and a schedule
// is now a field on a pipeline card, but the token still means "the scheduler started this
// turn" and is load-bearing across surface.ts and turn-origins.ts. Only the words the user
// reads changed.

function fmtDuration(start: number, end: number | null): string {
  if (!end) return ''
  const s = Math.max(0, Math.round((end - start) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function statusLabel(e: ActivityEntry): string {
  if (e.kind === 'wakeup') {
    return e.status === 'pending' ? 'armed' : e.status
  }
  // "interrupted" is accurate and also nine characters of jargon in a status column. What
  // the reader needs is that nothing went wrong with the card: the app restarted underneath
  // it. Same fact, said the way it would be said out loud.
  if (e.status === 'interrupted') return 'stopped by a restart'
  return e.status
}

export function ActivityPage() {
  const { instances, folders } = useInstances()
  const openInstance = useOpenInstance()
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api.getActivity(150)
      .then(r => { setEntries(r.entries); setError(null) })
      .catch(err => setError((err as Error).message))
  }, [])

  // Load once, then re-read on every event that changes a row. The list is small and
  // the events are rare, so a full re-read is simpler and safer than patching rows.
  useEffect(() => {
    load()
    const unsubs = ['task:run-started', 'task:run-finished', 'wakeup:scheduled', 'wakeup:fired', 'wakeup:cancelled']
      .map(ev => api.onEvent(ev, () => load()))
    return () => { unsubs.forEach(u => u()) }
  }, [load])

  const open = useCallback((e: ActivityEntry) => {
    if (!e.instanceId) return
    const inst = instances.find(i => i.id === e.instanceId)
    if (inst) openInstance(inst)
  }, [instances, openInstance])

  return (
    <div className="activity-page">
      <div className="activity-header">
        <span className="activity-title">Task Activity</span>
        <span className="activity-sub">Every scheduled run and wake-up, newest first. Silent runs live here too.</span>
      </div>
      {error && <div className="activity-empty">Could not load activity: {error}</div>}
      {entries && entries.length === 0 && <div className="activity-empty">Nothing has fired yet.</div>}
      {entries && entries.length > 0 && (
        <div className="activity-list">
          {entries.map(e => {
            const chatGone = !!e.instanceId && !instances.some(i => i.id === e.instanceId)
            // Same "project · chat" prefix the tile header uses: a chat name alone is not
            // findable across a dozen client projects.
            const folder = e.folderId ? folders.find(f => f.id === e.folderId) : undefined
            const folderName = folder ? (folder.displayName || folder.name) : ''
            const chatLabel = e.instanceName
              ? (folderName ? `${folderName} · ${e.instanceName}` : e.instanceName)
              : (chatGone ? 'chat closed' : folderName)
            return (
              <div
                key={`${e.kind}:${e.id}`}
                className={`activity-row activity-${e.kind} status-${e.status}${e.instanceId && !chatGone ? ' is-openable' : ''}`}
                onClick={() => open(e)}
                title={e.instanceId && !chatGone ? 'Open this chat' : undefined}
              >
                <span className="activity-when">{formatInstant(e.startedAt)}</span>
                {/* The class keeps the `kind` token (the CSS and the data agree on it);
                    only the label reads as what it now is, a card the scheduler fired. */}
                <span className={`activity-kind kind-${e.kind}`}>{e.kind === 'routine' ? 'scheduled' : 'wake-up'}</span>
                <span className="activity-name">{e.name}</span>
                <span className="activity-chat" title={chatLabel}>{chatLabel}</span>
                <span className={`activity-status status-${e.status}`}>{statusLabel(e)}</span>
                <span className="activity-flag">
                  {e.silent && <span className="activity-silent" title="Silent card: its runs never surface in the grid">silent</span>}
                </span>
                <span className="activity-meta">
                  {e.kind === 'routine' && e.finishedAt ? fmtDuration(e.startedAt, e.finishedAt) : ''}
                  {e.kind === 'routine' && e.costUsd > 0 ? ` · $${e.costUsd.toFixed(2)}` : ''}
                </span>
                {e.error && <span className="activity-error">{e.error}</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
