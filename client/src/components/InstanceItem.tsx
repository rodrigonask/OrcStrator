import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { InstanceConfig, ChatMessage, SkillConfig } from '@shared/types'
import { useUI } from '../context/UIContext'
import { useMessages } from '../context/MessagesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { usePipeline } from '../context/PipelineContext'
import { useFeatureGate } from '../hooks/useFeatureGate'
import { useAgentNames } from '../hooks/useAgentNames'
import { useOverdriveLevel } from '../hooks/useOverdriveLevel'
import { api } from '../api'
import { sounds } from '../utils/sounds'
import { vfxBus } from '../systems/vfx-bus'
import { resolveAnimTier, resolveSoundTier } from '../hooks/useVFX'
import { FeatureLockedModal } from './tour/FeatureLockedModal'

interface InstanceItemProps {
  instance: InstanceConfig
  folderOrchestratorActive?: boolean
  dragHandleProps?: Record<string, unknown>
  extraClass?: string
}

const AGENT_ROLES = ['planner', 'builder', 'tester', 'promoter'] as const

/** Megaman-style chiptune ascending arpeggio jingle using Web Audio API */
function playMegamanJingle() {
  try {
    const ctx = new AudioContext()
    const notes = [330, 440, 554, 659, 880, 1047] // E4→C6 ascending
    const noteGap = 0.08
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = freq
      const start = ctx.currentTime + i * noteGap
      const dur = 0.08 + i * 0.024 // last notes ring slightly longer
      gain.gain.setValueAtTime(0.12, start)
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + dur)
    })
  } catch {
    // AudioContext unavailable — silently ignore
  }
}


export function InstanceItem({ instance, folderOrchestratorActive, dragHandleProps, extraClass }: InstanceItemProps) {
  const { selectedInstanceId, view, settings } = useUI()
  const { messages: allMessages, unreadCounts } = useMessages()
  const { dispatch, selectInstance, deleteInstance } = useAppDispatch()
  const isSelected = selectedInstanceId === instance.id
  const messages: ChatMessage[] = allMessages[instance.id] || []
  const unread = unreadCounts?.[instance.id] || 0

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [skills, setSkills] = useState<SkillConfig[]>([])
  const [showSkillsMenu, setShowSkillsMenu] = useState(false)
  const agentsGate = useFeatureGate('agents')
  const [dragTargetHighlight, setDragTargetHighlight] = useState(false)
  const pipeline = usePipeline()

  const animTier = resolveAnimTier(settings)
  const soundTier = resolveSoundTier(settings)
  const animEnabled = animTier >= 1
  const soundEnabled = soundTier >= 2

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

  const { overdriveLevel, overdrive, minsLeft, isExpiringSoon } = useOverdriveLevel(
    instance.overdriveTasks ?? 0, instance.lastTaskAt ?? 0
  )

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
    vfxBus.fire('instance:spawn', { text: instance.name })
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
      vfxBus.fire('instance:activate')
      if (soundEnabled) sounds.activate()
    } else if (prev === 'running') {
      triggerAnim('anim-sleep', 5500)
      vfxBus.fire('instance:sleep')
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

  // Overdrive level-up animation — triggers screen-wide star-power effect
  const prevOdLevelRef = useRef(overdriveLevel)
  const starTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const prev = prevOdLevelRef.current
    prevOdLevelRef.current = overdriveLevel
    if (overdriveLevel > prev && prev >= 0) {
      triggerAnim('od-levelup-anim', 600)
      playMegamanJingle()
      // Screen-wide "Mario star" celebration — gated by animation tier
      if (animTier >= 2) {
        const duration = animTier === 2 ? 6_000 : animTier === 3 ? 10_000 : 15_000
        if (starTimerRef.current) clearTimeout(starTimerRef.current)
        document.body.classList.add('star-power')
        starTimerRef.current = setTimeout(() => {
          document.body.classList.remove('star-power')
          starTimerRef.current = null
        }, duration)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overdriveLevel])

  // Cleanup star-power on unmount
  useEffect(() => {
    return () => {
      if (starTimerRef.current) {
        clearTimeout(starTimerRef.current)
        document.body.classList.remove('star-power')
      }
    }
  }, [])

  useEffect(() => {
    if (contextMenu) {
      api.getSkills().then(setSkills).catch(() => {})
    }
  }, [contextMenu])

  const agentNames = useAgentNames()

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
    vfxBus.fire('instance:remove')
    if (animEnabled) {
      setIsRemoving(true)
      if (soundEnabled) sounds.remove()
      setTimeout(() => deleteInstance(instance.id), 1200) // 1.2s, down from 3.6s
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

  const handleTaskDragOver = useCallback((e: React.DragEvent) => {
    if (!instance.agentRole) return
    // Check if the dragged task's currentStepRole matches this instance's agentRole
    if (e.dataTransfer.types.includes(`application/x-task-role-${instance.agentRole}`)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDragTargetHighlight(true)
    }
  }, [instance.agentRole])

  const handleTaskDragLeave = useCallback(() => {
    setDragTargetHighlight(false)
  }, [])

  const handleTaskDrop = useCallback((e: React.DragEvent) => {
    setDragTargetHighlight(false)
    if (!instance.agentRole) return
    const jsonData = e.dataTransfer.getData('application/json')
    if (!jsonData) return
    try {
      const { taskId, column } = JSON.parse(jsonData)
      if (taskId && column) {
        e.preventDefault()
        e.stopPropagation()
        pipeline.assignAgent(taskId, instance.agentRole)
      }
    } catch { /* ignore */ }
  }, [instance.agentRole, pipeline])

  return (
    <div
      className={`instance-item ${isSelected ? 'selected' : ''} ${instance.orchestratorManaged ? 'orchestrator-managed' : ''} state-${instance.state} ${extraClass || activeAnimClass}`}
      style={{
        ...(instance.state === 'running' && instance.agentRole ? { boxShadow: `0 0 8px 2px color-mix(in srgb, var(--role-${instance.agentRole}) 40%, transparent)` } : {}),
        ...(dragTargetHighlight && instance.agentRole ? { boxShadow: `0 0 12px 3px color-mix(in srgb, var(--role-${instance.agentRole}) 60%, transparent)`, outline: `2px dashed var(--role-${instance.agentRole})`, outlineOffset: '-2px', background: 'var(--bg-hover)' } : {}),
      }}
      {...(safeDragProps as React.HTMLAttributes<HTMLDivElement>)}
      onClick={() => {
        selectInstance(instance.id)
        if (view === 'pipeline') dispatch({ type: 'SET_VIEW', payload: 'chat' })
      }}
      onContextMenu={handleContextMenu}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); window.open(window.location.href, '_blank') } }}
      onDragOver={handleTaskDragOver}
      onDragLeave={handleTaskDragLeave}
      onDrop={handleTaskDrop}
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
                <span className="instance-name-text">
                  <span className="instance-name-sep" style={{ fontFamily: 'var(--font-mono)' }}> | </span>
                  {instance.name}
                  {instance.specialization && <span className="spec-pill compact" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>{instance.specialization}</span>}
                </span>
              </>
            )
            : <span className="instance-name-text">{instance.name}</span>
          }
          {overdriveLevel > 0 && (
            <span className="od-badge-wrap">
              <span
                className={`od-badge od-level-${overdriveLevel}${isExpiringSoon ? ' od-pulse' : ''}`}
                style={{ fontFamily: 'var(--font-pixel)', fontSize: '7px' }}
              >
                Lv.{overdriveLevel}
              </span>
              <span className="od-badge-tip">
                Smart Context Caching — {overdrive.label}<br />
                {instance.overdriveTasks} tasks cached this session<br />
                Cache window expires in {minsLeft}min<br />
                Saves up to 90% on token costs using Claude native prompt caching
              </span>
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
                onClick={() => { if (agentsGate.check()) { handleRoleChange(role); setContextMenu(null) } else { setContextMenu(null) } }}
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

      {agentsGate.showLockedModal && agentsGate.gate && (
        <FeatureLockedModal gate={agentsGate.gate} onClose={agentsGate.dismissModal} />
      )}
    </div>
  )
}
