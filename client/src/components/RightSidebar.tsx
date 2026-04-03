import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useUI } from '../context/UIContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useAgentNames } from '../hooks/useAgentNames'
import { OrcFeed } from './pipeline/OrcFeed'
import { api } from '../api'
import { fmtUsd, fmtTime, fmtOrcLog } from '../utils/format'
import { ORC_LOG_FILTER_TYPES, ANIMATION_TIERS, SOUND_TIERS } from '@shared/constants'
import { resolveAnimTier, resolveSoundTier } from '../hooks/useVFX'
import { vfxBus } from '../systems/vfx-bus'
import { soundEngine } from '../systems/sound-engine'
import type { SavingsSummary, OrcLogEntry, OrcLogFilter } from '@shared/types'

export function RightSidebar() {
  const { settings, activePipelineId, view, gameActive, showSettings } = useUI()
  const { instances, folders } = useInstances()
  const { dispatch } = useAppDispatch()
  const [collapsed, setCollapsed] = useState(false)
  const [orcMode, setOrcMode] = useState(false)
  const [savings, setSavings] = useState<SavingsSummary | null>(null)
  const [showShutdown, setShowShutdown] = useState(false)
  const [orcLogs, setOrcLogs] = useState<OrcLogEntry[]>([])
  const [orcFilter, setOrcFilter] = useState<OrcLogFilter>('all')
  const [orcHovered, setOrcHovered] = useState(false)
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

  const activeAgents = instances.filter(i => i.state === 'running').length

  const handleShutdownConfirm = useCallback(async () => {
    setShowShutdown(false)
    try {
      await api.terminate()
    } catch {
      // Server will be unreachable after terminate — that's expected
    }
  }, [])

  const overdriveMultiplier = liveMultiplier ?? 1

  const handleNavClick = useCallback((target: 'pipeline' | 'agents' | 'sessions' | 'usage') => {
    if (target === 'pipeline') {
      const pipelineId = activePipelineId || folders[0]?.id || null
      if (pipelineId) dispatch({ type: 'SET_PIPELINE_PROJECT', projectId: pipelineId })
    }
    dispatch({ type: 'SELECT_INSTANCE', payload: null })
    dispatch({ type: 'SET_VIEW', payload: target })
  }, [dispatch, activePipelineId, folders])

  const NAV_ITEMS: { key: 'pipeline' | 'agents' | 'sessions' | 'usage'; label: string }[] = [
    { key: 'pipeline', label: 'Pipeline' },
    { key: 'agents', label: 'Agents' },
    { key: 'sessions', label: 'Sessions' },
    { key: 'usage', label: 'Usage' },
  ]

  return (
    <aside className={`right-sidebar rs-entrance${collapsed ? ' rs-collapsed' : ''}`}>
      {/* Collapse button */}
      <div className="rs-header-btns">
        <button
          className="rs-collapse-btn"
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
        >
          {collapsed ? '\u25C0' : '\u25B6'}
        </button>
      </div>

      {collapsed ? (
        <div className="rs-collapsed-icons">
          <button className="rs-icon-btn" onClick={() => { setCollapsed(false); setOrcMode(false) }} title="Orc panel">
            {'\u2694'}
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
                  <button className="rs-orc-close-btn" onClick={() => setOrcMode(false)} title="Close Orc view">{'\u2715'}</button>
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
                          {inst.activeTaskTitle.length > 35 ? inst.activeTaskTitle.slice(0, 35) + '\u2026' : inst.activeTaskTitle}
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
          {/* ── Compact Overdrive line ── */}
          <div className="rs-od-compact">
            <span className="rs-od-compact-label">Cache</span>
            <span className="rs-od-compact-value" style={{ color: overdriveMultiplier >= 3 ? '#22d3ee' : overdriveMultiplier >= 2 ? '#60a5fa' : 'var(--text-secondary)' }}>
              {overdriveMultiplier.toFixed(1)}x
            </span>
            {savings && savings.savedUsd > 0 && (
              <span className="rs-od-compact-saved">{fmtUsd(savings.savedUsd)} saved</span>
            )}
          </div>

          {/* ── The Orc POV ── */}
          {orcLogs.length === 0 ? (
            <div className="rs-orc-empty">
              <span style={{ fontFamily: 'var(--font-pixel)', fontSize: 8, color: 'var(--text-tertiary)' }}>The Orc</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)' }}>No orders yet</span>
            </div>
          ) : (
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
                      No {orcFilter} events
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
          )}

          {/* ── Footer ── */}
          <div className="rs-footer">
            <button
              className="rs-footer-btn"
              onClick={() => dispatch({ type: 'SET_GAME_ACTIVE', payload: !gameActive })}
              title={gameActive ? 'Switch to Pipeline' : 'Switch to Game'}
            >
              {gameActive ? '\uD83C\uDFAE' : '\uD83D\uDCCB'}
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
                {ANIMATION_TIERS[resolveAnimTier(settings)]?.icon ?? '\u23F8'}
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
                {SOUND_TIERS[resolveSoundTier(settings)]?.icon ?? '\uD83D\uDD07'}
              </button>
            </span>
            <button className="rs-footer-btn" data-tour-id="tour-settings" onClick={() => dispatch({ type: 'OPEN_SETTINGS' })} title="Settings">
              {'\u2699'}
            </button>
            <button
              className="rs-footer-btn rs-shutdown-btn"
              onClick={() => setShowShutdown(true)}
              title="Shutdown"
            >
              {'\u23FB'}
            </button>
          </div>

          {/* ── Nav links ── */}
          <div className="rs-nav-bar">
            {NAV_ITEMS.map(({ key, label }) => (
              <button
                key={key}
                className={`rs-nav-item${view === key ? ' active' : ''}`}
                onClick={() => handleNavClick(key)}
              >
                <span className="font-mono" style={{ fontSize: 11 }}>{label}</span>
              </button>
            ))}
            <button
              className={`rs-nav-item${showSettings ? ' active' : ''}`}
              onClick={() => dispatch({ type: 'OPEN_SETTINGS' })}
            >
              <span className="font-mono" style={{ fontSize: 11 }}>Settings</span>
            </button>
          </div>
        </>
      )}

      {showShutdown && createPortal(
        <div className="modal-overlay" onClick={() => setShowShutdown(false)}>
          <div className="modal-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 380 }}>
            <div className="modal-header">
              <span className="modal-title">Log out and TERMINATE THE SERVER?</span>
              <button className="modal-close" onClick={() => setShowShutdown(false)}>{'\u00D7'}</button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: 8 }}>
                This will kill all sessions and shut down the OrcStrator server process. You will need to restart the server manually.
              </p>
              {activeAgents > 0 && (
                <p style={{ color: 'var(--warning)', fontSize: 13, margin: 0 }}>
                  {'\u26A0'} {activeAgents} agent{activeAgents !== 1 ? 's are' : ' is'} currently running.
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
    </aside>
  )
}
