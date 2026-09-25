import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../api'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import type { SessionFile } from '@shared/types'

const PAGE_SIZE = 50

const selectStyle: React.CSSProperties = {
  background: 'var(--bg-tertiary)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '3px 6px',
  fontSize: 11,
  cursor: 'pointer',
  maxWidth: 260,
}

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

function formatSize(bytes?: number): string {
  if (!bytes) return ''
  const mb = bytes / 1048576
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function SessionsPage() {
  const { instances } = useInstances()
  const { dispatch, addToGrid } = useAppDispatch()
  const [sessions, setSessions] = useState<SessionFile[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  // Most sub-agent runs are noise, roughly one file in nine, and none of them are
  // chats you opened, so they stay off unless asked for.
  const [showSubagents, setShowSubagents] = useState(false)
  const [project, setProject] = useState('')
  const [linked, setLinked] = useState('')
  const [days, setDays] = useState(0)
  const [sort, setSort] = useState('recent')
  const [projects, setProjects] = useState<Array<{ slug: string; label: string; emoji?: string; known: boolean; count: number }>>([])
  const [summaryRequested, setSummaryRequested] = useState<Record<string, string>>({})
  const [statsLoading, setStatsLoading] = useState<Record<string, boolean>>({})
  const [statsData, setStatsData] = useState<Record<string, { inputTokens: number; outputTokens: number; costUsd: number; lineCount: number }>>({})
  const [resuming, setResuming] = useState<string | null>(null)
  const [rowError, setRowError] = useState<Record<string, string>>({})

  // One page at a time. The full list here is thousands of files; rendering all of them
  // is what made this page cost hundreds of MB of browser memory.
  // Every filter is a server-side query param, so switching one costs a 50-row page,
  // never the whole list.
  const filters = { subagents: showSubagents, project, linked, days, sort }

  const fetchPage = useCallback(async (q: string, f: typeof filters) => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.getSessions({ limit: PAGE_SIZE, offset: 0, q: q || undefined, ...f })
      setSessions(data.sessions)
      setTotal(data.total)
      setHasMore(data.hasMore)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMore = useCallback(async () => {
    setLoadingMore(true)
    try {
      const data = await api.getSessions({ limit: PAGE_SIZE, offset: sessions.length, q: query || undefined, ...filters })
      setSessions(prev => [...prev, ...data.sessions])
      setTotal(data.total)
      setHasMore(data.hasMore)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoadingMore(false)
    }
  }, [sessions.length, query, showSubagents, project, linked, days, sort])

  // Debounce the search box so typing doesn't fire a scan per keystroke
  const debounceRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => setQuery(search.trim()), 300)
    return () => window.clearTimeout(debounceRef.current)
  }, [search])

  // Any filter change re-fetches from offset 0 — a filtered page never mixes with the
  // previous one's rows.
  useEffect(() => {
    fetchPage(query, { subagents: showSubagents, project, linked, days, sort })
  }, [fetchPage, query, showSubagents, project, linked, days, sort])

  // Project list for the dropdown; counts follow the sub-agent toggle so they match the list.
  useEffect(() => {
    api.getSessionProjects(showSubagents)
      .then(r => setProjects(r.projects))
      .catch(() => setProjects([]))
  }, [showSubagents])

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

  // Open the chat that owns this session, creating one bound to it if there isn't one.
  // The next message sent from that chat resumes the session where it left off.
  const openInGrid = (instanceId: string) => {
    addToGrid(instanceId)
    dispatch({ type: 'SET_VIEW', payload: 'grid' })
  }

  const handleResume = async (session: SessionFile) => {
    if (session.instanceId) { openInGrid(session.instanceId); return }
    setResuming(session.sessionId)
    setRowError(prev => ({ ...prev, [session.sessionId]: '' }))
    try {
      const res = await api.resumeSession(session.sessionId)
      openInGrid(res.instanceId)
    } catch (err) {
      setRowError(prev => ({ ...prev, [session.sessionId]: (err as Error).message }))
    } finally {
      setResuming(null)
    }
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900, margin: '0 auto', overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12 }}>
        <h2 className="font-pixel" style={{ fontSize: 14, margin: 0, flexShrink: 0 }}>Session Files</h2>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by id, chat or project..."
          className="font-mono"
          style={{
            flex: 1,
            minWidth: 0,
            background: 'var(--bg-tertiary)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 11,
          }}
        />
        <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-dim)', width: 120, textAlign: 'right', flexShrink: 0 }}>
          {loading ? 'scanning...' : `${sessions.length} of ${total.toLocaleString()}`}
        </span>
        <button
          className="add-folder-btn"
          onClick={() => fetchPage(query, filters)}
          disabled={loading}
          style={{ padding: '4px 12px', flexShrink: 0 }}
        >
          <span className="font-mono" style={{ fontSize: 11 }}>Refresh</span>
        </button>
      </div>

      <div className="font-mono" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16, fontSize: 11 }}>
        <select value={project} onChange={e => setProject(e.target.value)} style={selectStyle} title="Project">
          <option value="">All projects</option>
          {projects.map(p => (
            <option key={p.slug} value={p.slug}>
              {`${p.emoji ? p.emoji + ' ' : ''}${p.label} (${p.count})`}
            </option>
          ))}
        </select>

        <select value={sort} onChange={e => setSort(e.target.value)} style={selectStyle} title="Sort">
          <option value="recent">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="largest">Largest first</option>
          <option value="smallest">Smallest first</option>
        </select>

        <select value={days} onChange={e => setDays(Number(e.target.value))} style={selectStyle} title="Last touched">
          <option value={0}>Any time</option>
          <option value={1}>Last 24h</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
        </select>

        <select value={linked} onChange={e => setLinked(e.target.value)} style={selectStyle} title="Chat">
          <option value="">Open or not</option>
          <option value="chat">Already in a chat</option>
          <option value="orphan">Not in a chat</option>
        </select>

        <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: showSubagents ? 'var(--text)' : 'var(--text-dim)' }}>
          <input type="checkbox" checked={showSubagents} onChange={e => setShowSubagents(e.target.checked)} style={{ cursor: 'pointer' }} />
          Sub-agents
        </label>

        {(project || linked || days || sort !== 'recent' || showSubagents || query) && (
          <button
            className="add-folder-btn"
            onClick={() => { setProject(''); setLinked(''); setDays(0); setSort('recent'); setShowSubagents(false); setSearch('') }}
            style={{ padding: '2px 8px', fontSize: 10 }}
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          {error}
        </div>
      )}

      {!loading && sessions.length === 0 && !error && (
        <div style={{ color: 'var(--text-dim)', fontSize: 12, fontFamily: 'var(--font-mono)', padding: '40px 0', textAlign: 'center' }}>
          {query ? `No sessions match "${query}"`
            : (project || linked || days) ? 'No sessions match these filters'
            : 'No .jsonl session files found in ~/.claude/projects/'}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sessions.map(session => {
          const stats = statsData[session.sessionId]
          const requested = summaryRequested[session.sessionId]
          const failed = rowError[session.sessionId]
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
                    {!session.folderName && session.project && (
                      <span style={{ color: 'var(--text-dim)' }}>{session.project}</span>
                    )}
                    {session.isSubagent && (
                      <span
                        title={session.parentSessionId ? `Spawned by ${session.parentSessionId}` : 'Sub-agent run'}
                        style={{
                          fontSize: 9,
                          padding: '1px 5px',
                          borderRadius: 3,
                          border: '1px solid var(--border)',
                          color: 'var(--text-dim)',
                        }}
                      >
                        sub-agent
                      </span>
                    )}
                  </div>
                  <div style={{ color: 'var(--text-dim)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {session.sessionId}
                    {session.sizeBytes ? <span style={{ marginLeft: 8 }}>{formatSize(session.sizeBytes)}</span> : null}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <span style={{ color: 'var(--text-dim)', fontSize: 11, width: 62, textAlign: 'right' }}>{formatAge(session.mtime)}</span>
                  {session.isSubagent ? (
                    // A sub-agent transcript is not a resumable session — keep the column
                    // width so rows don't jump.
                    <span style={{ width: 64, textAlign: 'center', fontSize: 10, color: 'var(--text-dim)' }}>-</span>
                  ) : (
                    <button
                      className="add-folder-btn"
                      onClick={() => handleResume(session)}
                      disabled={resuming === session.sessionId}
                      title={session.instanceId
                        ? 'Open the chat that owns this session'
                        : 'Open this session in a chat — your next message continues it'}
                      style={{ padding: '2px 8px', fontSize: 10, width: 64 }}
                    >
                      {resuming === session.sessionId ? '...' : session.instanceId ? 'Open' : 'Resume'}
                    </button>
                  )}
                  {!stats && (
                    <button
                      className="add-folder-btn"
                      onClick={() => handleLoadStats(session.sessionId)}
                      disabled={statsLoading[session.sessionId]}
                      style={{ padding: '2px 8px', fontSize: 10, width: 52 }}
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
              {failed && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--danger)' }}>{failed}</div>
              )}
              {stats && (
                <div style={{ marginTop: 6, display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-dim)' }}>
                  <span>{stats.lineCount.toLocaleString()} lines</span>
                  <span>{stats.inputTokens.toLocaleString()} in (incl. cache)</span>
                  <span>{stats.outputTokens.toLocaleString()} out</span>
                  {stats.costUsd > 0 && <span>${stats.costUsd.toFixed(4)}</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
          <button className="add-folder-btn" onClick={loadMore} disabled={loadingMore} style={{ padding: '4px 16px' }}>
            <span className="font-mono" style={{ fontSize: 11 }}>
              {loadingMore ? 'Loading...' : `Load ${Math.min(PAGE_SIZE, total - sessions.length)} more`}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
