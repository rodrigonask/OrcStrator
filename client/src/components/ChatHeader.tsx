import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import type { ChatMessage, VerbosityLevel, SkillConfig } from '@shared/types'
import { VERBOSITY_TIERS, resolveContextWindow, resolveModelId, DEFAULT_MODEL_ID } from '@shared/constants'
import { useUI } from '../context/UIContext'
import { useMessages } from '../context/MessagesContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useOverdriveLevel } from '../hooks/useOverdriveLevel'
import { useVerbosity } from '../hooks/useVerbosity'
import { api } from '../api'
import { useConfirm } from './ConfirmModal'
import { useCacheKeeper } from '../hooks/useCacheKeeper'
import { IconFlame, IconCompact } from './icons'
import { OutputStyleSelect } from './OutputStyleSelect'
import './instance-extras.css'

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function cacheColor(ratio: number): string {
  if (ratio >= 0.7) return '#22c55e'
  if (ratio >= 0.4) return '#eab308'
  return '#ef4444'
}

// Color ramp for the session cache-hit badge (mirrors the OD_TIERS cold→supernova colors)
function cacheHitTierColor(pct: number): string {
  if (pct < 40) return '#4b5563' // gray  — cold
  if (pct < 60) return '#60a5fa' // blue  — warm
  if (pct < 75) return '#22d3ee' // cyan  — hot
  if (pct < 85) return '#f97316' // orange — blazing
  if (pct < 95) return '#ef4444' // red   — overdrive
  return '#e879f9'               // violet — supernova
}

const QUICK_COMMANDS = [
  { cmd: '/compact', label: 'Compact', desc: 'Compress conversation context' },
  { cmd: '/clear', label: 'Clear', desc: 'Clear conversation history' },
  { cmd: '/cost', label: 'Cost', desc: 'Show token usage & cost' },
  { cmd: '/context', label: 'Context', desc: 'Show context window breakdown' },
] as const

export function ChatHeader() {
  const { selectedInstanceId: instanceId, terminalPanelOpen, settings, sessionCosts } = useUI()
  const { messages: allMessages } = useMessages()
  const { instances } = useInstances()
  const { dispatch } = useAppDispatch()
  const instance = instances.find(i => i.id === instanceId)
  const messages: ChatMessage[] = instanceId ? (allMessages[instanceId] || []) : []
  const { confirm } = useConfirm()
  const sessionCost = instanceId ? sessionCosts[instanceId] : undefined

  // Auto-compact fires at 80% of the window (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80);
  // warn from 90% of that threshold (= 72% of the window).
  const AUTOCOMPACT_PCT = 80
  const WARN_PCT = AUTOCOMPACT_PCT * 0.9

  const contextWindow = useMemo(() => {
    // Window from the model that last reported usage; before the first turn, fall
    // back to the instance's configured default model so the empty state shows the
    // correct window instead of a hardcoded one.
    const modelId = instance?.ctxModel || (settings.defaultModel && settings.defaultModel !== 'default'
      ? resolveModelId(settings.defaultModel)
      : DEFAULT_MODEL_ID)
    const MAX = resolveContextWindow(modelId)
    const maxLabel = MAX >= 1_000_000 ? `${MAX / 1_000_000}M` : `${Math.round(MAX / 1000)}K`
    const used = instance?.ctxTokens ?? 0
    if (used > 0) {
      const pct = Math.min((used / MAX) * 100, 100)
      const color = pct >= 80 ? '#ef4444' : pct >= 60 ? '#eab308' : '#22c55e'
      // If ctxTokens somehow exceeds MAX, cap the display label
      const displayUsed = Math.min(used, MAX)
      const label = displayUsed >= 1000 ? `${Math.round(displayUsed / 1000)}K` : String(displayUsed)
      return { used, pct, color, label, maxLabel, modelId, max: MAX }
    }
    return { used: 0, pct: 0, color: '#22c55e', label: '—', maxLabel, modelId, max: MAX }
  }, [instance?.ctxTokens, instance?.ctxModel, settings.defaultModel])

  // Flash "Compacted ✓" for ~5s after a compaction event resets the gauge
  const [justCompacted, setJustCompacted] = useState(false)
  useEffect(() => {
    const at = instance?.ctxCompactedAt
    const remaining = at ? 5000 - (Date.now() - at) : 0
    if (remaining <= 0) { setJustCompacted(false); return }
    setJustCompacted(true)
    const t = setTimeout(() => setJustCompacted(false), remaining)
    return () => clearTimeout(t)
  }, [instance?.ctxCompactedAt, instanceId])

  const [ctxTooltipOpen, setCtxTooltipOpen] = useState(false)

  const handlePause = useCallback(() => {
    if (instanceId) api.pauseInstance(instanceId).catch(err => window.alert(`Couldn't stop the run: ${err.message}`))
  }, [instanceId])

  const handleResume = useCallback(() => {
    if (instanceId) api.resumeInstance(instanceId)
  }, [instanceId])

  const handleCopyLast = useCallback(() => {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistant) return
    const text = lastAssistant.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('\n')
    navigator.clipboard.writeText(text)
  }, [messages])

  const handleClear = useCallback(async () => {
    if (!instanceId) return
    const ok = await confirm('Clear chat history for this chat?')
    if (!ok) return
    api.clearHistory(instanceId)
    dispatch({ type: 'CLEAR_MESSAGES', payload: instanceId })
  }, [instanceId, dispatch, confirm])

  const handleForceReset = useCallback(async () => {
    if (!instanceId) return
    const ok = await confirm('Force reset this instance? Kills any running process.')
    if (!ok) return
    try {
      await api.forceResetInstance(instanceId)
    } catch (err) {
      console.error('Force reset failed:', err)
    }
    // Clear local optimistic/streaming state regardless — this is the escape hatch
    dispatch({ type: 'CLEAR_STREAMING', payload: instanceId })
    dispatch({ type: 'CLEAR_CLI_PROMPT', payload: instanceId })
    dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instanceId, updates: { state: 'idle', activeTaskId: undefined, activeTaskTitle: undefined, taskStartedAt: undefined } } })
  }, [instanceId, confirm, dispatch])

  const [burgerOpen, setBurgerOpen] = useState(false)
  const burgerRef = useRef<HTMLDivElement>(null)
  const [skills, setSkills] = useState<SkillConfig[]>([])
  const [skillsLoaded, setSkillsLoaded] = useState(false)
  const effectiveVerbosity = useVerbosity(instanceId)

  // Close burger on outside click or Escape
  useEffect(() => {
    if (!burgerOpen) return
    const handler = (e: MouseEvent) => {
      if (burgerRef.current && !burgerRef.current.contains(e.target as Node)) {
        setBurgerOpen(false)
      }
    }
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBurgerOpen(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [burgerOpen])

  const handleBurgerOpen = useCallback(() => {
    if (!skillsLoaded) {
      api.getSkills().then(s => { setSkills(s); setSkillsLoaded(true) })
    }
    setBurgerOpen(o => !o)
  }, [skillsLoaded])

  const handleQuickCommand = useCallback((cmd: string) => {
    setBurgerOpen(false)
    if (!instanceId) return

    // /clear is local-only — clears client state + server history
    if (cmd === '/clear') {
      handleClear()
      return
    }

    // Show user message in chat immediately
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      instanceId,
      role: 'user',
      content: [{ type: 'text', text: cmd }],
      createdAt: Date.now(),
    }
    dispatch({ type: 'ADD_MESSAGE', payload: userMsg })

    // Check if this is a CLI slash command (starts with /)
    if (cmd.startsWith('/')) {
      const cmdName = cmd.split(/\s+/)[0]
      dispatch({ type: 'SET_PENDING_COMMAND', payload: { instanceId, command: cmdName } })
      // Send to CLI via command dispatcher
      api.sendCommand(instanceId, cmd).then(res => {
        const msg: ChatMessage = {
          id: crypto.randomUUID(),
          instanceId: instanceId!,
          role: 'assistant',
          content: [{ type: 'text', text: res.result }],
          createdAt: Date.now(),
        }
        dispatch({ type: 'ADD_MESSAGE', payload: msg })
        // Process client-side actions from command response
        if (res.action === 'open-url' && res.url) window.open(res.url, '_blank')
        if (res.action === 'open-settings') dispatch({ type: 'OPEN_SETTINGS' })
        if (res.action === 'copy-to-clipboard' && res.value) navigator.clipboard.writeText(res.value)
      }).catch(() => {
        const msg: ChatMessage = {
          id: crypto.randomUUID(),
          instanceId: instanceId!,
          role: 'assistant',
          content: [{ type: 'text', text: 'Command failed — no active session.' }],
          createdAt: Date.now(),
        }
        dispatch({ type: 'ADD_MESSAGE', payload: msg })
      }).finally(() => {
        dispatch({ type: 'CLEAR_PENDING_COMMAND', payload: instanceId })
      })
      return
    }

    // Non-slash commands: send as regular messages
    api.sendMessage(instanceId, { text: cmd })
  }, [instanceId, handleClear, dispatch])

  const handleLoadSkill = useCallback(async (skill: SkillConfig) => {
    setBurgerOpen(false)
    if (!instanceId) return
    const ok = await confirm(`Load skill: ${skill.name}?`)
    if (!ok) return
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      instanceId,
      role: 'user',
      content: [{ type: 'text', text: skill.content }],
      createdAt: Date.now(),
    }
    dispatch({ type: 'ADD_MESSAGE', payload: userMsg })
    api.sendMessage(instanceId, { text: skill.content })
  }, [instanceId, dispatch, confirm])

  // Session-wide prompt cache hit rate: cacheRead / (input + cacheRead + cacheCreation)
  const cacheHitPct = useMemo(() => {
    if (!sessionCost || sessionCost.turns === 0) return null
    const denom = sessionCost.totalInput + sessionCost.totalCacheRead + sessionCost.totalCacheCreation
    if (denom <= 0) return null
    return Math.round((sessionCost.totalCacheRead / denom) * 100)
  }, [sessionCost])

  const { overdriveLevel, overdrive, minsLeft, isExpiringSoon } = useOverdriveLevel(
    instance?.overdriveTasks ?? 0, instance?.lastTaskAt ?? 0
  )

  // Keep-warm 🔥 + compact controls (shared with the grid-tile header).
  const { keepWarm, ctxHeavy, hasSession, compacting, toggleKeepWarm, doCompact } = useCacheKeeper(instance)

  if (!instance) return null

  return (
    <div className="chat-header" style={{ position: 'relative' }}>
      <div
        className="chat-context-bar"
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          height: 2,
          width: `${contextWindow.pct}%`,
          background: contextWindow.color,
          transition: 'width 0.4s ease, background 0.4s ease',
        }}
      />
      {/* Auto-compact threshold tick (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80) */}
      <div
        className="chat-context-tick"
        title="Auto-compact triggers here"
        style={{
          position: 'absolute',
          bottom: 0,
          left: `${AUTOCOMPACT_PCT}%`,
          width: 2,
          height: 5,
          background: '#f97316',
          opacity: 0.8,
          zIndex: 1,
        }}
      />
      <div className="chat-header-left">
        <button
          className="chat-header-btn chat-back-to-grid-btn"
          onClick={() => dispatch({ type: 'SET_VIEW', payload: 'grid' })}
          title="Back to grid (your tiles are unchanged)"
        >
          {'▦'} Back to grid
        </button>
        {overdriveLevel > 0 && (
          <span
            className={`od-badge od-level-${overdriveLevel}${isExpiringSoon ? ' od-pulse' : ''}`}
            title={`Smart Context Caching — ${overdrive.label} | ${instance.overdriveTasks} tasks cached this session | Cache window expires in ${minsLeft}min | Saves up to 90% on token costs using Claude native prompt caching`}
            style={{ fontFamily: 'var(--font-pixel)', fontSize: '7px' }}
          >
            {overdrive.label}
          </span>
        )}
        {cacheHitPct !== null && (
          <span
            className="cache-hit-badge"
            title="Prompt cache hit rate this session — higher = cheaper turns"
            style={{ color: cacheHitTierColor(cacheHitPct), fontFamily: 'var(--font-mono)', fontSize: '9px' }}
          >
            ⚡ {cacheHitPct}% cached
          </span>
        )}
        <span className="chat-instance-name" style={{ fontFamily: 'var(--font-mono)', fontSize: '9px' }}>{instance.name}</span>
        <span className={`chat-state-badge ${instance.state}`} style={{ fontFamily: 'var(--font-mono)', fontSize: '7px' }}>
          {instance.state}
        </span>
      </div>
      <div className="chat-header-right" ref={burgerRef}>
        {instance.state === 'running' && (
          <button className="chat-header-btn" onClick={handlePause} title="Pause">
            ⏸
          </button>
        )}
        {instance.state === 'paused' && (
          <button className="chat-header-btn primary" onClick={handleResume} title="Resume">
            ▶
          </button>
        )}
        <div className="header-stats">
          {sessionCost && sessionCost.turns > 0 ? (() => {
            const recentPct = Math.round((sessionCost.recentCacheRate ?? 0) * 100)
            return (
              <>
                <span
                  className="header-stat"
                  title={`Spent on this chat\n${fmtTokens(sessionCost.totalInput)} in / ${fmtTokens(sessionCost.totalOutput)} out\n${sessionCost.turns} turns`}
                >
                  <span style={{ color: '#22c55e' }}>${sessionCost.totalCost.toFixed(2)}</span>
                </span>
                <span className="header-stat-divider" />
                <span
                  className="header-stat"
                  title="Cache hit in the last 10 messages"
                >
                  <span style={{ color: cacheColor(sessionCost.recentCacheRate ?? 0) }}>{recentPct}%</span>
                </span>
              </>
            )
          })() : (
            <>
              <span className="header-stat" style={{ opacity: 0.4 }}>$0</span>
              <span className="header-stat-divider" />
              <span className="header-stat" style={{ opacity: 0.4 }}>—</span>
            </>
          )}
          <span className="header-stat-divider" />
          <span
            className="header-stat ctx-gauge-stat"
            style={{ color: justCompacted ? '#22c55e' : contextWindow.color, position: 'relative' }}
            onMouseEnter={() => setCtxTooltipOpen(true)}
            onMouseLeave={() => setCtxTooltipOpen(false)}
          >
            {justCompacted ? 'Compacted ✓' : `${contextWindow.label}/${contextWindow.maxLabel}`}
            {!justCompacted && contextWindow.pct >= WARN_PCT && (
              <span
                className="ctx-warn-dot"
                title={`Approaching auto-compact (${AUTOCOMPACT_PCT}%)`}
              />
            )}
            {ctxTooltipOpen && (
              <div className="ctx-tooltip">
                <div className="ctx-tooltip-row ctx-tooltip-head">
                  <span>{contextWindow.modelId}</span>
                  <span>{contextWindow.maxLabel} window</span>
                </div>
                <div className="ctx-tooltip-row">
                  <span>Context used</span>
                  <span>{contextWindow.used > 0 ? `${fmtTokens(contextWindow.used)} (${Math.round(contextWindow.pct)}%)` : '—'}</span>
                </div>
                {instance.lastTurnUsage ? (
                  <>
                    <div className="ctx-tooltip-sep" />
                    <div className="ctx-tooltip-label">Last turn</div>
                    <div className="ctx-tooltip-row"><span>Cold input</span><span>{fmtTokens(instance.lastTurnUsage.input)}</span></div>
                    <div className="ctx-tooltip-row"><span>Cache read</span><span>{fmtTokens(instance.lastTurnUsage.cacheRead)}</span></div>
                    <div className="ctx-tooltip-row"><span>Cache write</span><span>{fmtTokens(instance.lastTurnUsage.cacheCreation)}</span></div>
                    <div className="ctx-tooltip-row"><span>Output</span><span>{fmtTokens(instance.lastTurnUsage.output)}</span></div>
                  </>
                ) : (
                  <div className="ctx-tooltip-row ctx-tooltip-dim">No turns yet this session</div>
                )}
                <div className="ctx-tooltip-sep" />
                <div className="ctx-tooltip-row ctx-tooltip-dim">Auto-compact at {AUTOCOMPACT_PCT}%</div>
              </div>
            )}
          </span>
        </div>
        {hasSession && (
          <button
            className={`chat-header-btn keepwarm-btn${keepWarm ? ' on' : ''}`}
            onClick={() => toggleKeepWarm()}
            title={keepWarm
              ? 'Keep-warm ON — fires a tiny keep-alive before the cache expires so this session never cold-starts. Click to stop.'
              : 'Keep this session warm — auto-pings before the cache goes cold (uses a little quota). Click to enable.'}
          >
            <IconFlame size={14} />
          </button>
        )}
        {hasSession && ctxHeavy && (
          <button
            className={`chat-header-btn compact-btn${compacting ? ' spin' : ''}`}
            onClick={() => doCompact()}
            disabled={compacting}
            title={`Compact context (~${Math.round((instance.ctxTokens ?? 0) / 1000)}k tokens) → smaller, cheaper cold start`}
          >
            <IconCompact size={14} />
          </button>
        )}
        <button
          className={`chat-header-btn chat-burger-btn${burgerOpen ? ' active' : ''}`}
          onClick={handleBurgerOpen}
          title="Chat options"
        >
          ☰
        </button>
        {burgerOpen && (
          <div className="chat-burger-menu">
            {/* Verbosity */}
            <div className="chat-burger-sub-label">Verbosity</div>
            {VERBOSITY_TIERS.map(tier => (
              <button
                key={tier.level}
                className={`chat-burger-item${effectiveVerbosity === tier.level ? ' active' : ''}`}
                onClick={() => {
                  if (instanceId) dispatch({ type: 'SET_INSTANCE_VERBOSITY', payload: { instanceId, level: tier.level } })
                  setBurgerOpen(false)
                }}
              >
                <span className="chat-burger-item-icon">{tier.icon}</span>
                <span className="chat-burger-item-label">{tier.name}</span>
                <span className="chat-burger-item-desc">{tier.description}</span>
                {effectiveVerbosity === tier.level && <span className="chat-burger-check">✓</span>}
              </button>
            ))}
            {instanceId && settings.verbosity !== undefined && (
              <button
                className="chat-burger-item dim"
                onClick={() => { dispatch({ type: 'SET_INSTANCE_VERBOSITY', payload: { instanceId, level: null } }); setBurgerOpen(false) }}
              >
                <span className="chat-burger-item-label">Reset to default (Lv.{settings.verbosity ?? 3})</span>
              </button>
            )}
            <div className="chat-burger-separator" />
            {/* Output style: the model's half of "how much does it say". Verbosity above
                controls how much of the transcript we DRAW; this controls what Claude writes. */}
            {instance && (
              <>
                <div className="chat-burger-sub-label">Claude</div>
                <OutputStyleSelect instance={instance} />
                <div className="chat-burger-separator" />
              </>
            )}
            {/* Actions */}
            <button
              className={`chat-burger-item${terminalPanelOpen ? ' active' : ''}`}
              onClick={() => { dispatch({ type: 'TOGGLE_TERMINAL' }); setBurgerOpen(false) }}
            >
              <span className="chat-burger-item-label">Black Box</span>
              <span className="chat-burger-item-desc">Terminal panel</span>
            </button>
            <button className="chat-burger-item" onClick={() => { handleCopyLast(); setBurgerOpen(false) }}>
              <span className="chat-burger-item-label">Copy last reply</span>
            </button>
            <button className="chat-burger-item" onClick={() => { setBurgerOpen(false); handleForceReset() }}>
              <span className="chat-burger-item-label">Force reset</span>
              <span className="chat-burger-item-desc">Kill stuck process, reset to idle</span>
            </button>
            {/* Skills */}
            {skills.length > 0 && (
              <>
                <div className="chat-burger-separator" />
                <div className="chat-burger-sub-label">Skills</div>
                {skills.map(s => (
                  <button key={s.id} className="chat-burger-item" onClick={() => handleLoadSkill(s)}>
                    <span className="chat-burger-item-label">{s.name}</span>
                    <span className="chat-burger-item-desc">{s.description}</span>
                  </button>
                ))}
              </>
            )}
            {/* Commands */}
            <div className="chat-burger-separator" />
            <div className="chat-burger-sub-label">Commands</div>
            {QUICK_COMMANDS.map(c => (
              <button key={c.cmd} className="chat-burger-item" onClick={() => handleQuickCommand(c.cmd)}>
                <span className="chat-burger-item-label" style={{ fontFamily: 'var(--font-mono)' }}>{c.cmd}</span>
                <span className="chat-burger-item-desc">{c.desc}</span>
              </button>
            ))}
            {(settings.customCommands ?? []).length > 0 && (settings.customCommands ?? []).map((cc, i) => (
              <button key={`custom-${i}`} className="chat-burger-item" onClick={() => handleQuickCommand(cc.command)}>
                <span className="chat-burger-item-label" style={{ fontFamily: 'var(--font-mono)' }}>{cc.name}</span>
                <span className="chat-burger-item-desc">{cc.description}</span>
              </button>
            ))}
            <button className="chat-burger-item dim" onClick={() => { setBurgerOpen(false); dispatch({ type: 'OPEN_SETTINGS' }) }}>
              <span className="chat-burger-item-label">+ Add command</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
