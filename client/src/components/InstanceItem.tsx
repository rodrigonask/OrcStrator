import { useState, useCallback, useEffect, useRef } from 'react'
import type { InstanceConfig, ChatMessage, SkillConfig } from '@shared/types'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { sounds } from '../utils/sounds'

interface InstanceItemProps {
  instance: InstanceConfig
  folderOrchestratorActive?: boolean
  dragHandleProps?: Record<string, unknown>
}

const AGENT_ROLES = ['planner', 'builder', 'tester', 'promoter'] as const

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')        // fenced code blocks
    .replace(/`[^`]*`/g, (m) => m.slice(1, -1))  // inline code
    .replace(/!\[.*?\]\(.*?\)/g, '')       // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links
    .replace(/#{1,6}\s+/g, '')             // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1')    // bold **
    .replace(/__([^_]+)__/g, '$1')         // bold __
    .replace(/\*([^*]+)\*/g, '$1')         // italic *
    .replace(/_([^_]+)_/g, '$1')           // italic _
    .replace(/~~([^~]+)~~/g, '$1')         // strikethrough
    .replace(/^\s*[-*+]\s+/gm, '')         // unordered lists
    .replace(/^\s*\d+\.\s+/gm, '')         // ordered lists
    .replace(/>\s+/g, '')                  // blockquotes
    .replace(/\n+/g, ' ')                  // newlines → space
    .trim()
}

export function InstanceItem({ instance, folderOrchestratorActive, dragHandleProps }: InstanceItemProps) {
  const { state, dispatch, selectInstance, deleteInstance } = useApp()
  const isSelected = state.selectedInstanceId === instance.id
  const messages: ChatMessage[] = state.messages[instance.id] || []
  const lastMsg = messages[messages.length - 1]
  const unread = state.unreadCounts?.[instance.id] || 0

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [skills, setSkills] = useState<SkillConfig[]>([])
  const [showSkillsMenu, setShowSkillsMenu] = useState(false)

  const animEnabled = state.settings.animationsEnabled !== false
  const soundEnabled = state.settings.soundsEnabled === true

  const [animClass, setAnimClass] = useState<string | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)
  const prevStateRef = useRef<string | null>(null)
  const prevMsgCountRef = useRef(messages.length)
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function triggerAnim(cls: string, duration: number) {
    if (!animEnabled) return
    if (animTimerRef.current) clearTimeout(animTimerRef.current)
    setAnimClass(cls)
    animTimerRef.current = setTimeout(() => setAnimClass(null), duration)
  }

  // Spawn animation on mount
  useEffect(() => {
    triggerAnim('anim-spawn', 600)
    if (soundEnabled) sounds.spawn()
    prevStateRef.current = instance.state
    prevMsgCountRef.current = messages.length
    return () => { if (animTimerRef.current) clearTimeout(animTimerRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // State transition animations
  useEffect(() => {
    const prev = prevStateRef.current
    prevStateRef.current = instance.state
    if (prev === null || prev === instance.state) return

    if (instance.state === 'running') {
      triggerAnim('anim-activate', 800)
      if (soundEnabled) sounds.activate()
    } else if (prev === 'running') {
      triggerAnim('anim-sleep', 1200)
      if (soundEnabled) sounds.sleep()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.state])

  // New task while active (message received while running)
  useEffect(() => {
    const prev = prevMsgCountRef.current
    prevMsgCountRef.current = messages.length
    if (messages.length > prev && instance.state === 'running') {
      triggerAnim('anim-heal', 600)
      if (soundEnabled) sounds.heal()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  useEffect(() => {
    if (contextMenu) {
      api.getSkills().then(setSkills).catch(() => {})
    }
  }, [contextMenu])

  const agentNames = state.settings.orchestratorAgentNames || { planner: 'Planner', builder: 'Builder', tester: 'Tester', promoter: 'Promoter' }

  const isOrchestratorLocked = instance.orchestratorManaged && folderOrchestratorActive

  let preview = ''
  if (lastMsg) {
    const textBlock = lastMsg.content.find(b => b.type === 'text')
    if (textBlock && textBlock.type === 'text') {
      preview = stripMarkdown(textBlock.text).slice(0, 80)
    }
  }

  const handleRoleChange = useCallback(async (role: string) => {
    if (isOrchestratorLocked) return
    const newRole = role === '' ? undefined : role
    // Auto-enroll in orchestrator if folder's orchestrator is active and a role is being set
    const autoManage = newRole !== undefined && folderOrchestratorActive && !instance.orchestratorManaged
    try {
      const updates: Partial<InstanceConfig> = { agentRole: newRole as InstanceConfig['agentRole'] }
      if (autoManage) updates.orchestratorManaged = true
      await api.updateInstance(instance.id, updates)
      dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates } })
    } catch (err) {
      console.error('Failed to update role:', err)
    }
  }, [instance.id, instance.orchestratorManaged, isOrchestratorLocked, folderOrchestratorActive, dispatch])

  const handleSpecSave = useCallback(async (value: string) => {
    if (value === (instance.specialization || '')) return
    try {
      await api.updateInstance(instance.id, { specialization: value || undefined })
      dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { specialization: value || undefined } } })
    } catch (err) {
      console.error('Failed to update specialization:', err)
    }
  }, [instance.id, instance.specialization, dispatch])

  const handleToggleManaged = useCallback(async () => {
    if (isOrchestratorLocked) return
    const newManaged = !instance.orchestratorManaged
    try {
      await api.updateInstance(instance.id, { orchestratorManaged: newManaged })
      dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { orchestratorManaged: newManaged } } })
    } catch (err) {
      console.error('Failed to update orchestratorManaged:', err)
    }
  }, [instance.id, instance.orchestratorManaged, isOrchestratorLocked, dispatch])

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (animEnabled) {
      setIsRemoving(true)
      if (soundEnabled) sounds.remove()
      setTimeout(() => deleteInstance(instance.id), 780)
    } else {
      deleteInstance(instance.id)
    }
  }, [animEnabled, soundEnabled, deleteInstance, instance.id])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const activeAnimClass = isRemoving ? 'anim-remove' : (animClass || '')

  return (
    <div
      className={`instance-item ${isSelected ? 'selected' : ''} ${instance.orchestratorManaged ? 'orchestrator-managed' : ''} ${activeAnimClass}`}
      onClick={() => {
        selectInstance(instance.id)
        if (state.view === 'pipeline') dispatch({ type: 'SET_VIEW', payload: 'chat' })
      }}
      onContextMenu={handleContextMenu}
      {...(dragHandleProps as React.HTMLAttributes<HTMLDivElement>)}
    >
      <div className={`instance-state-dot ${instance.state}`} />
      <div className="instance-info">
        <div className="instance-name">
          {instance.name}
          {instance.orchestratorManaged && <span className="orchestrator-bot-icon" title="Orchestrator managed">⚡</span>}
        </div>
        {preview && <div className="instance-preview">{preview}</div>}
      </div>
      {instance.agentRole && (
        <div className="instance-role-row">
          <span className={`role-pill role-${instance.agentRole} compact ${isOrchestratorLocked ? 'locked' : ''}`}>
            {isOrchestratorLocked ? '🔒 ' : ''}{agentNames[instance.agentRole]}
          </span>
          {instance.specialization && (
            <span className="spec-pill compact">{instance.specialization}</span>
          )}
        </div>
      )}
      {unread > 0 && <span className="instance-badge">{unread}</span>}
      <button
        className="instance-close-btn"
        onClick={handleDelete}
        title="Close session"
      >
        ×
      </button>

      {contextMenu && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 199 }}
            onClick={(e) => { e.stopPropagation(); setContextMenu(null) }}
          />
          <div
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={e => e.stopPropagation()}
          >
            {AGENT_ROLES.map(role => (
              <button
                key={role}
                className={`context-menu-item ${instance.agentRole === role ? 'active' : ''}`}
                onClick={() => { handleRoleChange(role); setContextMenu(null) }}
              >
                {agentNames[role]}
              </button>
            ))}
            {instance.agentRole && (
              <button className="context-menu-item" onClick={() => { handleRoleChange(''); setContextMenu(null) }}>
                Clear Role
              </button>
            )}
            <div className="context-menu-separator" />
            <button
              className="context-menu-item"
              onClick={() => {
                setContextMenu(null)
                const name = window.prompt('Rename session:', instance.name)
                if (name !== null && name.trim() && name.trim() !== instance.name) {
                  const trimmed = name.trim()
                  api.updateInstance(instance.id, { name: trimmed })
                    .then(() => dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { name: trimmed } } }))
                    .catch(err => console.error('Failed to rename session:', err))
                }
              }}
            >
              Rename...
            </button>
            <div style={{ position: 'relative' }}>
              <button
                className="context-menu-item"
                onClick={() => setShowSkillsMenu(s => !s)}
              >
                Set Specialization... {instance.specialization ? `(${instance.specialization})` : ''}
              </button>
              {showSkillsMenu && (
                <div className="context-menu context-menu-sub">
                  {instance.specialization && (
                    <button
                      className="context-menu-item"
                      onClick={() => { handleSpecSave(''); setShowSkillsMenu(false); setContextMenu(null) }}
                    >
                      Clear
                    </button>
                  )}
                  {skills.length === 0 && (
                    <span className="context-menu-item" style={{ opacity: 0.5, cursor: 'default' }}>No skills yet</span>
                  )}
                  {skills.map(skill => (
                    <button
                      key={skill.id}
                      className={`context-menu-item ${instance.specialization === skill.name ? 'active' : ''}`}
                      onClick={() => { handleSpecSave(skill.name); setShowSkillsMenu(false); setContextMenu(null) }}
                    >
                      {skill.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="context-menu-separator" />
            {!isOrchestratorLocked && (
              <button
                className={`context-menu-item ${instance.orchestratorManaged ? '' : ''}`}
                onClick={() => { handleToggleManaged(); setContextMenu(null) }}
              >
                {instance.orchestratorManaged ? 'Remove from Orchestrator' : 'Feed to Orchestrator'}
              </button>
            )}
            <div className="context-menu-separator" />
            <button
              className="context-menu-item danger"
              onClick={(e) => { setContextMenu(null); handleDelete(e) }}
            >
              Close Session
            </button>
          </div>
        </>
      )}
    </div>
  )
}
