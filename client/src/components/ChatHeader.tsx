import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import type { ChatMessage, VerbosityLevel, SkillConfig } from '@shared/types'
import { VERBOSITY_TIERS } from '@shared/constants'
import { useUI } from '../context/UIContext'
import { useMessages } from '../context/MessagesContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useAgentNames } from '../hooks/useAgentNames'
import { useOverdriveLevel } from '../hooks/useOverdriveLevel'
import { useVerbosity } from '../hooks/useVerbosity'
import { api } from '../api'
import { useConfirm } from './ConfirmModal'

const QUICK_COMMANDS = [
  { cmd: '/compact', label: 'Compact', desc: 'Compress conversation context' },
  { cmd: '/clear', label: 'Clear', desc: 'Clear conversation history' },
  { cmd: '/cost', label: 'Cost', desc: 'Show token usage & cost' },
  { cmd: '/context', label: 'Context', desc: 'Show context window breakdown' },
] as const

export function ChatHeader() {
  const { selectedInstanceId: instanceId, terminalPanelOpen, settings } = useUI()
  const { messages: allMessages } = useMessages()
  const { instances, folders } = useInstances()
  const { dispatch } = useAppDispatch()
  const instance = instances.find(i => i.id === instanceId)
  const folder = instance ? folders.find(f => f.id === instance.folderId) : undefined
  const messages: ChatMessage[] = instanceId ? (allMessages[instanceId] || []) : []
  const agentNames = useAgentNames()
  const { confirm } = useConfirm()
  const isOrchestratorLocked = instance?.orchestratorManaged && folder?.orchestratorActive

  const totalTokens = useMemo(() => {
    let input = 0
    let output = 0
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'cost') {
          input += block.inputTokens
          output += block.outputTokens
        }
      }
    }
    return { input, output }
  }, [messages])

  const contextWindow = useMemo(() => {
    const model = instance?.ctxModel ?? ''
    const MAX = model.includes('opus-4') ? 1_000_000 : 200_000
    const maxLabel = MAX === 1_000_000 ? '1M' : '200K'
    const used = instance?.ctxTokens ?? 0
    if (used > 0) {
      const pct = Math.min((used / MAX) * 100, 100)
      const color = pct >= 80 ? '#ef4444' : pct >= 50 ? '#eab308' : '#22c55e'
      // If ctxTokens somehow exceeds MAX (can happen with char-count drift), cap the display label
      const displayUsed = Math.min(used, MAX)
      const label = displayUsed >= 1000 ? `${Math.round(displayUsed / 1000)}K` : String(displayUsed)
      return { used, pct, color, label, maxLabel }
    }
    return { used: 0, pct: 0, color: '#22c55e', label: '—', maxLabel }
  }, [instance?.ctxTokens, instance?.ctxModel])

  const handlePause = useCallback(() => {
    if (instanceId) api.pauseInstance(instanceId)
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

  const [burgerOpen, setBurgerOpen] = useState(false)
  const burgerRef = useRef<HTMLDivElement>(null)
  const [skills, setSkills] = useState<SkillConfig[]>([])
  const [skillsLoaded, setSkillsLoaded] = useState(false)
  const effectiveVerbosity = useVerbosity(instanceId)

  // Close burger on outside click
  useEffect(() => {
    if (!burgerOpen) return
    const handler = (e: MouseEvent) => {
      if (burgerRef.current && !burgerRef.current.contains(e.target as Node)) {
        setBurgerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
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

  const { overdriveLevel, overdrive, minsLeft, isExpiringSoon } = useOverdriveLevel(
    instance?.overdriveTasks ?? 0, instance?.lastTaskAt ?? 0
  )

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
      <div className="chat-header-left">
        {instance.agentRole && (
          <span
            className={`role-pill role-${instance.agentRole} compact header-role-pill ${isOrchestratorLocked ? 'locked' : ''}`}
            style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: `var(--role-${instance.agentRole})` }}
          >
            {isOrchestratorLocked ? '🔒 ' : ''}{agentNames[instance.agentRole]}
            {instance.specialization && <span className="role-spec-label" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>{instance.specialization}</span>}
          </span>
        )}
        {overdriveLevel > 0 && (
          <span
            className={`od-badge od-level-${overdriveLevel}${isExpiringSoon ? ' od-pulse' : ''}`}
            title={`Smart Context Caching — ${overdrive.label} | ${instance.overdriveTasks} tasks cached this session | Cache window expires in ${minsLeft}min | Saves up to 90% on token costs using Claude native prompt caching`}
            style={{ fontFamily: 'var(--font-pixel)', fontSize: '7px' }}
          >
            Lv.{overdriveLevel}
          </span>
        )}
        {instance.agentRole && <span className="chat-instance-name-sep"> | </span>}
        <span className="chat-instance-name" style={{ fontFamily: 'var(--font-mono)', fontSize: '9px' }}>{instance.name}</span>
        <span className={`chat-state-badge ${instance.state}`} style={{ fontFamily: 'var(--font-mono)', fontSize: '7px' }}>
          {instance.state}
        </span>
      </div>
      <div className="chat-header-right" ref={burgerRef}>
        <span className="chat-token-count" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
          {totalTokens.input.toLocaleString()}in / {totalTokens.output.toLocaleString()}out
        </span>
        <span className="chat-context-label" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: contextWindow.color }}>
          CTX {contextWindow.label}/{contextWindow.maxLabel}
        </span>
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
            {/* Actions */}
            <button
              className={`chat-burger-item${terminalPanelOpen ? ' active' : ''}`}
              onClick={() => { dispatch({ type: 'TOGGLE_TERMINAL' }); setBurgerOpen(false) }}
              data-tour-id="tour-blackbox"
            >
              <span className="chat-burger-item-label">Black Box</span>
              <span className="chat-burger-item-desc">Terminal panel</span>
            </button>
            <button className="chat-burger-item" onClick={() => { handleCopyLast(); setBurgerOpen(false) }}>
              <span className="chat-burger-item-label">Copy last reply</span>
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
