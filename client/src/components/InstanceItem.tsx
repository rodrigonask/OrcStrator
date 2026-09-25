import { useState, useEffect, useRef, useMemo } from 'react'
import type { InstanceConfig, ChatMessage } from '@shared/types'
import { useUI } from '../context/UIContext'
import { useMessages } from '../context/MessagesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useOverdriveLevel } from '../hooks/useOverdriveLevel'
import { sounds } from '../utils/sounds'
import { vfxBus } from '../systems/vfx-bus'
import { resolveAnimTier, resolveSoundTier } from '../hooks/useVFX'
import { useInstanceContextMenu } from '../hooks/useInstanceContextMenu'
import { flashTile } from '../systems/tile-flash'
import './instance-extras.css'

interface InstanceItemProps {
  instance: InstanceConfig
  dragHandleProps?: Record<string, unknown>
  extraClass?: string
}

function getCacheTier(pct: number): string {
  if (pct >= 90) return 'purple'
  if (pct >= 80) return 'green'
  if (pct >= 65) return 'yellow'
  if (pct >= 50) return 'orange'
  return 'red'
}

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


export function InstanceItem({ instance, dragHandleProps, extraClass }: InstanceItemProps) {
  const { selectedInstanceId, view, settings, gridInstanceIds, sessionCosts } = useUI()
  const { messages: allMessages, unreadCounts, cliPrompts } = useMessages()
  const { dispatch, selectInstance, addToGrid } = useAppDispatch()
  const isSelected = selectedInstanceId === instance.id
  const messages: ChatMessage[] = allMessages[instance.id] || []
  const unread = unreadCounts?.[instance.id] || 0

  const { onContextMenu, menu, isOpen: contextOpen } = useInstanceContextMenu(instance)

  const animTier = resolveAnimTier(settings)
  const soundTier = resolveSoundTier(settings)
  const animEnabled = animTier >= 1
  const soundEnabled = soundTier >= 2

  const [animClass, setAnimClass] = useState<string | null>(null)
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

  // Cache indicator (computed before the effect that depends on it)
  const sessionCost = sessionCosts[instance.id]
  const cacheTtlMs = settings.promptCache1h !== false ? 3_600_000 : 300_000
  const cacheRatio = sessionCost && sessionCost.totalInput > 0
    ? Math.round(sessionCost.totalCacheRead / sessionCost.totalInput * 100)
    : null
  const cacheExpiry = sessionCost?.lastCacheCreatedAt != null
    ? sessionCost.lastCacheCreatedAt + cacheTtlMs
    : null
  const now = Date.now()
  const cacheMinsLeft = cacheExpiry ? Math.max(0, Math.floor((cacheExpiry - now) / 60_000)) : null
  const cacheExpired = cacheExpiry !== null && now >= cacheExpiry
  const showCache = sessionCost != null && sessionCost.totalCacheRead > 0 && cacheExpiry != null && !cacheExpired

  // Cache countdown: re-render every 30s so the minutes display stays fresh
  useEffect(() => {
    if (sessionCost?.lastCacheCreatedAt == null) return
    const id = setInterval(() => forceUpdate(n => n + 1), 30_000)
    return () => clearInterval(id)
  }, [sessionCost?.lastCacheCreatedAt])

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
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  // Overdrive tier-up animation
  const prevOdLevelRef = useRef(overdriveLevel)
  useEffect(() => {
    const prev = prevOdLevelRef.current
    prevOdLevelRef.current = overdriveLevel
    if (overdriveLevel > prev && prev >= 0) {
      triggerAnim('od-levelup-anim', 600)
      playMegamanJingle()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overdriveLevel])

  const activeAnimClass = animClass || ''

  // State lives in the name color, and ONLY for chats open in the grid — a colored
  // name means "this chat has a tile". Closed chats keep the default color.
  // green = running · red = waiting on input · yellow = finished, unviewed · gray = acknowledged
  //
  // "Blocked on your answer" is carried the same way, as colour on the name, NOT as an
  // extra dot: a conditionally rendered dot shifts the whole name sideways the moment a
  // chat blocks and snaps it back when answered, which is exactly the jitter this sidebar
  // avoids everywhere else. It outranks running/unread because it is the only state that
  // cannot progress without the user, and unlike the others it shows even for a chat with no
  // grid tile, since a question you cannot see is the whole bug being fixed here.
  const isOpenInGrid = gridInstanceIds.includes(instance.id)
  // Scheduled sits above the grid-membership cut, like awaiting: a surfaced chat that got
  // evicted from a full grid has no tile, and the sidebar is then the only place its
  // "a schedule ran here, waiting on you" can still be seen.
  const nameStateClass = instance.awaitingInput ? ' inst-awaiting'
    : instance.surfacedAt != null && instance.state !== 'running' ? ' inst-scheduled'
    : !isOpenInGrid ? ''
    : instance.state === 'running' ? ' inst-running'
    : cliPrompts?.[instance.id] ? ' inst-input-needed'
    : unread > 0 ? ' inst-unread'
    : ' inst-open-idle'

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
      className={`instance-item ${isSelected ? 'selected' : ''}${contextOpen ? ' context-open' : ''} state-${instance.state} ${extraClass || activeAnimClass}`}
      {...(safeDragProps as React.HTMLAttributes<HTMLDivElement>)}
      onClick={() => {
        if (view === 'chat') {
          // In the full chat view, clicking keeps the existing behavior: switch chats
          selectInstance(instance.id)
        } else {
          // Grid is home: from the grid (or any other view) clicking an instance
          // opens/focuses its tile. addToGrid touches if already present.
          addToGrid(instance.id)
          if (view !== 'grid') {
            dispatch({ type: 'SET_VIEW', payload: 'grid' })
            // Tiles mount on the view switch — flash after they've subscribed
            if (isOpenInGrid) setTimeout(() => flashTile(instance.id), 80)
          } else if (isOpenInGrid) {
            // Already visible in the grid — pulse so it's easy to spot
            flashTile(instance.id)
          }
        }
        dispatch({ type: 'CLOSE_SETTINGS' })
      }}
      onContextMenu={onContextMenu}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); window.open(window.location.href, '_blank') } }}
    >
      {(instance.dirtyCount ?? 0) > 0 && (
        <span
          className="uncommitted-gutter"
          aria-label="Uncommitted changes"
          title={`${instance.dirtyCount} uncommitted file${(instance.dirtyCount ?? 0) !== 1 ? 's' : ''} edited by this session — commit before closing`}
        />
      )}
      <div className="instance-info">
        <div className={`instance-name${nameStateClass}`} style={{ fontFamily: 'var(--font-sans)', fontSize: '13px' }}>
          <span className="instance-name-text">{instance.name}</span>
          {overdriveLevel > 0 && (
            <span className="od-badge-wrap">
              <span
                className={`od-badge od-level-${overdriveLevel}${isExpiringSoon ? ' od-pulse' : ''}`}
                style={{ fontFamily: 'var(--font-pixel)', fontSize: '7px' }}
              >
                {overdrive.label}
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
        {instance.activeTaskTitle && instance.state === 'running' && (
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
      {showCache && (
        <div
          className="cache-indicator"
          title={`${cacheRatio}% cache hit${cacheMinsLeft !== null ? `\n${cacheMinsLeft} minutes for cache to expire` : ''}`}
        >
          <span className={`cache-pct cache-tier-${getCacheTier(cacheRatio!)}`}>
            {cacheRatio}%
          </span>
          {cacheMinsLeft !== null && (
            <span className={`cache-ttl${cacheMinsLeft <= 5 ? ' cache-expiring' : ''}`}>
              {cacheMinsLeft}m
            </span>
          )}
        </div>
      )}
      {unread > 0 && <span className="instance-badge">{unread}</span>}

      {menu}
    </div>
  )
}
