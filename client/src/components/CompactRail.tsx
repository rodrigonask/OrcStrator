import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { IconGrid, IconChat, IconPipeline, IconSessions, IconSkills, IconUsage, IconActivity, IconSettings, IconExpand, type IconProps } from './icons'
import { useUI } from '../context/UIContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useActiveInstances, type ActiveInstance } from '../hooks/useActiveInstances'
import { useInstanceContextMenu } from '../hooks/useInstanceContextMenu'
import { useOpenInstance } from '../hooks/useOpenInstance'
import { ConnectionStatus } from './ConnectionStatus'
import { ShutdownButton } from './ShutdownButton'
import type { FolderConfig, InstanceConfig } from '@shared/types'
import type { ViewName } from '../context/UIContext'
import { usePendingSurfaces } from '../hooks/usePendingSurfaces'
import { useTroubledSchedules, troubledTitle } from '../hooks/useTroubledSchedules'

const NAV_ITEMS: { key: ViewName; Icon: ComponentType<IconProps>; label: string }[] = [
  { key: 'grid', Icon: IconGrid, label: 'Grid' },
  { key: 'chat', Icon: IconChat, label: 'Chat' },
  { key: 'pipeline', Icon: IconPipeline, label: 'Pipeline' },
  { key: 'sessions', Icon: IconSessions, label: 'Sessions' },
  { key: 'skills', Icon: IconSkills, label: 'Skills' },
  { key: 'usage', Icon: IconUsage, label: 'Usage' },
  { key: 'activity', Icon: IconActivity, label: 'Activity' },
]

/**
 * Two characters taken off the chat name, which is the entire point of the chip.
 *
 * Initials of the first two words when there are two ("Grid task panel" becomes GT), the
 * first two letters when there is one ("Webhooks" becomes WE). Not the project: several
 * chats share a project, and the thing that needs identifying here is the chat. Collisions
 * happen and are fine, because the label narrows twelve dots to one or two candidates and
 * the flyout beside it settles which. That is a job the bare dot could not even start.
 */
function initials(name: string): string {
  const words = name.trim().split(/[\s_\-/]+/).filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/**
 * Three words, and only ever these three: paused, waiting, running.
 *
 * The row used to spell out its reason ("Waiting on your plan approval", "Cache still
 * warm"), which put a sentence in front of a number the user was actually reading. Worse, the
 * sentences were different lengths, so the cache figures beside them landed at a
 * different x on every row and the column could not be scanned at all. The state is a
 * label, not an explanation: paused means the process is done but the cache is still
 * live, which is exactly what the "Nm left" beside it already quantifies.
 */
function stateOf(a: ActiveInstance): 'waiting' | 'running' | 'paused' {
  return a.awaitingInput != null ? 'waiting' : a.isRunning ? 'running' : 'paused'
}

/**
 * One active session in the rail: a state dot with two letters under it.
 *
 * The dot on its own encoded STATE and nothing else, so a column of them answered "three
 * things are running" and could never answer "which three". Identity lived only in the
 * tooltip, which puts a hover and a delay between the user and a question the old top bar
 * answered at rest, twelve times over.
 *
 * The dot stays a dot. It is the colour signal, and colour in a 32px strip belongs in
 * something small rather than a filled 26px block. The label sits UNDER it in muted mono,
 * so a chip reads as "the green one, GT" and the green never grows into a surface.
 */
function RailDot({ a, projLabel, onOpen }: {
  a: ActiveInstance
  projLabel: string
  onOpen: (inst: InstanceConfig) => void
}) {
  const { inst, cache } = a
  const { onContextMenu, menu, isOpen } = useInstanceContextMenu(inst)
  const state = stateOf(a)
  const cacheLine = cache?.ratio != null
    ? `, ${cache.ratio}% cache hit, ${cache.minsLeft}m to expiry`
    : cache != null ? `, ${cache.minsLeft}m to expiry` : ''

  return (
    <button
      className={`rail-dot is-${state}${isOpen ? ' context-open' : ''}${cache != null && cache.minsLeft <= 5 && state !== 'waiting' ? ' expiring' : ''}`}
      onClick={() => onOpen(inst)}
      onContextMenu={onContextMenu}
      /* aria-label, never title. A native tooltip is an OS window: it paints above the
         flyout no matter what the stack context says, and hovering a chip is exactly when
         the flyout is open, so the browser covered the panel with a duplicate of the panel.
         The flyout row beside the chip already says all of this, laid out and legible. */
      aria-label={`${projLabel} · ${inst.name}, ${state}${cacheLine}`}
    >
      <span className="rail-dot-mark" aria-hidden="true" />
      <span className="rail-dot-label">{initials(inst.name)}</span>
      {menu}
    </button>
  )
}

/** One row of the flyout: what the chip's tooltip said, laid out and readable without a wait. */
function RailFlyoutRow({ a, projLabel, onOpen, onPicked }: {
  a: ActiveInstance
  projLabel: string
  onOpen: (inst: InstanceConfig) => void
  onPicked: () => void
}) {
  const { inst, cache } = a
  const { onContextMenu, menu, isOpen } = useInstanceContextMenu(inst)
  const state = stateOf(a)

  return (
    <button
      className={`rail-flyout-row is-${state}${isOpen ? ' context-open' : ''}`}
      onClick={() => { onOpen(inst); onPicked() }}
      onContextMenu={onContextMenu}
    >
      <span className="rail-flyout-mark" aria-hidden="true" />
      <span className="rail-flyout-text">
        <span className="rail-flyout-name">
          <span className="rail-flyout-proj">{projLabel} · </span>{inst.name}
        </span>
        {/* Three fixed-width columns, and the two cache cells are ALWAYS rendered, empty
            when a chat has no warm cache. Conditional cells collapse, and a collapsed cell
            drags the next row's numbers left, so a column of five sessions had its
            percentages at five different offsets. Blank holds the slot. */}
        <span className="rail-flyout-why">
          <span className="rail-flyout-state">{state}</span>
          <span className="rail-flyout-pct">{cache?.ratio != null ? `${cache.ratio}% cache` : ''}</span>
          <span className="rail-flyout-ttl">{cache != null ? `${cache.minsLeft}m left` : ''}</span>
        </span>
      </span>
      <span className="rail-flyout-key">{initials(inst.name)}</span>
      {menu}
    </button>
  )
}

/**
 * The active-session column, plus the panel that says what its chips are.
 *
 * Hover opens the panel, and it opens OVER the grid rather than widening the rail: a rail
 * that grew on hover would reflow every tile beside it, and this mode exists to stop things
 * moving. Leaving closes it, so at rest the strip is still 32px of almost nothing.
 *
 * The hover that opens it belongs to the WHOLE rail (see CompactRail), not to the dot
 * column. Aiming at a 28px chip to find out what is running is a precision task in service
 * of a glance, and the rail has nothing else on it that a hover could mean.
 *
 * It also opens itself for two seconds when a chat becomes blocked on the user. That is the one
 * state the user cannot afford to miss and the one the rail was worst at: an amber dot appearing
 * in a column of twelve is a forty-pixel change on a 3440px screen. Two seconds is long
 * enough to read the name and short enough to be gone before it is in the way, and hovering
 * at any point during it keeps it open.
 */
function RailActives({ actives, folderById, onOpen, hovering }: {
  actives: ActiveInstance[]
  folderById: Map<string, FolderConfig>
  onOpen: (inst: InstanceConfig) => void
  hovering: boolean
}) {
  // Picking a row closes the panel: the click already took the user somewhere else, and a panel
  // left hanging over the chat they just asked for is in the way. It re-arms the moment the
  // pointer leaves the rail, so it is a dismissal and not a mode.
  const [dismissed, setDismissed] = useState(false)
  const [flash, setFlash] = useState(false)
  const prevWaiting = useRef<Set<string> | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const waitingKey = actives.filter(a => a.awaitingInput != null).map(a => a.inst.id).join(',')

  useEffect(() => {
    const ids = waitingKey ? waitingKey.split(',') : []
    const before = prevWaiting.current
    prevWaiting.current = new Set(ids)
    // Nothing is blocked any more, so neither is the reason the panel opened itself. A
    // flash left running past its cause is the panel sitting over the grid for no reason,
    // and that is exactly what it looked like from the outside: stuck.
    if (ids.length === 0) {
      if (flashTimer.current) { clearTimeout(flashTimer.current); flashTimer.current = null }
      setFlash(false)
      return
    }
    // First pass seeds the baseline and never flashes. On mount EVERY blocked chat is
    // "new", so a reload with one stale awaiting_input row in the DB re-opened the panel
    // on its own, every single refresh — which reads as a card that will not go away
    // rather than as an alert. The flash belongs to the TRANSITION into blocked, which by
    // definition cannot happen on the first render.
    if (before == null) return
    if (!ids.some(id => !before.has(id))) return
    setFlash(true)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(false), 2000)
  }, [waitingKey])

  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

  useEffect(() => { if (!hovering) setDismissed(false) }, [hovering])

  const open = ((hovering && !dismissed) || flash) && actives.length > 0
  const projectOf = useCallback((a: ActiveInstance) => {
    const f = folderById.get(a.inst.folderId)
    return f?.displayName || f?.name || 'Unknown'
  }, [folderById])

  return (
    <div className="rail-actives">
      {/* Scrolls on its own rather than growing the rail: on a busy afternoon this list is
          longer than the screen, and it sits between the two fixed clusters, so without
          its own scroller it would push settings and shutdown off the bottom. */}
      <div className="compact-rail-dots">
        {actives.map(a => (
          <RailDot key={a.inst.id} a={a} projLabel={projectOf(a)} onOpen={onOpen} />
        ))}
      </div>
      {open && (
        <div className={`rail-flyout${flash && !hovering ? ' is-flash' : ''}`}>
          <div className="rail-flyout-head">Active sessions</div>
          {actives.map(a => (
            <RailFlyoutRow
              key={a.inst.id}
              a={a}
              projLabel={projectOf(a)}
              onOpen={onOpen}
              onPicked={() => setDismissed(true)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Ultra Compact Mode's replacement for the horizontal top bar: a 32px rail pinned to the
 * right edge of the app.
 *
 * Why a rail and not just "hide the top bar". The bar costs 46px of HEIGHT, which is the
 * scarce axis in a multi-row grid; the rail spends 32px of WIDTH, which on an ultrawide
 * is free. And it is the mode's exit: a density mode you can only leave by remembering a
 * keyboard shortcut is a trap, so the way out is always on screen, TOP of the rail —
 * the same corner as the button that turned the mode on, so toggling never moves the
 * cursor across the whole screen to chase a control that just relocated.
 *
 * It carries everything the bar carried: connection, nav, settings, shutdown, and one
 * entry per active session. Not the sidebar toggle, though the bar held that too: the
 * sidebar is a strip on the OPPOSITE edge in this mode, and a button here would mean
 * crossing the whole screen to move a panel you are already looking at. That one lives
 * on the sidebar itself.
 */
export function CompactRail({ onExit }: { onExit: () => void }) {
  const { view, showSettings, activePipelineId } = useUI()
  const pendingSurfaces = usePendingSurfaces()
  const troubled = useTroubledSchedules()
  const { folders } = useInstances()
  const { dispatch } = useAppDispatch()
  const active = useActiveInstances()
  const openInstance = useOpenInstance()

  const folderById = useMemo(() => {
    const m = new Map<string, FolderConfig>()
    for (const f of folders) m.set(f.id, f)
    return m
  }, [folders])

  /**
   * The rail is one hover target, end to end.
   *
   * It used to be just the dot column, which made "what is running" a pointing exercise:
   * land inside a 28px chip or get nothing. The rail has no other hover meaning, so the
   * whole strip opens the panel now, including the nav icons and the gap around them.
   *
   * The grace period is the other half of the same bug. The panel renders to the LEFT of
   * the rail, so reaching it means travelling left, and any pixel of dead space on the way
   * fired mouseleave and closed it before the cursor arrived. The gap itself is gone (the
   * panel is flush against the rail now), and this 220ms is the belt to that pair of
   * braces: a diagonal that clips a corner, or the pointer crossing the panel's own rounded
   * edge, no longer counts as leaving. Re-entering cancels it, so a deliberate exit still
   * closes it immediately-ish and it never sticks.
   */
  const [railHover, setRailHover] = useState(false)
  const railRef = useRef<HTMLDivElement>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enterRail = useCallback(() => {
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null }
    setRailHover(true)
  }, [])
  const leaveRail = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => setRailHover(false), 220)
  }, [])
  const closeRail = useCallback(() => {
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null }
    setRailHover(false)
  }, [])
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current) }, [])

  /**
   * The panel closes because the pointer is somewhere else, NOT because a mouseleave
   * arrived. This is the fix for the card that would not go away.
   *
   * mouseleave is an event, and an event can go missing. The flyout is a descendant that
   * paints OUTSIDE the rail's box, so it appears and disappears under a stationary cursor,
   * and every one of those removals is a boundary event fired at an element that is on its
   * way out of the DOM. Miss the leave once and `railHover` is latched true forever: the
   * panel then survives the pointer walking away, and it survives a reload too, because
   * the next flash re-opens it and the next missed leave re-latches it. There is no
   * gesture that clears it, which is why it looked permanent.
   *
   * While the panel is open, a document-level pointermove settles it from the truth
   * instead: is the pointer inside the rail subtree right now, yes or no. Any movement
   * anywhere on screen re-answers the question, so a missed event costs one mouse move
   * rather than the rest of the session. The 220ms grace stays on the "no" branch, so
   * clipping a corner on the way to the panel still does not close it.
   */
  useEffect(() => {
    if (!railHover) return
    const onMove = (e: PointerEvent) => {
      const el = railRef.current
      const t = e.target
      if (el && t instanceof Node && el.contains(t)) enterRail()
      else leaveRail()
    }
    // Pointer left the window, or the window lost focus (alt-tab, another app): there is
    // no pointermove coming to correct it, so close now rather than wait for one.
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerleave', closeRail)
    window.addEventListener('blur', closeRail)
    return () => {
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerleave', closeRail)
      window.removeEventListener('blur', closeRail)
    }
  }, [railHover, enterRail, leaveRail, closeRail])

  const handleNavClick = useCallback((target: ViewName) => {
    if (target === 'pipeline') {
      const pipelineId = activePipelineId || folders[0]?.id || null
      if (pipelineId) dispatch({ type: 'SET_PIPELINE_PROJECT', projectId: pipelineId })
    }
    if (target !== 'chat') dispatch({ type: 'SELECT_INSTANCE', payload: null })
    dispatch({ type: 'CLOSE_SETTINGS' })
    dispatch({ type: 'SET_VIEW', payload: target })
  }, [dispatch, activePipelineId, folders])

  return (
    <div className="compact-rail" ref={railRef} onMouseEnter={enterRail} onMouseLeave={leaveRail}>
      <div className="compact-rail-top">
        {/* Topmost, above the grid icon, and nothing above it. The button that turns the
            mode ON lives at the top-right of the top bar, so putting its counterpart at
            the BOTTOM of the rail meant every toggle was a full-height mouse trip to a
            control that had just moved out from under the cursor. On/off is one gesture
            in one place now: click, and the button you clicked is still there. */}
        <button
          className="rail-exit"
          onClick={onExit}
          title="Leave Ultra Compact Mode (Ctrl+Shift+U)"
        >
          <IconExpand size={15} />
        </button>
        <span className="rail-sep" />
        {NAV_ITEMS.map(({ key, Icon, label }) => {
          // Same badge as TopBar's: a scheduled run surfaced while the grid was off screen.
          // The rail is what is actually on screen in Ultra Compact, so it has to carry it.
          // Owed is owed: on an unblocked grid the queue drains in the same tick, so the count is
          // already zero there. If it is not zero on the grid, a maximized tile is hiding the
          // surfaced one, and the dot is the only signal left.
          const owed = key === 'grid' && pendingSurfaces > 0
          // Same red dot as the top bar, and it has to be in BOTH: Ultra Compact hides the
          // top bar entirely, so a rail without it means a broken routine is invisible in
          // exactly the layout that is left running.
          const broken = key === 'pipeline' && troubled.count > 0
          return (
            <button
              key={key}
              className={`sidebar-nav-btn${view === key && !showSettings ? ' active' : ''}${owed ? ' has-surface' : ''}${broken ? ' has-trouble' : ''}`}
              onClick={() => handleNavClick(key)}
              title={owed
                ? `${label}: ${pendingSurfaces} scheduled run${pendingSurfaces === 1 ? '' : 's'} waiting`
                : broken ? troubledTitle(troubled.count, troubled.titles) : label}
            >
              <Icon size={16} />
              {owed && <span className="nav-surface-dot" aria-hidden="true" />}
              {broken && <span className="nav-trouble-dot" aria-hidden="true" />}
            </button>
          )
        })}
      </div>

      <RailActives actives={active} folderById={folderById} onOpen={openInstance} hovering={railHover} />

      <div className="compact-rail-bottom">
        <button
          className={`sidebar-nav-btn${showSettings ? ' active' : ''}`}
          onClick={() => dispatch({ type: 'OPEN_SETTINGS' })}
          title="Settings"
        >
          <IconSettings size={16} />
        </button>
        <ShutdownButton />
        <ConnectionStatus />
      </div>
    </div>
  )
}
