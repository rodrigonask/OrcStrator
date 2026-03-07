import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { InstanceConfig, ChatMessage, SkillConfig } from '@shared/types'
import { OVERDRIVE_LEVELS } from '@shared/constants'
import { useUI } from '../context/UIContext'
import { useMessages } from '../context/MessagesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'
import { sounds } from '../utils/sounds'

interface InstanceItemProps {
  instance: InstanceConfig
  folderOrchestratorActive?: boolean
  dragHandleProps?: Record<string, unknown>
}

const AGENT_ROLES = ['planner', 'builder', 'tester', 'promoter'] as const


export function InstanceItem({ instance, folderOrchestratorActive, dragHandleProps }: InstanceItemProps) {
  const { selectedInstanceId, view, settings } = useUI()
  const { messages: allMessages, unreadCounts } = useMessages()
  const { dispatch, selectInstance, deleteInstance } = useAppDispatch()
  const isSelected = selectedInstanceId === instance.id
  const messages: ChatMessage[] = allMessages[instance.id] || []
  const unread = unreadCounts?.[instance.id] || 0

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [skills, setSkills] = useState<SkillConfig[]>([])
  const [showSkillsMenu, setShowSkillsMenu] = useState(false)

  const animEnabled = settings.animationsEnabled !== false
  const soundEnabled = settings.soundsEnabled !== false

  const [animClass, setAnimClass] = useState<string | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    if (!instance.taskStartedAt || instance.state !== 'running') return
    const id = setInterval(() => forceUpdate(n => n + 1), 60_000)
    return () => clearInterval(id)
  }, [instance.taskStartedAt, instance.state])

  const elapsedMins = instance.taskStartedAt
    ? Math.floor((Date.now() - instance.taskStartedAt) / 60_000)
    : 0

  // Overdrive badge computation
  const odTasks = instance.overdriveTasks ?? 0
  let overdriveLevel = 0
  for (const od of OVERDRIVE_LEVELS) {
    if (odTasks >= od.minTasks) overdriveLevel = od.level
    else break
  }
  const overdrive = OVERDRIVE_LEVELS[overdriveLevel]
  const minsLeft = Math.max(0, 60 - Math.floor((Date.now() - (instance.lastTaskAt ?? 0)) / 60_000))
  const isExpiringSoon = overdriveLevel > 0 && minsLeft < 10

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
    triggerAnim('anim-spawn', 4200)
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
      triggerAnim('anim-activate', 6500)
      if (soundEnabled) sounds.activate()
    } else if (prev === 'running') {
      triggerAnim('anim-sleep', 5500)
      if (soundEnabled) sounds.sleep()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.state])

  // New task while active (message received while running)
  useEffect(() => {
    const prev = prevMsgCountRef.current
    prevMsgCountRef.current = messages.length
    if (messages.length > prev && instance.state === 'running') {
      triggerAnim('anim-heal', 4000)
      if (soundEnabled) sounds.heal()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  // Overdrive level-up animation
  const prevOdLevelRef = useRef(overdriveLevel)
  useEffect(() => {
    const prev = prevOdLevelRef.current
    prevOdLevelRef.current = overdriveLevel
    if (overdriveLevel > prev && prev >= 0) {
      triggerAnim('od-levelup-anim', 600)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overdriveLevel])

  useEffect(() => {
    if (contextMenu) {
      api.getSkills().then(setSkills).catch(() => {})
    }
  }, [contextMenu])

  const agentNames = settings.orchestratorAgentNames || { planner: 'Planner', builder: 'Builder', tester: 'Tester', promoter: 'Promoter' }

  const isOrchestratorLocked = instance.orchestratorManaged && folderOrchestratorActive

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
      setTimeout(() => deleteInstance(instance.id), 3600)
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

  const safeDragProps = useMemo(() => {
    if (!dragHandleProps) return {}
    const props = { ...(dragHandleProps as Record<string, unknown>) }
    const origPointerDown = props.onPointerDown as ((e: React.PointerEvent) => void) | undefined
    if (origPointerDown) {
      props.onPointerDown = (e: React.PointerEvent) => {
        if (e.button === 2) return // let right-click through for context menu
        origPointerDown(e)
      }
    }
    return props
  }, [dragHandleProps])

  return (
    <div
      className={`instance-item ${isSelected ? 'selected' : ''} ${instance.orchestratorManaged ? 'orchestrator-managed' : ''} state-${instance.state} ${activeAnimClass}`}
      style={instance.state === 'running' && instance.agentRole ? { boxShadow: `0 0 8px 2px color-mix(in srgb, var(--role-${instance.agentRole}) 40%, transparent)` } : undefined}
      {...(safeDragProps as React.HTMLAttributes<HTMLDivElement>)}
      onClick={() => {
        selectInstance(instance.id)
        if (view === 'pipeline') dispatch({ type: 'SET_VIEW', payload: 'chat' })
      }}
      onContextMenu={handleContextMenu}
    >
      <div className={`instance-state-dot ${instance.state}`} />
      <div className="instance-info">
        <div className="instance-name" style={{ fontFamily: 'var(--font-mono)', fontSize: '9px' }}>
          {instance.agentRole
            ? (
              <>
                <span
                  className={`instance-role-label role-${instance.agentRole}${isOrchestratorLocked ? ' locked' : ''}`}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: `var(--role-${instance.agentRole})` }}
                >
                  {isOrchestratorLocked ? '🔒 ' : ''}{agentNames[instance.agentRole]}
                </span>
                <span className="instance-name-sep" style={{ fontFamily: 'var(--font-mono)' }}> | </span>
                {instance.name}
                {instance.specialization && <span className="spec-pill compact" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>{instance.specialization}</span>}
              </>
            )
            : instance.name
          }
          {instance.orchestratorManaged && <span className="orchestrator-bot-icon" title="Orc-managed">⚡</span>}
          {overdriveLevel > 0 && (
            <span
              className={`od-badge od-level-${overdriveLevel}${isExpiringSoon ? ' od-pulse' : ''}`}
              style={{ fontFamily: 'var(--font-pixel)', fontSize: '7px' }}
              title={`Overdrive Lv.${overdriveLevel} — ${overdrive.label} | ${instance.overdriveTasks} tasks | Cache expires in ${minsLeft}min | ~${overdrive.savings}% token savings`}
            >
              Lv.{overdriveLevel}
            </span>
          )}
        </div>
        {instance.orchestratorManaged && instance.activeTaskTitle && instance.state === 'running' && (
          <div className="instance-active-task" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
            <span className="instance-active-task-elapsed">{elapsedMins}m</span>{' on '}
            <button
              className="instance-active-task-link"
              onClick={(e) => {
                e.stopPropagation()
                dispatch({ type: 'SET_PIPELINE_PROJECT', projectId: instance.folderId })
                dispatch({ type: 'SET_VIEW', payload: 'pipeline' })
              }}
              title={instance.activeTaskTitle}
            >
              {instance.activeTaskTitle.length > 35
                ? instance.activeTaskTitle.slice(0, 35) + '...'
                : instance.activeTaskTitle}
            </button>
          </div>
        )}
      </div>
      {unread > 0 && <span className="instance-badge">{unread}</span>}
      <button
        className="instance-close-btn"
        onClick={handleDelete}
        title="Close session"
      >
        ×
      </button>

      {contextMenu && createPortal(
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 199 }}
            onClick={(e) => { e.stopPropagation(); setContextMenu(null) }}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null) }}
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
                {instance.orchestratorManaged ? 'Release from The Orc' : 'Feed to The Orc'}
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
        </>,
        document.body
      )}
    </div>
  )
}
