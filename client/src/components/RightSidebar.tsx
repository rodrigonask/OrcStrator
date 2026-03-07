import { useState, useCallback, useEffect } from 'react'
import { useUI } from '../context/UIContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useGame } from '../context/GameContext'
import { OrcFeed } from './pipeline/OrcFeed'
import { api } from '../api'
import type { SavingsSummary } from '@shared/types'

const TIER_COLORS: Record<string, string> = {
  Beginner: '#10b981',
  Intermediate: '#3b82f6',
  Advanced: '#8b5cf6',
  Elite: '#f59e0b',
  Mythic: '#ef4444',
  Cosmic: '#ec4899',
}

const TIER_ICONS: Record<string, string> = {
  Beginner: '🌱',
  Intermediate: '🔥',
  Advanced: '⚡',
  Elite: '👑',
  Mythic: '🏛',
  Cosmic: '🌌',
}

const ROLE_COLORS: Record<string, string> = {
  planner: 'var(--role-planner)',
  builder: 'var(--role-builder)',
  tester: 'var(--role-tester)',
  promoter: 'var(--role-promoter)',
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}


export function RightSidebar() {
  const { settings, usage, activePipelineId, view } = useUI()
  const { instances, folders } = useInstances()
  const { dispatch } = useAppDispatch()
  const { profile, currentLevel, nextLevel, xpProgress } = useGame()
  const [collapsed, setCollapsed] = useState(false)
  const [orcMode, setOrcMode] = useState(false)
  const [savings, setSavings] = useState<SavingsSummary | null>(null)
  const [showShutdown, setShowShutdown] = useState(false)

  useEffect(() => {
    if (view === 'pipeline') setCollapsed(true)
    else setCollapsed(false)
  }, [view])

  useEffect(() => {
    function load() { api.getSavings(7).then(setSavings).catch(() => {}) }
    load()
    const id = setInterval(load, 5 * 60_000)
    return () => clearInterval(id)
  }, [])

  const orcFolderId = activePipelineId
    || folders.find(f => f.orchestratorActive)?.id
    || null
  const activeFolder = orcFolderId ? folders.find(f => f.id === orcFolderId) : null

  const agentNames = settings.orchestratorAgentNames || {
    planner: 'Planner', builder: 'Builder', tester: 'Tester', promoter: 'Promoter',
  }

  const runningOrcAgents = orcFolderId
    ? instances.filter(i => i.orchestratorManaged && i.folderId === orcFolderId && i.state === 'running')
    : []

  const handleGoToBoard = useCallback(() => {
    if (!orcFolderId) return
    dispatch({ type: 'SET_VIEW', payload: 'pipeline' })
    dispatch({ type: 'SET_PIPELINE_PROJECT', projectId: orcFolderId })
  }, [dispatch, orcFolderId])

  const userName = (settings.userName as string | undefined) || 'Nask'
  const userEmoji = (settings.userEmoji as string | undefined) || '🧠'
  const tier = currentLevel?.tier ?? 'Beginner'
  const tierColor = TIER_COLORS[tier] ?? '#10b981'
  const tierIcon = TIER_ICONS[tier] ?? '🌱'

  const runningInstances = instances.filter(i => i.state === 'running')
  const activeAgents = runningInstances.length
  const totalProjects = folders.length

  const handleShutdownConfirm = useCallback(async () => {
    setShowShutdown(false)
    try {
      const result = await api.shutdownAll()
      for (const id of result.instanceIds) {
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates: { state: 'idle', sessionId: undefined } } })
      }
      for (const f of folders) {
        if (f.orchestratorActive) {
          dispatch({ type: 'UPDATE_FOLDER', payload: { id: f.id, updates: { orchestratorActive: false } } })
        }
      }
    } catch (err) {
      console.error('Shutdown failed:', err)
    }
  }, [dispatch, folders])

  const STATS = [
    { icon: '⚔️', value: fmtNum(profile?.tasksDone ?? 0), label: 'Tasks Done' },
    { icon: '🤖', value: String(activeAgents), label: 'Active' },
    { icon: '📁', value: String(totalProjects), label: 'Projects' },
    { icon: '🔄', value: savings ? fmtNum(savings.totalSessions) : '—', label: 'Sessions' },
    { icon: '💾', value: savings ? fmtNum(savings.savedTokens) : '—', label: 'Tkns Saved' },
    { icon: '💰', value: savings && savings.savedUsd > 0 ? `$${savings.savedUsd.toFixed(2)}` : '—', label: 'Est. Saved' },
  ]

  return (
    <aside className={`right-sidebar${collapsed ? ' rs-collapsed' : ''}`}>
      {/* Collapse button */}
      <div className="rs-header-btns">
        <button
          className="rs-collapse-btn"
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
        >
          {collapsed ? '◀' : '▶'}
        </button>
      </div>

      {collapsed ? (
        <div className="rs-collapsed-icons">
          <button className="rs-icon-btn" onClick={() => { setCollapsed(false); setOrcMode(false) }} title="User stats">
            {userEmoji}
          </button>
          <button className="rs-icon-btn rs-icon-sword" onClick={() => { setCollapsed(false); setOrcMode(true) }} title="Orc activity">
            ⚔
          </button>
        </div>
      ) : orcMode ? (
        <div className="rs-orc-pov">
          {!orcFolderId ? (
            <div className="rs-orc-idle" style={{ padding: '16px 12px' }}>No Orc is active right now</div>
          ) : (
            <>
              <div className="rs-orc-header">
                <div className="rs-orc-header-left">
                  <span className="rs-orc-title">The Orc</span>
                  <span className="rs-orc-folder">{activeFolder?.displayName || activeFolder?.name}</span>
                </div>
                <div className="rs-orc-header-right">
                  <button className="rs-orc-board-btn" onClick={handleGoToBoard}>Board</button>
                  <button className="rs-orc-close-btn" onClick={() => setOrcMode(false)} title="Close Orc view">✕</button>
                </div>
              </div>
              <div className="rs-orc-agents">
                {runningOrcAgents.length === 0 ? (
                  <div className="rs-orc-idle">All agents idle</div>
                ) : (
                  runningOrcAgents.map(inst => (
                    <div key={inst.id} className="rs-orc-agent-row">
                      {inst.agentRole && (
                        <span className={`role-pill role-${inst.agentRole} compact`}>
                          {(agentNames as Record<string, string>)[inst.agentRole] || inst.agentRole}
                        </span>
                      )}
                      <span className="rs-orc-agent-name">{inst.name}</span>
                      {inst.activeTaskTitle && (
                        <span className="rs-orc-agent-task">
                          {inst.activeTaskTitle.length > 35 ? inst.activeTaskTitle.slice(0, 35) + '…' : inst.activeTaskTitle}
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
              <OrcFeed folderId={orcFolderId} />
            </>
          )}
        </div>
      ) : (
        <>
          {/* ── Identity card (compact) ── */}
          <div className="rs-identity-card">
            <div className="rs-identity-top">
              <span
                className="rs-avatar-sm"
                style={['Cosmic', 'Mythic', 'Elite'].includes(tier) ? { filter: `drop-shadow(0 0 5px ${tierColor})` } : {}}
              >
                {userEmoji}
              </span>
              <div className="rs-identity-info">
                <div className="rs-name">{userName}</div>
                <div className="rs-identity-meta">
                  <span
                    className="rs-tier-badge"
                    style={{
                      color: tierColor,
                      borderColor: tierColor,
                      fontFamily: 'var(--font-pixel)',
                      fontSize: 7,
                      boxShadow: `0 0 6px ${tierColor}44`,
                    }}
                  >
                    {tierIcon} {tier}
                  </span>
                  <span style={{ fontFamily: 'var(--font-pixel)', fontSize: 8, color: tierColor }}>
                    Lv.{currentLevel?.level ?? 1}
                  </span>
                </div>
              </div>
            </div>
            {/* Thin XP strip */}
            <div className="rs-xp-strip-track">
              <div
                className="rs-xp-strip-fill"
                style={{ width: `${Math.min(xpProgress * 100, 100)}%`, background: tierColor, boxShadow: `0 0 4px ${tierColor}` }}
              />
            </div>
            <div className="rs-xp-strip-label">
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)' }}>
                {profile ? fmtNum(profile.totalXp) : '0'} XP
              </span>
              {nextLevel && profile && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)' }}>
                  {fmtNum(nextLevel.xpRequired - profile.totalXp)} to Lv.{nextLevel.level}
                </span>
              )}
            </div>
          </div>

          {/* ── Live status ── */}
          <div className="rs-section">
            <div className="rs-section-label" style={{ fontFamily: 'var(--font-pixel)', fontSize: 8 }}>Live</div>
            {runningInstances.length === 0 ? (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)', padding: '4px 0' }}>
                All agents idle
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {runningInstances.map(inst => (
                  <div key={inst.id} className="rs-live-row">
                    <span
                      className="rs-live-dot"
                      style={{ color: inst.agentRole ? ROLE_COLORS[inst.agentRole] || 'var(--accent)' : 'var(--success)' }}
                    >●</span>
                    <span className="rs-live-name">{inst.name}</span>
                    {inst.activeTaskTitle && (
                      <span className="rs-live-task">
                        {inst.activeTaskTitle.length > 28 ? inst.activeTaskTitle.slice(0, 28) + '…' : inst.activeTaskTitle}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Stats grid ── */}
          <div className="rs-section">
            <div className="rs-section-label" style={{ fontFamily: 'var(--font-pixel)', fontSize: 8 }}>Stats</div>
            <div className="rs-stats-grid">
              {STATS.map(({ icon, value, label }) => (
                <div key={label} className="rs-stat-card">
                  <div className="rs-stat-icon">{icon}</div>
                  <div className="rs-stat-value" style={{ fontFamily: 'var(--font-pixel)', fontSize: 9 }}>{value}</div>
                  <div className="rs-stat-label" style={{ fontFamily: 'var(--font-mono)' }}>{label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Overdrive Meter ── */}
          {savings && (
            <div className="rs-section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontFamily: 'var(--font-pixel)', fontSize: 8, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  Overdrive
                  <span
                    title="Overdrive measures how often agents hit the Claude prompt cache, reducing token costs. Higher = more efficient."
                    style={{ cursor: 'help', fontSize: 11, opacity: 0.5 }}
                  >ⓘ</span>
                </span>
                <span style={{
                  fontFamily: 'var(--font-pixel)',
                  fontSize: 9,
                  color: savings.overdrivePct >= 70 ? '#f97316'
                       : savings.overdrivePct >= 50 ? '#22c55e'
                       : savings.overdrivePct >= 30 ? '#eab308'
                       : '#60a5fa',
                }}>
                  {Math.round(savings.overdrivePct)}%
                </span>
              </div>
              <div style={{ width: '100%', height: 8, background: 'var(--bg-tertiary)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{
                  width: `${Math.min(savings.overdrivePct, 100)}%`,
                  height: '100%',
                  borderRadius: 4,
                  background: savings.overdrivePct >= 70 ? '#f97316'
                             : savings.overdrivePct >= 50 ? '#22c55e'
                             : savings.overdrivePct >= 30 ? '#eab308'
                             : '#60a5fa',
                  transition: 'width 0.4s ease',
                }} />
              </div>
            </div>
          )}

          {/* ── Usage (OAuth) ── */}
          {usage && usage.buckets.length > 0 && (
            <div className="rs-section">
              <div className="rs-section-label" style={{ fontFamily: 'var(--font-pixel)', fontSize: 8 }}>Usage</div>
              {usage.buckets.map((bucket, i) => {
                const pct = bucket.percentage ?? 0
                const cls = pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : ''
                return (
                  <div key={i} className="rs-usage-row">
                    <div className="rs-usage-labels">
                      <span className="rs-usage-name" style={{ fontFamily: 'var(--font-pixel)', fontSize: 7 }}>{bucket.label}</span>
                      <span className={`rs-usage-pct ${cls}`} style={{ fontFamily: 'var(--font-pixel)', fontSize: 7 }}>{Math.round(pct)}%</span>
                    </div>
                    <div className="rs-usage-track">
                      <div className={`rs-usage-fill ${cls}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                    </div>
                    {bucket.resetCountdown && (
                      <div className="rs-usage-reset">Resets {bucket.resetCountdown}</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* ── Footer ── */}
          <div className="rs-footer">
            <button className="rs-settings-btn" onClick={() => dispatch({ type: 'OPEN_SETTINGS' })} title="Settings">
              ⚙ Settings
            </button>
            <button
              className="rs-shutdown-btn"
              onClick={() => setShowShutdown(true)}
              title="Kill all sessions"
            >
              ⏻
            </button>
          </div>
        </>
      )}

      {showShutdown && (
        <div className="modal-overlay" onClick={() => setShowShutdown(false)}>
          <div className="modal-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 380 }}>
            <div className="modal-header">
              <span className="modal-title">Kill All Sessions</span>
              <button className="modal-close" onClick={() => setShowShutdown(false)}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: 8 }}>
                This will terminate <strong>{instances.length} session{instances.length !== 1 ? 's' : ''}</strong> across all projects.
              </p>
              {activeAgents > 0 && (
                <p style={{ color: 'var(--warning)', fontSize: 13, margin: 0 }}>
                  ⚠ {activeAgents} agent{activeAgents !== 1 ? 's are' : ' is'} currently running.
                </p>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowShutdown(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleShutdownConfirm}>Kill All</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
