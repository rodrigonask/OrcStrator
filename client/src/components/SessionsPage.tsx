import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import { useInstances } from '../context/InstancesContext'
import type { SessionFile } from '@shared/types'

function formatAge(mtime: number): string {
  const diff = Date.now() - mtime
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export function SessionsPage() {
  const { instances } = useInstances()
  const [sessions, setSessions] = useState<SessionFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [summaryRequested, setSummaryRequested] = useState<Record<string, string>>({})
  const [statsLoading, setStatsLoading] = useState<Record<string, boolean>>({})
  const [statsData, setStatsData] = useState<Record<string, { inputTokens: number; outputTokens: number; costUsd: number; lineCount: number }>>({})

  const fetchSessions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.getSessions()
      setSessions(data.sessions)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSessions() }, [fetchSessions])

  const idleInstances = instances.filter(i => i.state === 'idle')

  const handleRequestSummary = async (sessionId: string, instanceId: string) => {
    try {
      await api.requestSessionSummary(sessionId, instanceId)
      setSummaryRequested(prev => ({ ...prev, [sessionId]: instanceId }))
    } catch (err) {
      console.error('Failed to request summary:', err)
    }
  }

  const handleLoadStats = async (sessionId: string) => {
    if (statsData[sessionId] || statsLoading[sessionId]) return
    setStatsLoading(prev => ({ ...prev, [sessionId]: true }))
    try {
      const data = await api.getSessionStats(sessionId)
      setStatsData(prev => ({ ...prev, [sessionId]: data }))
    } catch (err) {
      console.error('Failed to load stats:', err)
    } finally {
      setStatsLoading(prev => ({ ...prev, [sessionId]: false }))
    }
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900, margin: '0 auto', overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 className="font-pixel" style={{ fontSize: 14, margin: 0 }}>Session Files</h2>
        <button
          className="add-folder-btn"
          onClick={fetchSessions}
          disabled={loading}
          style={{ padding: '4px 12px' }}
        >
          <span className="font-mono" style={{ fontSize: 11 }}>{loading ? 'Scanning...' : 'Refresh'}</span>
        </button>
      </div>

      {error && (
        <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          {error}
        </div>
      )}

      {!loading && sessions.length === 0 && !error && (
        <div style={{ color: 'var(--text-dim)', fontSize: 12, fontFamily: 'var(--font-mono)', padding: '40px 0', textAlign: 'center' }}>
          No .jsonl session files found in ~/.claude/projects/
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sessions.map(session => {
          const stats = statsData[session.sessionId]
          const requested = summaryRequested[session.sessionId]
          return (
            <div
              key={session.sessionId}
              style={{
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '10px 14px',
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    {session.folderEmoji && <span>{session.folderEmoji}</span>}
                    {session.folderName && (
                      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{session.folderName}</span>
                    )}
                    {session.instanceName && (
                      <span style={{ color: 'var(--text-dim)' }}>{session.instanceName}</span>
                    )}
                  </div>
                  <div style={{ color: 'var(--text-dim)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {session.sessionId}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{formatAge(session.mtime)}</span>
                  {!stats && (
                    <button
                      className="add-folder-btn"
                      onClick={() => handleLoadStats(session.sessionId)}
                      disabled={statsLoading[session.sessionId]}
                      style={{ padding: '2px 8px', fontSize: 10 }}
                    >
                      {statsLoading[session.sessionId] ? '...' : 'Stats'}
                    </button>
                  )}
                  {idleInstances.length > 0 && !requested && (
                    <select
                      style={{
                        background: 'var(--bg-tertiary)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        padding: '2px 4px',
                        fontSize: 10,
                        cursor: 'pointer',
                      }}
                      defaultValue=""
                      onChange={e => {
                        if (e.target.value) handleRequestSummary(session.sessionId, e.target.value)
                      }}
                    >
                      <option value="" disabled>Summarize via...</option>
                      {idleInstances.map(inst => (
                        <option key={inst.id} value={inst.id}>{inst.name}</option>
                      ))}
                    </select>
                  )}
                  {requested && (
                    <span style={{ color: 'var(--success)', fontSize: 10 }}>Sent</span>
                  )}
                </div>
              </div>
              {stats && (
                <div style={{ marginTop: 6, display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-dim)' }}>
                  <span>{stats.lineCount.toLocaleString()} lines</span>
                  <span>{stats.inputTokens.toLocaleString()} in</span>
                  <span>{stats.outputTokens.toLocaleString()} out</span>
                  {stats.costUsd > 0 && <span>${stats.costUsd.toFixed(4)}</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
