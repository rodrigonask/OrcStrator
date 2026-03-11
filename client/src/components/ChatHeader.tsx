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
  { cmd: '/memory', label: 'Memory', desc: 'View CLAUDE.md memory' },
  { cmd: '/status', label: 'Status', desc: 'Show session status' },
  { cmd: '/help', label: 'Help', desc: 'Show available commands' },
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
    const MAX = 200_000
    const used = instance?.ctxTokens ?? 0
    if (used > 0) {
      const pct = Math.min((used / MAX) * 100, 100)
      const color = pct >= 80 ? '#ef4444' : pct >= 50 ? '#eab308' : '#22c55e'
      const label = used >= 1000 ? `${Math.round(used / 1000)}K` : String(used)
      return { used, pct, color, label }
    }
    return { used: 0, pct: 0, color: '#22c55e', label: '—' }
  }, [instance?.ctxTokens])

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
    const ok = await confirm('Clear chat history for this instance?')
    if (!ok) return
    api.clearHistory(instanceId)
    dispatch({ type: 'CLEAR_MESSAGES', payload: instanceId })
  }, [instanceId, dispatch, confirm])

  const [cmdMenuOpen, setCmdMenuOpen] = useState(false)
  const cmdMenuRef = useRef<HTMLDivElement>(null)
  const [verbMenuOpen, setVerbMenuOpen] = useState(false)
  const verbMenuRef = useRef<HTMLDivElement>(null)
  const [skillMenuOpen, setSkillMenuOpen] = useState(false)
  const [skills, setSkills] = useState<SkillConfig[]>([])
  const skillMenuRef = useRef<HTMLDivElement>(null)
  const effectiveVerbosity = useVerbosity(instanceId)

  // Close on outside click
  useEffect(() => {
    if (!cmdMenuOpen && !verbMenuOpen && !skillMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (cmdMenuOpen && cmdMenuRef.current && !cmdMenuRef.current.contains(e.target as Node)) {
        setCmdMenuOpen(false)
      }
      if (verbMenuOpen && verbMenuRef.current && !verbMenuRef.current.contains(e.target as Node)) {
        setVerbMenuOpen(false)
      }
      if (skillMenuOpen && skillMenuRef.current && !skillMenuRef.current.contains(e.target as Node)) {
        setSkillMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [cmdMenuOpen, verbMenuOpen, skillMenuOpen])

  const handleQuickCommand = useCallback((cmd: string) => {
    setCmdMenuOpen(false)
    if (!instanceId) return
    if (cmd === '/clear') {
      handleClear()
      return
    }
    // Add visual confirmation in the chat as a user message
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      instanceId,
      role: 'user',
      content: [{ type: 'text', text: cmd }],
      createdAt: Date.now(),
    }
    dispatch({ type: 'ADD_MESSAGE', payload: userMsg })
    api.sendMessage(instanceId, { text: cmd })
  }, [instanceId, handleClear, dispatch])

  const handleSkillMenuOpen = useCallback(() => {
    setSkillMenuOpen(o => {
      if (!o) api.getSkills().then(setSkills)
      return !o
    })
  }, [])

  const handleLoadSkill = useCallback(async (skill: SkillConfig) => {
    setSkillMenuOpen(false)
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
      <div className="chat-header-right">
        <span className="chat-token-count" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
          {totalTokens.input.toLocaleString()}in / {totalTokens.output.toLocaleString()}out
        </span>
        <span className="chat-context-label" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: contextWindow.color }}>
          CTX {contextWindow.label}/200K
        </span>
        {instance.state === 'running' && (
          <button className="chat-header-btn" onClick={handlePause}>
            Pause
          </button>
        )}
        {instance.state === 'paused' && (
          <button className="chat-header-btn primary" onClick={handleResume}>
            Resume
          </button>
        )}
        <div className="verbosity-menu-wrap" ref={verbMenuRef}>
          <button
            className={`chat-header-btn verbosity-trigger${verbMenuOpen ? ' active' : ''}`}
            onClick={() => setVerbMenuOpen(o => !o)}
            title="Chat verbosity level"
          >
            {VERBOSITY_TIERS[effectiveVerbosity - 1]?.icon} {VERBOSITY_TIERS[effectiveVerbosity - 1]?.name}
          </button>
          {verbMenuOpen && (
            <div className="verbosity-dropdown">
              {VERBOSITY_TIERS.map(tier => (
                <button
                  key={tier.level}
                  className={`verbosity-option${effectiveVerbosity === tier.level ? ' active' : ''}`}
                  onClick={() => {
                    if (instanceId) {
                      dispatch({ type: 'SET_INSTANCE_VERBOSITY', payload: { instanceId, level: tier.level } })
                    }
                    setVerbMenuOpen(false)
                  }}
                >
                  <span className="verbosity-option-icon">{tier.icon}</span>
                  <span className="verbosity-option-name">{tier.name}</span>
                  <span className="verbosity-option-desc">{tier.description}</span>
                  {effectiveVerbosity === tier.level && <span className="verbosity-option-dot" />}
                </button>
              ))}
              {instanceId && settings.verbosity !== undefined && (
                <button
                  className="verbosity-option reset"
                  onClick={() => {
                    dispatch({ type: 'SET_INSTANCE_VERBOSITY', payload: { instanceId, level: null } })
                    setVerbMenuOpen(false)
                  }}
                >
                  Reset to default (Lv.{settings.verbosity ?? 3})
                </button>
              )}
            </div>
          )}
        </div>
        <button
          className={`chat-header-btn ${terminalPanelOpen ? 'active' : ''}`}
          onClick={() => dispatch({ type: 'TOGGLE_TERMINAL' })}
          title="Toggle the Black Box"
          data-tour-id="tour-blackbox"
        >
          Black Box
        </button>
        <button className="chat-header-btn" onClick={handleCopyLast} title="Copy last response">
          Copy
        </button>
        <div className="cmd-menu-wrap" ref={skillMenuRef}>
          <button
            className={`chat-header-btn${skillMenuOpen ? ' active' : ''}`}
            onClick={handleSkillMenuOpen}
            title="Load a skill into this chat"
          >
            Skills
          </button>
          {skillMenuOpen && (
            <div className="cmd-menu-dropdown">
              {skills.length === 0 ? (
                <div className="cmd-menu-item" style={{ opacity: 0.5, cursor: 'default' }}>
                  <span className="cmd-menu-cmd">No skills yet</span>
                </div>
              ) : skills.map(s => (
                <button
                  key={s.id}
                  className="cmd-menu-item"
                  onClick={() => handleLoadSkill(s)}
                >
                  <span className="cmd-menu-cmd">{s.name}</span>
                  <span className="cmd-menu-desc">{s.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="cmd-menu-wrap" ref={cmdMenuRef}>
          <button
            className={`chat-header-btn cmd-trigger${cmdMenuOpen ? ' active' : ''}`}
            onClick={() => setCmdMenuOpen(o => !o)}
            title="Quick commands"
          >
            &lt;/&gt;
          </button>
          {cmdMenuOpen && (
            <div className="cmd-menu-dropdown">
              {QUICK_COMMANDS.map(c => (
                <button
                  key={c.cmd}
                  className="cmd-menu-item"
                  onClick={() => handleQuickCommand(c.cmd)}
                >
                  <span className="cmd-menu-cmd">{c.cmd}</span>
                  <span className="cmd-menu-desc">{c.desc}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
