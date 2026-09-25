import { useMemo, useCallback, useState, useRef, useEffect } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS as DndCSS } from '@dnd-kit/utilities'
import { api } from '../../api'
import { useUI, UIContext } from '../../context/UIContext'
import { useInstances } from '../../context/InstancesContext'
import { useMessages } from '../../context/MessagesContext'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { CompactContext } from '../../context/CompactContext'
import { resolveContextWindow, resolveModelId, DEFAULT_MODEL_ID } from '@shared/constants'
import type { InstanceConfig } from '@shared/types'
import { MessageList } from '../MessageList'
import { MessageInput } from '../MessageInput'
import { NativeTaskPanel } from '../NativeTaskPanel'
import { folderColor } from '../../utils/folderColor'
import { onTileFlash } from '../../systems/tile-flash'
import type { TileFlashKind } from '../../systems/tile-flash'
import { tileMounted, tileUnmounted } from '../../systems/surface-queue'
import { useCacheKeeper } from '../../hooks/useCacheKeeper'
import { useCacheWarm } from '../../hooks/useCacheWarm'
import { useInstanceContextMenu } from '../../hooks/useInstanceContextMenu'
import { IconFlame, IconCompact } from '../icons'
import '../instance-extras.css'

/**
 * Scopes the existing chat components to a specific instance by overriding
 * `selectedInstanceId` in UIContext — the same pattern the split view uses.
 * MessageList / MessageInput read the id from useUI(), so they work unmodified.
 */
function InstanceScope({ instanceId, children }: { instanceId: string; children: React.ReactNode }) {
  const ui = useUI()
  const overridden = useMemo(() => ({ ...ui, selectedInstanceId: instanceId }), [ui, instanceId])
  return <UIContext.Provider value={overridden}>{children}</UIContext.Provider>
}

// Tile chrome is colored by STATE only (no per-chat identity colors):
// green = running · red = waiting on user input · yellow = finished, not yet viewed ·
// gray = open and acknowledged.
// amber = blocked on the user's answer (see awaiting below)
// bright yellow = a SCHEDULED run finished and is waiting on you (see scheduled below)
export type TileState = 'running' | 'awaiting' | 'attention' | 'scheduled' | 'unread' | 'idle'

// What the bright-yellow dot says it is waiting on. Keyed by SurfaceSource, so a new kind
// of autonomous start gets a sentence here instead of falling back to the scheduled one.
//
// The 'routine' key is the SurfaceSource token and is deliberately unchanged: it means
// "the scheduler started this turn", which is still exactly what happened. Only the
// sentence the user reads moved on, because what fires now is a card carrying a schedule.
const SCHEDULED_TITLES: Record<NonNullable<InstanceConfig['surfacedSource']>, string> = {
  routine: 'A scheduled card ran here and is waiting on you',
  wakeup: 'A wake-up ran here and is waiting on you',
  task: 'A task started here and is waiting on you',
}

export const TILE_STATE_COLORS: Record<TileState, { accent: string; bright: string }> = {
  running:   { accent: '#16a34a', bright: '#22c55e' },
  // Its own amber rather than reusing 'attention' red: this state is already amber on the
  // top-bar chip, the header dot and the sidebar name, and one concept should not change
  // colour depending on which surface you look at. 'attention' stays red for CLI stdin
  // prompts, which is a different mechanism and is not this change's to restyle.
  awaiting:  { accent: '#d97706', bright: '#f59e0b' },
  attention: { accent: '#dc2626', bright: '#ef4444' },
  // Deliberately BRIGHTER than unread's yellow, and only that: it is the same message
  // ("waiting on you") with one extra fact ("and you did not start this, a schedule did").
  // The two sit side by side in a busy grid and must read as siblings, not as different
  // concepts, so the hue stays yellow and only the brightness moves.
  scheduled: { accent: '#facc15', bright: '#fde047' },
  unread:    { accent: '#ca8a04', bright: '#eab308' },
  idle:      { accent: 'var(--border)', bright: 'var(--text-muted)' },
}

interface GridTileProps {
  instanceId: string
  focused: boolean
  maximized: boolean
  hidden: boolean
}

export function GridTile({ instanceId, focused, maximized, hidden }: GridTileProps) {
  const { settings, sessionCosts } = useUI()
  const { instances, folders } = useInstances()
  const { dispatch, ackSurface } = useAppDispatch()
  const instance = instances.find(i => i.id === instanceId)
  const folder = instance ? folders.find(f => f.id === instance.folderId) : undefined

  // Keep-warm 🔥 + compact controls for this session (shared with the full chat header).
  const { keepWarm, ctxHeavy, hasSession, compacting, toggleKeepWarm, doCompact } = useCacheKeeper(instance)

  // Still holding its prompt cache, so still a live conversation rather than an archive.
  const cacheWarm = useCacheWarm(instanceId)

  // Right-click menu (Pin / Split View / Rename / Close) — the same shared menu
  // used by the TopBar tabs and the sidebar rows, so they can't drift apart.
  const { onContextMenu, menu, isOpen: contextOpen } = useInstanceContextMenu(instance)

  // State-colored chrome: waiting-on-you > running > waiting-on-input > unread > idle.
  //
  // awaitingInput outranks everything. Without it a blocked tile renders gray 'idle' chrome
  // (its process really is idle after the hard-stop kill, and unread is suppressed for
  // visible tiles), so in Grid, the view this app is actually used in, the one tile waiting
  // on the user would look the most inert thing on screen.
  const { messages, unreadCounts, cliPrompts, permissionRequests } = useMessages()
  //
  // 'scheduled' sits just above unread: a scheduled run is GREEN while it works, exactly
  // like any other, and flips to bright yellow the moment it finishes unread. surfacedAt is
  // server truth (it survives a reload and a restart) and is cleared by the ack on focus,
  // so the bright status lasts until the user actually looks, hours if need be.
  const tileState: TileState =
    instance?.awaitingInput ? 'awaiting'
    // A chat blocked on an Allow/Deny banner is waiting on a person, not working. Ranked above
    // 'running' for the same reason awaitingInput is: its process IS still running, so the one
    // tile that needs a click would otherwise render as the busiest thing on screen.
    : (permissionRequests?.[instanceId]?.length ?? 0) > 0 ? 'attention'
    : instance?.state === 'running' ? 'running'
    : cliPrompts?.[instanceId] ? 'attention'
    : instance?.surfacedAt != null ? 'scheduled'
    : (unreadCounts?.[instanceId] ?? 0) > 0 ? 'unread'
    : 'idle'
  const stateColors = TILE_STATE_COLORS[tileState]

  // "This one just answered and you have not read it yet."
  //
  // Keyed on the id of the last message rather than on a timer. A five-minute window drops
  // the signal exactly where it is worth most: the turns that landed while you were in a
  // meeting are the ones you have no other way of finding. Acknowledging costs one click,
  // and it is the click you were going to make anyway to read the answer.
  //
  // unreadCounts cannot do this job: the server suppresses unread for tiles that are on
  // screen, which in Grid is all of them.
  const tileMsgs = messages[instanceId]
  const lastMsg = tileMsgs && tileMsgs.length > 0 ? tileMsgs[tileMsgs.length - 1] : undefined
  const doneMsgId = lastMsg?.role === 'assistant' ? lastMsg.id : null
  const [ackedMsgId, setAckedMsgId] = useState<string | null>(null)
  useEffect(() => {
    if (focused && doneMsgId) setAckedMsgId(doneMsgId)
  }, [focused, doneMsgId])
  const justFinished =
    tileState !== 'running' && tileState !== 'awaiting' && !!doneMsgId && doneMsgId !== ackedMsgId

  // Mini context gauge — same resolution logic as ChatHeader's full gauge
  const ctx = useMemo(() => {
    const modelId = instance?.ctxModel || (settings.defaultModel && settings.defaultModel !== 'default'
      ? resolveModelId(settings.defaultModel)
      : DEFAULT_MODEL_ID)
    const max = resolveContextWindow(modelId)
    const used = instance?.ctxTokens ?? 0
    const pct = max > 0 ? Math.min((used / max) * 100, 100) : 0
    const color = 'var(--text-muted)' // muted always — matches the mockup; high-context still surfaces via the tooltip + auto-compact
    return { pct, color, used, max, modelId }
  }, [instance?.ctxTokens, instance?.ctxModel, settings.defaultModel])

  const handleFocus = useCallback(() => {
    dispatch({ type: 'GRID_TOUCH', payload: instanceId })
    dispatch({ type: 'CLEAR_UNREAD', payload: instanceId })
    // Clicking into a tile a scheduled fire surfaced is "I have seen it": the bright
    // status drops here and in every other tab. No-op for an ordinary tile.
    ackSurface(instanceId)
  }, [dispatch, ackSurface, instanceId])

  // Brief glow when this tile is re-opened from the sidebar (locate, 0.6s accent ring), or
  // when a scheduled run surfaced it (scheduled, ~1s bright-yellow glow). The scheduled
  // kind only ever arrives through the surface queue, which has already checked that the
  // grid is on screen and the window is in front, so by the time it reaches here it can
  // be played straight away.
  const [flashing, setFlashing] = useState<TileFlashKind | null>(null)
  useEffect(() => {
    return onTileFlash((id, kind) => {
      if (id !== instanceId) return
      // Toggle off → on across a frame so a rapid re-click restarts the animation
      setFlashing(null)
      requestAnimationFrame(() => setFlashing(kind))
    })
  }, [instanceId])
  // The class clears itself off the STATE, not off a timer armed inside the listener. A
  // timer armed there gets cleared by StrictMode's simulated unmount when the glow was
  // triggered by this tile's own mount (a queued scheduled glow draining the moment the
  // grid comes back), and the tile then wore the glow class forever. State survives that
  // remount; this effect re-arms on it.
  useEffect(() => {
    if (!flashing) return
    const t = setTimeout(() => setFlashing(null), flashing === 'scheduled' ? 1100 : 620)
    return () => clearTimeout(t)
  }, [flashing])

  // Becoming the focused tile by any route (Ctrl+N, a "take me there" open, a click) is
  // looking at it. Only the TRANSITION into focus acks: focus is sticky, and a fire that
  // lands on a tile the user clicked an hour ago must still turn bright yellow, not be swallowed.
  const wasFocused = useRef(focused)
  useEffect(() => {
    if (focused && !wasFocused.current) ackSurface(instanceId)
    wasFocused.current = focused
  }, [focused, ackSurface, instanceId])

  // Registered AFTER the flash listener above on purpose: mounting can drain a queued
  // scheduled glow synchronously, and the listener has to already be there to catch it.
  useEffect(() => {
    tileMounted(instanceId)
    return () => tileUnmounted(instanceId)
  }, [instanceId])

  const handleMaximizeToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    dispatch({ type: 'GRID_MAXIMIZE', payload: maximized ? null : instanceId })
  }, [dispatch, instanceId, maximized])

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    dispatch({ type: 'GRID_REMOVE', payload: instanceId })
  }, [dispatch, instanceId])

  // Escape inside a tile input blurs it (a second Escape restores the grid — GridView)
  const handleKeyDownCapture = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') t.blur()
    }
  }, [])

  // ── Double-click name → rename ──
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (renaming) { renameRef.current?.focus(); renameRef.current?.select() }
  }, [renaming])
  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setNameDraft(instance?.name ?? '')
    setRenaming(true)
  }, [instance?.name])
  const commitRename = useCallback(() => {
    setRenaming(false)
    const name = nameDraft.trim()
    if (!instance || !name || name === instance.name) return
    dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { name } } })
    api.updateInstance(instance.id, { name }).catch(err => console.error('Rename failed:', err))
  }, [dispatch, instance, nameDraft])

  // Pointer-based drag (dnd-kit): the real tile follows the cursor; the
  // header is the drag handle. HTML5 DnD was replaced — its OS "ghost"
  // image barely renders for large elements on Windows.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: instanceId, disabled: maximized || renaming })

  if (!instance) return null

  // is-running rides the TILE, not just the 6px header dot. Ultra Compact marks the whole
  // card (edge sweep along the top, tinted header band) and dims the ones that are not
  // working, and none of those selectors can reach a class buried on a span.
  //
  // is-waiting exempts a chat that is blocked on the user from the dim entirely. It is not
  // running, so the sweep and the band would be lying about it, but it needs the user more
  // urgently than anything that IS running, and the greyscale would take the amber
  // straight out of its state dot.
  //
  // is-warm exempts one that simply finished recently. A chat that answered a minute ago
  // still holds its cache and its context; a chat untouched for ten days does not, and
  // filing both under "not running" put them in the same grey. The dim marks COLD now,
  // not idle, so what recedes is the stuff you would pay a cold start to pick back up.
  //
  // is-done marks an answer you have not read. It shares the top edge with the running
  // sweep on purpose: one channel, two readings, moving violet for "working" and a still
  // amber line for "finished, your move". Amber because that is already the colour of
  // every state that hands the turn back to you.
  return (
    <div
      ref={setNodeRef}
      className={`grid-tile${instance.state === 'running' ? ' is-running' : ''}${instance.awaitingInput ? ' is-waiting' : ''}${tileState === 'scheduled' ? ' is-scheduled' : ''}${cacheWarm ? ' is-warm' : ''}${justFinished ? ' is-done' : ''}${focused ? ' grid-tile-focused' : ''}${maximized ? ' grid-tile-maximized' : ''}${hidden ? ' grid-tile-hidden' : ''}${isOver && !isDragging ? ' grid-tile-dragover' : ''}${isDragging ? ' grid-tile-dragging' : ''}${flashing === 'locate' ? ' grid-tile-flash' : ''}${flashing === 'scheduled' ? ' grid-tile-flash-scheduled' : ''}`}
      data-instance-id={instanceId}
      style={{
        '--tile-accent': stateColors.accent,
        '--tile-accent-bright': stateColors.bright,
        transform: DndCSS.Transform.toString(transform),
        transition: transform ? transition : undefined,
        zIndex: isDragging ? 50 : undefined,
      } as React.CSSProperties}
      onMouseDownCapture={handleFocus}
      onKeyDownCapture={handleKeyDownCapture}
    >
      <div
        className={`grid-tile-header${contextOpen ? ' context-open' : ''}`}
        {...attributes}
        {...listeners}
        onContextMenu={onContextMenu}
        title="Drag to reorder tiles — right-click for options"
      >
        {/* Blocked on the user beats the process state: 'idle' is technically true after the
            hard-stop kill, and showing it here would say "nothing to do" about the one tile
            that is waiting on the user. Grid is the main working view. */}
        <span
          className={`instance-state-dot ${instance.awaitingInput ? 'awaiting' : tileState === 'scheduled' ? 'scheduled' : instance.state}`}
          title={instance.awaitingInput
            ? (instance.awaitingInput === 'plan' ? 'Waiting on your plan approval' : 'Waiting on your answer')
            : tileState === 'scheduled'
              ? SCHEDULED_TITLES[instance.surfacedSource ?? 'routine']
              : undefined}
        />
        {renaming ? (
          <input
            ref={renameRef}
            className="grid-tile-rename-input"
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') { e.stopPropagation(); setRenaming(false) }
            }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span
            className="grid-tile-name"
            title={`${folder ? (folder.displayName || folder.name) + ' / ' : ''}${instance.name} — click to rename`}
            onClick={startRename}
          >
            {folder && (
              <span className="grid-tile-folder">
                {(folder.displayName || folder.name)}{' · '}
              </span>
            )}
            {instance.name}
          </span>
        )}
        {/* No run clock here any more. It lived in this header for one release and was
            the same number the composer already showed, two corners apart, so one of them
            had to go: the composer keeps it, because that is where the eye is while you
            type. The token count went with it, being per-turn output masquerading as a
            session total. The state dot still says "running". */}
        {ctx.used > 0 && (
          <span
            className="grid-tile-ctx"
            style={{ color: ctx.color }}
            title={`Context: ${Math.round(ctx.used / 1000)}K / ${Math.round(ctx.max / 1000)}K (${ctx.modelId})`}
          >
            {Math.round(ctx.pct)}%
          </span>
        )}
        {(sessionCosts[instanceId]?.totalCost ?? 0) > 0 && (
          <span
            className="grid-tile-cost"
            title={`Session cost: $${sessionCosts[instanceId].totalCost.toFixed(4)} across ${sessionCosts[instanceId].turns} turn(s) — API-equivalent value`}
          >
            ${sessionCosts[instanceId].totalCost < 10
              ? sessionCosts[instanceId].totalCost.toFixed(2)
              : Math.round(sessionCosts[instanceId].totalCost)}
          </span>
        )}
        <span className="grid-tile-spacer" />
        {/* `display: contents` by default, so normal tiles lay out exactly as before.
            Ultra Compact turns it into an absolutely-positioned cluster that fades in on
            hover: the buttons then cost the header zero width (the name and the run
            status get it instead) and revealing them moves nothing, which a
            display:none-until-hover would not manage. */}
        <span className="grid-tile-actions">
        {hasSession && (
          <button
            className={`grid-tile-btn keepwarm-btn${keepWarm ? ' on' : ''}`}
            onClick={toggleKeepWarm}
            onPointerDown={e => e.stopPropagation()}
            title={keepWarm
              ? 'Keep-warm ON — fires a tiny keep-alive before the cache expires so this session never cold-starts. Click to stop.'
              : 'Keep this session warm — auto-pings before the cache goes cold (uses a little quota). Click to enable.'}
          >
            <IconFlame size={13} />
          </button>
        )}
        {hasSession && ctxHeavy && (
          <button
            className={`grid-tile-btn compact-btn${compacting ? ' spin' : ''}`}
            onClick={doCompact}
            onPointerDown={e => e.stopPropagation()}
            disabled={compacting}
            title={`Compact context (~${Math.round((instance.ctxTokens ?? 0) / 1000)}k tokens) → smaller, cheaper cold start`}
          >
            <IconCompact size={13} />
          </button>
        )}
        <button
          className="grid-tile-btn"
          onClick={handleMaximizeToggle}
          onPointerDown={e => e.stopPropagation()}
          title={maximized ? 'Restore grid (F or Esc)' : 'Maximize tile (F, or click the chat and press F; Esc restores)'}
        >
          {maximized ? '⤡' : '⤢'}
        </button>
        <button className="grid-tile-btn grid-tile-close" onClick={handleClose} onPointerDown={e => e.stopPropagation()} title="Close tile">{'✕'}</button>
        </span>
        {menu}
      </div>
      <div className="grid-tile-body">
        <CompactContext.Provider value={true}>
          <InstanceScope instanceId={instanceId}>
            {/* Tiles hidden behind a maximized tile are display:none anyway
                (styles.css: .grid-tile-hidden), so mounting their message list —
                up to 200 items each, ×7 hidden tiles — was pure wasted memory and
                render. Skip it while hidden; the list remounts (landing at the
                bottom) when the tile is restored. The composer stays mounted so any
                in-progress draft survives a maximize-and-restore. */}
            {!hidden && <MessageList scrollKey={maximized} />}
            {/* Claude Code's own task list, in the same slot the CLI keeps it:
                between the transcript and the composer. It reads the instance from
                UIContext, which InstanceScope has already overridden, so it needs no
                props. Grid is the main working view, so mounting it only in
                ChatView made it invisible in practice.
                `dense` opts a MAXIMIZED tile back out of the compact variant: the whole
                reason for compact is that tile height is scarce, which stops being true
                at 1416x1206. It is a prop rather than the CompactContext value because
                MessageList reads that same context for its render cap, and flipping it
                would re-slice the transcript on every maximize. */}
            <NativeTaskPanel dense={!maximized} />
            {/* A tile that mounts already focused was opened by the user's click and may take the
                caret. One that mounts unfocused was added behind the user's back and may not. */}
            <MessageInput autoFocus={focused} />
          </InstanceScope>
        </CompactContext.Provider>
      </div>
    </div>
  )
}
