import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useUI } from '../context/UIContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useGame } from '../context/GameContext'
import { useFeatureGate } from '../hooks/useFeatureGate'
import { useAgentNames } from '../hooks/useAgentNames'
import { OrcFeed } from './pipeline/OrcFeed'
import { OverdriveFire } from './OverdriveFire'
import { FeatureLockedModal } from './tour/FeatureLockedModal'
import { api } from '../api'
import { fmtNum, fmtUsd, fmtTime, getOdTier, fmtOrcLog } from '../utils/format'
import { TIER_COLORS, TIER_ICONS, ORC_LOG_FILTER_TYPES, ANIMATION_TIERS, SOUND_TIERS } from '@shared/constants'
import { resolveAnimTier, resolveSoundTier } from '../hooks/useVFX'
import { vfxBus } from '../systems/vfx-bus'
import { soundEngine } from '../systems/sound-engine'
import type { SavingsSummary, OrcLogEntry, OrcLogFilter } from '@shared/types'

export function RightSidebar() {
  const { settings, activePipelineId, view, gameActive } = useUI()
  const { instances, folders } = useInstances()
  const { dispatch } = useAppDispatch()
  const { profile, currentLevel, nextLevel, xpProgress } = useGame()
  const overdriveGate = useFeatureGate('overdrive')
  const [collapsed, setCollapsed] = useState(false)
  const [orcMode, setOrcMode] = useState(false)
  const [savings, setSavings] = useState<SavingsSummary | null>(null)
  const [showShutdown, setShowShutdown] = useState(false)
  const [orcLogs, setOrcLogs] = useState<OrcLogEntry[]>([])
  const [orcFilter, setOrcFilter] = useState<OrcLogFilter>('all')
  const [orcHovered, setOrcHovered] = useState(false)
  const [odAnimPaused, setOdAnimPaused] = useState(() => localStorage.getItem('od-anim-paused') === '1')
  const [liveMultiplier, setLiveMultiplier] = useState<number | null>(null)
  const [showAnimTip, setShowAnimTip] = useState<string | null>(null)
  const [showSoundTip, setShowSoundTip] = useState<string | null>(null)
  const animTipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const soundTipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const orcPovRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (view === 'pipeline') setCollapsed(true)
    else setCollapsed(false)
  }, [view])

  useEffect(() => {
    function load() { api.getSavings(30).then(setSavings).catch(() => {}) }
    load()
    const id = setInterval(load, 5 * 60_000)
    return () => clearInterval(id)
  }, [])

  // Poll last-hour multiplier (lightweight, every 30s)
  useEffect(() => {
    function load() { api.getMultiplier().then(r => setLiveMultiplier(r.multiplier)).catch(() => {}) }
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  // Load initial orc logs + subscribe to live events
  useEffect(() => {
    api.getOrchestratorLogs({ limit: 30 })
      .then(r => setOrcLogs(r.logs.slice(-30).reverse()))
      .catch(() => {})
    const unsub = api.onOrchestratorLog((entry: OrcLogEntry) => {
      setOrcLogs(prev => {
        if (prev.some(l => l.id === entry.id)) return prev
        return [entry, ...prev].slice(0, 50)
      })
    })
    return unsub
  }, [])

  // Auto-scroll orc log to top on new entries (paused on hover)
  useEffect(() => {
    if (!orcHovered && orcPovRef.current) {
      orcPovRef.current.scrollTop = 0
    }
  }, [orcLogs, orcHovered])

  const orcFolderId = activePipelineId
    || folders.find(f => f.orchestratorActive)?.id
    || null
  const activeFolder = orcFolderId ? folders.find(f => f.id === orcFolderId) : null

  const agentNames = useAgentNames()

  const runningOrcAgents = orcFolderId
    ? instances.filter(i => i.orchestratorManaged && i.folderId === orcFolderId && i.state === 'running')
    : []

  const handleGoToBoard = useCallback(() => {
    if (!orcFolderId) return
    dispatch({ type: 'SET_VIEW', payload: 'pipeline' })
    dispatch({ type: 'SET_PIPELINE_PROJECT', projectId: orcFolderId })
  }, [dispatch, orcFolderId])

  const userName = (settings.userName as string | undefined) || 'The Human'
  const userEmoji = (settings.userEmoji as string | undefined) || '🧠'
  const tier = currentLevel?.tier ?? 'Beginner'
  const tierColor = TIER_COLORS[tier] ?? '#10b981'
  const tierIcon = TIER_ICONS[tier] ?? '🌱'

  const activeAgents = instances.filter(i => i.state === 'running').length
  const totalProjects = folders.length

  const handleShutdownConfirm = useCallback(async () => {
    setShowShutdown(false)
    try {
      await api.terminate()
    } catch {
      // Server will be unreachable after terminate — that's expected
    }
  }, [])

  const totalTokensUsed = savings
    ? savings.days.reduce((s, d) => s + d.totalInput + d.totalOutput, 0)
    : 0

  // Multiplier from last-hour actual cache ratio (polled every 30s)
  // 1 / (1 - cacheRatio): 80% cache → 5x, 90% → 10x
  const overdriveMultiplier = liveMultiplier ?? 1

  const odTier = getOdTier(overdriveMultiplier)

  // Track level-up transitions for animations
  const prevTierRef = useRef(odTier.label)
  const [odLevelUpAnim, setOdLevelUpAnim] = useState(false)
  useEffect(() => {
    if (odTier.label !== prevTierRef.current) {
      prevTierRef.current = odTier.label
      setOdLevelUpAnim(true)
      const t = setTimeout(() => setOdLevelUpAnim(false), 1200)
      return () => clearTimeout(t)
    }
  }, [odTier.label])

  const isOnFire = overdriveMultiplier >= 5
  const fireIntensity = isOnFire ? Math.min((overdriveMultiplier - 5) / 5 + 0.3, 1) : 0

  const STATS = [
    { icon: '⚔️', value: fmtNum(profile?.tasksDone ?? 0), label: 'Tasks Done' },
    { icon: '🤖', value: String(activeAgents), label: 'Active' },
    { icon: '📁', value: String(totalProjects), label: 'Projects' },
    { icon: '🔄', value: savings ? fmtNum(savings.totalSessions) : '—', label: 'Sessions' },
    { icon: '📊', value: totalTokensUsed > 0 ? fmtNum(totalTokensUsed) : '—', label: 'Tokens Used' },
    { icon: '💰', value: savings && savings.savedUsd > 0 ? fmtUsd(savings.savedUsd) : '—', label: 'Saved w Cache' },
  ]

  return (
    <aside className={`right-sidebar rs-entrance${collapsed ? ' rs-collapsed' : ''}${overdriveGate.unlocked && overdriveMultiplier > 1 ? ` rs-od-${odTier.label.toLowerCase()}` : ''}${odAnimPaused ? ' od-anim-paused' : ''}`}>
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
            <div style={{ fontFamily: 'var(--font-pixel)', fontSize: 7, color: 'var(--text-tertiary)', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 4 }}>
              The Human
            </div>
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

          {/* ── Stats grid (30d) ── */}
          <div className="rs-section" data-tour-id="tour-stats">
            <div className="rs-section-label" style={{ fontFamily: 'var(--font-pixel)', fontSize: 8 }}>Stats <span style={{ color: 'var(--text-tertiary)', fontSize: 7 }}>(30d)</span></div>
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

          {/* ── Overdrive Multiplier ── */}
          {overdriveGate.unlocked && (() => {
            const barPct = Math.min(((overdriveMultiplier - 1) / 4) * 100, 100)
            const tierClass = `od-meter-${odTier.label.toLowerCase()}`
            return (
              <div className={`rs-section od-meter-section ${tierClass}${odLevelUpAnim ? ' od-meter-levelup' : ''}${isOnFire && !odAnimPaused ? ' od-meter-fire' : ''}${odAnimPaused ? ' od-anim-paused' : ''}`}>
                {/* Fire canvas overlay for 5x+ (hidden when paused) */}
                {isOnFire && !odAnimPaused && (
                  <OverdriveFire intensity={fireIntensity} width={232} height={50} />
                )}

                <div className="od-meter-header">
                  <span className="od-meter-label">
                    Overdrive
                    <span className="rs-overdrive-tip-wrap">
                      <span className="rs-overdrive-tip-icon">?</span>
                      <span className="rs-overdrive-tip">For every $1 you spend, you get ${overdriveMultiplier.toFixed(1)} of work done. Smart caching reuses context at 90% discount. Keep sessions close together to push past 5x and ignite Supernova mode.</span>
                    </span>
                    <button
                      className={`od-eye-btn${odAnimPaused ? ' od-eye-off' : ''}`}
                      onClick={() => {
                        const next = !odAnimPaused
                        setOdAnimPaused(next)
                        localStorage.setItem('od-anim-paused', next ? '1' : '0')
                      }}
                      title={odAnimPaused ? 'Enable animations' : 'Disable animations'}
                    >
                      {odAnimPaused ? '\u25C9' : '\u25CE'}
                    </button>
                  </span>
                  <span className={`od-meter-value${odLevelUpAnim ? ' od-value-pop' : ''}`} style={{ color: odTier.color }}>
                    {overdriveMultiplier.toFixed(1)}x
                  </span>
                </div>

                {/* Tier label */}
                <div className="od-meter-tier" style={{ color: odTier.color }}>
                  {odTier.label}
                </div>

                {/* Scale bar with touchpoints */}
                <div className="od-meter-track">
                  <div
                    className={`od-meter-fill${isOnFire ? ' od-fill-fire' : ''}`}
                    style={{
                      width: `${barPct}%`,
                      background: isOnFire
                        ? `linear-gradient(90deg, ${odTier.color}, #ff6b2b, #fbbf24)`
                        : odTier.color,
                    }}
                  />
                  {/* Touchpoints: 1x, 2x, 3x, 4x, 5x */}
                  {[1, 2, 3, 4, 5].map(n => (
                    <span
                      key={n}
                      className="od-meter-mark"
                      style={{ left: `${((n - 1) / 4) * 100}%` }}
                    >
                      <span className={`od-meter-mark-label${overdriveMultiplier >= n ? ' od-mark-active' : ''}`}>{n}x</span>
                    </span>
                  ))}
                </div>
              </div>
            )
          })()}
          {!overdriveGate.unlocked && (
            <div
              className="rs-section"
              style={{ cursor: 'pointer', opacity: 0.5 }}
              onClick={() => overdriveGate.check()}
            >
              <div style={{ fontFamily: 'var(--font-pixel)', fontSize: 8, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                {'\uD83D\uDD12'} Overdrive — Lv.{overdriveGate.gate?.level}
              </div>
            </div>
          )}

          {/* ── The Orc POV ── */}
          <div className="rs-section rs-orc-pov-section">
            <div className="rs-section-label" style={{ fontFamily: 'var(--font-pixel)', fontSize: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              The Orc
              <div className="rs-orc-log-filters">
                {(['all', 'errors', 'assignments'] as OrcLogFilter[]).map(f => (
                  <button
                    key={f}
                    className={`rs-orc-filter-btn${orcFilter === f ? ' active' : ''}`}
                    onClick={() => setOrcFilter(f)}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div
              className="rs-orc-log-list"
              ref={orcPovRef}
              onMouseEnter={() => setOrcHovered(true)}
              onMouseLeave={() => setOrcHovered(false)}
            >
              {(() => {
                const filtered = orcFilter === 'all'
                  ? orcLogs
                  : orcLogs.filter(l => ORC_LOG_FILTER_TYPES[orcFilter]?.includes(l.type as string))
                return filtered.length === 0 ? (
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)', padding: '4px 0' }}>
                    {orcFilter === 'all' ? 'No orders yet' : `No ${orcFilter} events`}
                  </div>
                ) : (
                  filtered.map(log => (
                    <div key={log.id} className={`rs-orc-log-entry rs-orc-log-${log.type}`}>
                      <span className="rs-orc-log-time">{fmtTime(log.timestamp)}</span>
                      <span className="rs-orc-log-text">{fmtOrcLog(log)}</span>
                    </div>
                  ))
                )
              })()}
            </div>
          </div>

          {/* ── Footer ── */}
          <div className="rs-footer">
            <button
              className="rs-footer-btn"
              onClick={() => dispatch({ type: 'SET_GAME_ACTIVE', payload: !gameActive })}
              title={gameActive ? 'Switch to Pipeline' : 'Switch to Game'}
            >
              {gameActive ? '🎮' : '📋'}
            </button>
            <span className={`rs-footer-tip-wrap${showAnimTip ? ' rs-tip-active' : ''}`}>
              <span className="rs-footer-tip">Animations: {ANIMATION_TIERS[resolveAnimTier(settings)]?.name ?? 'Peaceful'}</span>
              <button
                className="rs-footer-btn"
                style={{ opacity: resolveAnimTier(settings) === 0 ? 0.4 : 1 }}
                onClick={() => {
                  const cur = resolveAnimTier(settings)
                  const next = (cur + 1) % 5
                  const payload: Record<string, unknown> = { animationTier: next, animationsEnabled: next > 0 }
                  dispatch({ type: 'UPDATE_SETTINGS', payload: payload as any })
                  api.updateSettings(payload as any)
                  vfxBus.fire('tier:preview' as any, { tier: next, previewType: 'animation' } as any)
                  if (animTipTimer.current) clearTimeout(animTipTimer.current)
                  setShowAnimTip(ANIMATION_TIERS[next]?.name ?? 'Peaceful')
                  animTipTimer.current = setTimeout(() => setShowAnimTip(null), 1500)
                }}
              >
                {ANIMATION_TIERS[resolveAnimTier(settings)]?.icon ?? '⏸'}
              </button>
            </span>
            <span className={`rs-footer-tip-wrap${showSoundTip ? ' rs-tip-active' : ''}`}>
              <span className="rs-footer-tip">Sound: {SOUND_TIERS[resolveSoundTier(settings)]?.name ?? 'Peaceful'}</span>
              <button
                className="rs-footer-btn"
                style={{ opacity: resolveSoundTier(settings) === 0 ? 0.4 : 1 }}
                onClick={() => {
                  const cur = resolveSoundTier(settings)
                  const next = (cur + 1) % 5
                  const payload: Record<string, unknown> = { soundTier: next, soundsEnabled: next > 0 }
                  dispatch({ type: 'UPDATE_SETTINGS', payload: payload as any })
                  api.updateSettings(payload as any)
                  if (next === 1) soundEngine.play('uiClick')
                  else if (next === 2) { soundEngine.play('spawn'); setTimeout(() => soundEngine.play('taskComplete'), 300) }
                  else if (next === 3) soundEngine.play('levelUpFanfare')
                  else if (next === 4) { soundEngine.play('levelUpFanfare'); soundEngine.startDrone(); setTimeout(() => soundEngine.stopDrone(), 2000) }
                  if (soundTipTimer.current) clearTimeout(soundTipTimer.current)
                  setShowSoundTip(SOUND_TIERS[next]?.name ?? 'Peaceful')
                  soundTipTimer.current = setTimeout(() => setShowSoundTip(null), 1500)
                }}
              >
                {SOUND_TIERS[resolveSoundTier(settings)]?.icon ?? '🔇'}
              </button>
            </span>
            <button className="rs-footer-btn" data-tour-id="tour-settings" onClick={() => dispatch({ type: 'OPEN_SETTINGS' })} title="Settings">
              ⚙
            </button>
            <button
              className="rs-footer-btn rs-shutdown-btn"
              onClick={() => setShowShutdown(true)}
              title="Shutdown"
            >
              ⏻
            </button>
          </div>
        </>
      )}

      {showShutdown && createPortal(
        <div className="modal-overlay" onClick={() => setShowShutdown(false)}>
          <div className="modal-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 380 }}>
            <div className="modal-header">
              <span className="modal-title">Log out and TERMINATE THE SERVER?</span>
              <button className="modal-close" onClick={() => setShowShutdown(false)}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: 8 }}>
                This will kill all sessions and shut down the OrcStrator server process. You will need to restart the server manually.
              </p>
              {activeAgents > 0 && (
                <p style={{ color: 'var(--warning)', fontSize: 13, margin: 0 }}>
                  ⚠ {activeAgents} agent{activeAgents !== 1 ? 's are' : ' is'} currently running.
                </p>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowShutdown(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleShutdownConfirm}>Terminate Server</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {overdriveGate.showLockedModal && overdriveGate.gate && (
        <FeatureLockedModal gate={overdriveGate.gate} onClose={overdriveGate.dismissModal} />
      )}
    </aside>
  )
}
