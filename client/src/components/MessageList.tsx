import { useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { ChatMessage } from '@shared/types'
import { useUI } from '../context/UIContext'
import { useMessagesSelector } from '../context/MessagesContext'
import type { StreamingToolCall } from '../context/MessagesContext'
import { useInstance } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useVerbosity } from '../hooks/useVerbosity'
import { useCompact } from '../context/CompactContext'
import { MessageBubble } from './MessageBubble'
import { ActivityBubble } from './ActivityBubble'
import { ToolCallBlock } from './ToolCallBlock'
import { NestedToolCalls } from './NestedToolCalls'
import { formatToolLabel, toolCallParts } from '../utils/toolFormat'
import { looksLikeDenial } from '../utils/permissionMatch'
import { useRenderCount } from '../utils/renderCount'
import { isPlanFileWrite } from '../utils/planWrite'

type ToolCallEntry = { type: 'tool-call'; toolId: string; toolName: string; input: string; parentToolUseId?: string }

function hasTextContent(msg: ChatMessage): boolean {
  return msg.content.some(b => {
    if (b.type === 'text' && b.text?.trim()) return true
    // Thinking is never rendered (the REASONING blocks
    // were visual noise) — thinking-only messages produce no bubble at all.
    if (b.type === 'image') return true
    if (b.type === 'error') return true
    return false
  })
}

function extractToolCalls(msg: ChatMessage): ToolCallEntry[] {
  return msg.content.filter(b => b.type === 'tool-call') as ToolCallEntry[]
}

type DisplayItem =
  | { kind: 'message'; msg: ChatMessage }
  | { kind: 'tools'; calls: ToolCallEntry[]; key: string }
  | { kind: 'session-summary'; toolCount: number; calls: ToolCallEntry[]; key: string }
  | { kind: 'day'; label: string; key: string }

// Grid tiles are glances, not full readers: in compact mode we render only the most
// recent slice of the conversation, so 8 live tiles don't each mount a 200-item list.
// The full chat view (CompactContext=false) is NEVER capped. "Show earlier in this tile"
// lifts the cap in place; maximizing or opening the chat shows everything as usual.
const COMPACT_RENDER_CAP = 40

// Stable empties, so a chat with nothing yet does not hand every memo a fresh [] each render.
const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_CALLS: StreamingToolCall[] = []

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dayLabel(ts: number): string {
  const d = new Date(ts)
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()}`
}

export function MessageList({ scrollKey }: { scrollKey?: boolean | string } = {}) {
  const { selectedInstanceId: instanceId } = useUI()
  useRenderCount(`list:${instanceId}`)
  // This chat's entries only: another chat streaming, or a tool finishing in
  // another chat, returns the same references here and does not re-render this list.
  const messages: ChatMessage[] = useMessagesSelector(s => (instanceId ? s.messages[instanceId] : undefined)) ?? EMPTY_MESSAGES
  const hasMore = useMessagesSelector(s => (instanceId ? (s.hasMore[instanceId] ?? false) : false))
  const liveText = useMessagesSelector(s => (instanceId ? (s.streamingContent[instanceId] || '') : ''))
  const liveToolCalls = useMessagesSelector(s => (instanceId ? s.streamingToolCalls[instanceId] : undefined)) ?? EMPTY_CALLS
  const liveResults = useMessagesSelector(s => (instanceId ? s.toolResults[instanceId] : undefined))
  const thisInstance = useInstance(instanceId)
  const { loadOlderMessages } = useAppDispatch()
  const verbosity = useVerbosity(instanceId)
  const compact = useCompact()
  const [loadingOlder, setLoadingOlder] = useState(false)

  const handleLoadOlder = useCallback(async () => {
    if (!instanceId || loadingOlder) return
    setLoadingOlder(true)
    try {
      await loadOlderMessages(instanceId)
    } finally {
      setLoadingOlder(false)
    }
  }, [instanceId, loadingOlder, loadOlderMessages])

  const instance = instanceId ? thisInstance : null
  const lastTurnMs = instance?.lastTurnMs
  const lastTurnMessageId = instance?.lastTurnMessageId
  const isAgentRunning = instance?.state === 'running'

  const showLiveTurn = isAgentRunning || !!liveText || liveToolCalls.length > 0

  // Build a map of toolId -> result for the current message set.
  //
  // The `tool-result` blocks below are the shape the type allows, but nothing in the app has
  // ever produced one: results arrive as `tool-complete` events and were only ever written to
  // the streaming buffer, which is cleared on the next assistant message. So this map was
  // always empty, every finished call rendered with no output, and anything keyed off a
  // result (the refusal explainer) could not fire. The live map from AppContext is the real
  // source; message blocks stay first in case they are ever persisted.
  const toolResults = useMemo(() => {
    const map = new Map<string, { output: string; isError?: boolean }>()
    for (const [toolId, r] of Object.entries(liveResults ?? {})) {
      map.set(toolId, r)
    }
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'tool-result') {
          map.set(block.toolId, { output: block.output, isError: block.isError })
        }
      }
    }
    return map
  }, [messages, liveResults])

  // Build display items: text messages, aggregated tool groups, and per-session summaries
  const items = useMemo(() => {
    const result: DisplayItem[] = []
    let pendingTools: ToolCallEntry[] = []
    let pendingKey = ''
    let sessionToolCount = 0
    let sessionCalls: ToolCallEntry[] = []
    const hasSession = messages.length > 0
    let lastDayKey: string | null = null

    const maybeDayDivider = (msg: ChatMessage) => {
      if (!msg.createdAt) return
      const key = new Date(msg.createdAt).toDateString()
      if (lastDayKey !== null && key !== lastDayKey) {
        result.push({ kind: 'day', label: dayLabel(msg.createdAt), key: `day-${key}-${msg.id}` })
      }
      lastDayKey = key
    }

    const flushTools = () => {
      if (pendingTools.length > 0) {
        const hasSpecial = pendingTools.some(tc =>
          tc.toolName === 'AskUserQuestion' || tc.toolName === 'ExitPlanMode'
        )
        if (verbosity >= 2 || hasSpecial) {
          result.push({ kind: 'tools', calls: pendingTools, key: pendingKey + '-tools' })
        }
        pendingTools = []
        pendingKey = ''
      }
    }

    const endSession = (summaryKey: string) => {
      if (hasSession && sessionToolCount > 0) {
        if (verbosity >= 2) {
          result.push({ kind: 'session-summary', toolCount: sessionToolCount, calls: sessionCalls, key: summaryKey })
        }
      }
    }

    for (const msg of messages) {
      const tools = extractToolCalls(msg)
      sessionToolCount += tools.length
      sessionCalls = tools.length > 0 ? [...sessionCalls, ...tools] : sessionCalls
      pendingTools.push(...tools)
      if (!pendingKey && tools.length > 0) pendingKey = msg.id

      if (hasTextContent(msg)) {
        flushTools()
        maybeDayDivider(msg)
        result.push({ kind: 'message', msg })
      }
    }

    flushTools()
    if (!isAgentRunning) {
      endSession('final-session-end')
    }

    return result
  }, [messages, isAgentRunning, verbosity])

  // Compact (grid-tile) cap: render only the most recent slice unless the user expands
  // this tile in place. Reset whenever the chat changes so each freshly-opened tile
  // starts capped. Capping only what's RENDERED (not `items`) keeps tool-result
  // resolution and session summaries correct — they still see the full message set.
  const [compactExpanded, setCompactExpanded] = useState(false)
  useEffect(() => { setCompactExpanded(false) }, [instanceId])

  const visibleItems = useMemo(() => {
    if (!compact || compactExpanded || items.length <= COMPACT_RENDER_CAP) return items
    const sliced = items.slice(-COMPACT_RENDER_CAP)
    // Drop a dangling day-divider the slice may have left at the very top.
    return sliced[0]?.kind === 'day' ? sliced.slice(1) : sliced
  }, [items, compact, compactExpanded])
  const compactTruncated = compact && !compactExpanded && visibleItems.length < items.length

  // Which message carries the "worked for" footnote.
  //
  // Preferred: the exact message the server says ended the timed turn. Guessing "the last
  // assistant message" is wrong three ways, all of which were reproduced: a turn that ends
  // with no result event (AskUserQuestion, plan mode, a user stop) leaves its message to
  // inherit the previous turn's number; a client-side slash-command echo is also
  // role:assistant and steals the footnote; and mid-stream the running turn's first text
  // block becomes "last" while lastTurnMs still describes the previous turn.
  //
  // Fallback, used after a reload where the id is gone: the last assistant message. Right in
  // the ordinary case, and never worse than the guess it replaces. Both paths exclude
  // non-assistant roles, so a user message with no reply yet is never labelled.
  const lastMessageIndex = useMemo(() => {
    if (lastTurnMessageId) {
      const exact = visibleItems.findIndex(
        item => item.kind === 'message' && item.msg.id === lastTurnMessageId
      )
      if (exact !== -1) return exact
    }
    for (let i = visibleItems.length - 1; i >= 0; i--) {
      const item = visibleItems[i]
      if (item.kind === 'message' && item.msg.role === 'assistant') return i
    }
    return -1
  }, [visibleItems, lastTurnMessageId])

  // ── Plain (non-virtualized) scroller with native overflow-anchor ──
  // We dropped react-virtuoso here: it disabled the browser's scroll anchoring and
  // re-measured items asynchronously, which is exactly what made the chat jump on
  // "View more", image loads, and tool-block measurement. A plain scroller keeps the
  // reader's position stable for free (overflow-anchor) and lets new items fade in
  // once (no recycling/remount-on-scroll).
  const scrollerRef = useRef<HTMLDivElement>(null)
  const followingRef = useRef(true)   // pinned to the bottom?
  const hoverRef = useRef(false)      // cursor over this chat → freeze, never auto-scroll
  const [showJump, setShowJump] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  const distFromBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return 0
    return el.scrollHeight - el.scrollTop - el.clientHeight
  }, [])
  const pinningRef = useRef(false)
  const pinToBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    pinningRef.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => { pinningRef.current = false })
  }, [])

  // Disengage following ONLY on real user gestures (wheel up / touch drag). Generic 'scroll'
  // events also fire for our own pins and for overflow-anchor shifts while content streams,
  // and treating those as "scrolled away" stranded running tiles mid-list with a jump arrow.
  // Scroll is used ONLY to RE-engage when the user brings themselves back to the bottom.
  const disengage = useCallback(() => {
    if (followingRef.current) { followingRef.current = false; setShowJump(true) }
  }, [])
  const onWheel = useCallback((e: React.WheelEvent) => { if (e.deltaY < 0) disengage() }, [disengage])
  const onTouchMove = useCallback(() => { disengage() }, [disengage])
  // Last known distance from the bottom, kept current so a container resize can restore
  // the reader's position. See the ResizeObserver below.
  const gapRef = useRef(0)
  const onScroll = useCallback(() => {
    gapRef.current = distFromBottom()
    if (pinningRef.current) return
    if (distFromBottom() < 24) { followingRef.current = true; setShowJump(false) }
  }, [distFromBottom])

  const onMouseEnter = useCallback(() => { hoverRef.current = true }, [])
  const onMouseLeave = useCallback(() => {
    hoverRef.current = false
    // Resume following only if already at the bottom; otherwise leave the reader put
    // and offer the jump affordance — never yank them down on mouse-out.
    const bottom = distFromBottom() < 24
    followingRef.current = bottom
    setShowJump(!bottom)
    if (bottom) pinToBottom()
  }, [distFromBottom, pinToBottom])

  const jumpToLatest = useCallback(() => {
    followingRef.current = true
    setShowJump(false)
    // Instant, not smooth: a long smooth scroll fires intermediate scroll events that
    // onScroll reads as "not at the bottom yet" and disengages following mid-flight,
    // stalling the jump. One synchronous pin lands cleanly and keeps following engaged.
    pinToBottom()
  }, [pinToBottom])

  // Append WITHOUT visible motion: pin before paint whenever we're following and the
  // cursor isn't hovering this chat. The new message just appears at the bottom (and
  // fades in via CSS) — the scrollbar never animates. Hovering freezes the view.
  useLayoutEffect(() => {
    if (hoverRef.current || !followingRef.current) return
    pinToBottom()
  }, [items.length, liveText, liveToolCalls.length, showLiveTurn, pinToBottom])

  // Sending a message ("take me to the conversation") re-engages following.
  const lastMsgRef = useRef<string | null>(null)
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (last && last.id !== lastMsgRef.current) {
      lastMsgRef.current = last.id
      if (last.role === 'user') { followingRef.current = true; setShowJump(false) }
    }
  }, [messages])

  // Land at the bottom when opening / switching chats. A short rAF chase keeps us pinned
  // as tool/image blocks settle their heights (unless the reader grabs it or hovers).
  useLayoutEffect(() => {
    if (!instanceId) return
    followingRef.current = true
    hoverRef.current = false
    setShowJump(false)
    pinToBottom()
    let f = 0
    let raf = 0
    const tick = () => {
      if (f++ < 12 && followingRef.current && !hoverRef.current) {
        pinToBottom()
        raf = requestAnimationFrame(tick)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [instanceId, scrollKey, pinToBottom])

  // Keep pinned to the true bottom as content settles — async images, tool-block heights,
  // streaming tokens, late-loaded history. A ResizeObserver fires AFTER layout (including
  // after the browser's overflow-anchor adjustments), so re-pinning here reliably wins.
  // Only while following and not hovering, so a reader is never pulled down.
  useEffect(() => {
    const content = contentRef.current
    const sc = scrollerRef.current
    if (!content || !sc) return
    const ro = new ResizeObserver(entries => {
      // Two different events wearing one coat.
      //
      // The CONTENT growing (a message lands, an image loads, a tool block measures) is
      // "there is more to see": follow it only if the reader is following and not hovering,
      // so nobody gets yanked mid-read.
      //
      // The SCROLLER itself changing height is not that at all. It happens when the task
      // panel below expands or the composer grows, and it moves the viewport out from under
      // the reader: same scrollTop, less window, so the content they were looking at slides
      // away. Nothing else fires, because scrollTop stays valid (only its maximum moves), so
      // no scroll event and no content resize. The old code gated this on followingRef and
      // hoverRef like the content case, and the result was a transcript left hundreds of
      // pixels off the bottom with no jump-to-latest button, which is exactly "I cannot see
      // what is going on".
      //
      // The correct response is to preserve the reader's position rather than to decide
      // whether to follow: restore the distance from the bottom they had before the resize.
      // At the bottom, that keeps them at the bottom. Reading history 300px up, it keeps the
      // same lines in view. It needs no follow state and no hover exception, so it cannot be
      // silently defeated by either.
      if (entries.some(e => e.target === sc)) {
        // followingRef picks the TARGET here, it does not decide whether to act: someone
        // at the bottom belongs at the bottom, someone reading history keeps their place.
        // That distinction matters because gapRef is a live sample and during a page load
        // it can catch the transcript mid-settle, which would otherwise get restored as a
        // permanent 300px offset on the next resize.
        pinningRef.current = true
        const target = followingRef.current ? 0 : gapRef.current
        sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight - target)
        requestAnimationFrame(() => { pinningRef.current = false })
        return
      }
      if (followingRef.current && !hoverRef.current) sc.scrollTop = sc.scrollHeight
    })
    ro.observe(content)
    ro.observe(sc)
    return () => ro.disconnect()
  }, [instanceId])

  const renderItem = useCallback((_index: number, item: DisplayItem) => {
    if (item.kind === 'message') {
      return (
        <MessageBubble
          key={item.msg.id}
          message={item.msg}
          toolResults={toolResults}
          verbosity={verbosity}
          workedForMs={_index === lastMessageIndex ? lastTurnMs : undefined}
        />
      )
    }
    if (item.kind === 'day') {
      return <div key={item.key} className="day-divider">— {item.label} —</div>
    }
    if (item.kind === 'tools') {
      const hasSpecial = item.calls.some(tc =>
        tc.toolName === 'AskUserQuestion' || tc.toolName === 'ExitPlanMode'
      )
      if (verbosity <= 2 && !hasSpecial) {
        return compact
          ? <CompactToolSummary key={item.key} calls={item.calls} toolResults={toolResults} verbosity={verbosity} />
          : <SessionSummary key={item.key} toolCount={item.calls.length} />
      }
      return <ToolCallGroup key={item.key} calls={item.calls} toolResults={toolResults} verbosity={verbosity} />
    }
    // session-summary: in compact (grid tile) mode the purple pill becomes a dim
    // one-line tool aggregate, clickable to expand the detailed blocks
    if (compact && item.calls.length > 0) {
      return <CompactToolSummary key={item.key} calls={item.calls} toolResults={toolResults} verbosity={verbosity} />
    }
    return <SessionSummary key={item.key} toolCount={item.toolCount} />
  }, [toolResults, verbosity, compact, lastMessageIndex, lastTurnMs])

  // An empty chat renders the SAME scroller, not a separate placeholder tree.
  //
  // It used to return early, which meant scrollerRef and contentRef were null on the
  // first render of every tile whose history had not arrived yet - which is every tile,
  // on every page load, because messages are fetched async. The two scroll effects below
  // are keyed on [instanceId], so they ran once against those null refs, bailed, and
  // never ran again when the messages landed. The result: a tile with no ResizeObserver
  // for the rest of its life, so nothing re-pinned it when content grew later (a tool
  // block settling, an image loading, the task panel expanding, Ultra Compact switching
  // off). It drifted hundreds of pixels off the bottom and stayed there, and because
  // followingRef still said "following", it did not even get a jump-to-latest button.
  // Ultra Compact hid the symptom: hiding the tool calls SHRINKS the transcript, and the
  // browser clamps scrollTop to the new maximum, which happens to be the bottom.
  const isEmpty = messages.length === 0 && !showLiveTurn

  return (
    <div
      className="message-list message-list-plain"
      ref={scrollerRef}
      onScroll={onScroll}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="message-list-content" ref={contentRef}>
        {compactTruncated ? (
          <div className="message-list-load-older">
            <button className="btn btn-sm" onClick={() => setCompactExpanded(true)}>
              Show earlier in this tile
            </button>
          </div>
        ) : hasMore && (
          <div className="message-list-load-older">
            <button className="btn btn-sm" onClick={handleLoadOlder} disabled={loadingOlder}>
              {loadingOlder ? 'Loading...' : 'Load older messages'}
            </button>
          </div>
        )}
        {visibleItems.map((item, index) => renderItem(index, item))}
        {showLiveTurn && (
          <LiveTurn
            verbosity={verbosity}
            liveText={liveText}
            liveToolCalls={liveToolCalls}
            isAgentRunning={!!isAgentRunning}
          />
        )}
      </div>
      {isEmpty && (
        <div className="message-list-empty">No messages yet. Send a message to start.</div>
      )}
      {showJump && (
        <button className="chat-jump-latest" onClick={jumpToLatest} title="Jump to latest" aria-label="Jump to latest">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 6.5l4 4 4-4" />
          </svg>
        </button>
      )}
    </div>
  )
}

interface LiveTurnProps {
  verbosity: 1 | 2 | 3 | 4 | 5
  liveText: string
  liveToolCalls: Array<{ toolId: string; toolName: string; input: string; output?: string; isError?: boolean; isRunning: boolean; parentToolUseId?: string }>
  isAgentRunning: boolean
}

function LiveTurn({ verbosity, liveText, liveToolCalls, isAgentRunning }: LiveTurnProps) {
  const isSpecial = (tc: { toolName: string; input?: string }) =>
    tc.toolName === 'AskUserQuestion' ||
    tc.toolName === 'ExitPlanMode' ||
    isPlanFileWrite(tc.toolName, tc.input)

  // Verbosity 1-2 (default / grid tiles): the live turn surfaces interactive cards that
  // need action, plus a small "typing" indicator (bouncing dots) in the chat while the
  // agent works — the working signal lives here, in the chat, not on the composer.
  if (verbosity <= 2) {
    const cards = liveToolCalls.filter(tc => tc.toolName === 'AskUserQuestion' || tc.toolName === 'ExitPlanMode')
    if (cards.length === 0) {
      if (!isAgentRunning) return null
      return (
        <div className="chat-typing-bubble" aria-label="Working…">
          <span /><span /><span />
        </div>
      )
    }
    return (
      <div className="message-bubble assistant">
        <div className="live-tool-blocks">
          {cards.map(tc => (
            <ToolCallBlock
              key={tc.toolId}
              toolName={tc.toolName}
              toolId={tc.toolId}
              input={tc.input || '{}'}
              output={tc.output}
              isError={tc.isError}
              isRunning={tc.isRunning}
              defaultExpanded={false}
              verbosity={verbosity}
            />
          ))}
        </div>
      </div>
    )
  }

  // Verbosity 3+: the detailed activity view + streaming text. Until anything streams,
  // show the in-chat "typing" dots (the working signal) while the agent is running.
  if (liveToolCalls.length === 0 && !liveText) {
    return isAgentRunning ? (
      <div className="chat-typing-bubble" aria-label="Working…">
        <span /><span /><span />
      </div>
    ) : null
  }
  const activeTool = [...liveToolCalls].reverse().find(tc => tc.isRunning)
  const lastTool = liveToolCalls[liveToolCalls.length - 1]
  const activityLabel = activeTool
    ? formatToolLabel(activeTool.toolName, activeTool.input || '{}')
    : lastTool
      ? formatToolLabel(lastTool.toolName, lastTool.input || '{}')
      : 'Working...'
  return (
    <div className="message-bubble assistant">
      {liveToolCalls.length > 0 && (
        <>
          <ActivityBubble
            toolCalls={liveToolCalls}
            isRunning={isAgentRunning}
            activityLabel={activityLabel}
          />
          {verbosity < 4 && liveToolCalls.some(isSpecial) && (
            <div className="live-tool-blocks">
              {liveToolCalls.filter(isSpecial).map(tc => (
                <ToolCallBlock
                  key={tc.toolId}
                  toolName={tc.toolName}
                  toolId={tc.toolId}
                  input={tc.input || '{}'}
                  output={tc.output}
                  isError={tc.isError}
                  isRunning={tc.isRunning}
                  defaultExpanded={false}
                  verbosity={verbosity}
                />
              ))}
            </div>
          )}
          {verbosity >= 4 && (
            <div className="live-tool-blocks">
              {liveToolCalls.map(tc => (
                <ToolCallBlock
                  key={tc.toolId}
                  toolName={tc.toolName}
                  toolId={tc.toolId}
                  input={tc.input || '{}'}
                  output={tc.output}
                  isError={tc.isError}
                  isRunning={tc.isRunning}
                  defaultExpanded={true}
                  verbosity={verbosity}
                />
              ))}
            </div>
          )}
        </>
      )}
      {liveText && (
        <div className="message-content" style={{ whiteSpace: 'pre-wrap' }}>{liveText}</div>
      )}
    </div>
  )
}

/** Dense grid-tile replacement for the purple pill: `⚒ Bash ×3 · Edit · Read ×5` */
function CompactToolSummary({ calls, toolResults, verbosity }: {
  calls: ToolCallEntry[]
  toolResults: Map<string, { output: string; isError?: boolean }>
  verbosity: 1 | 2 | 3 | 4 | 5
}) {
  const [expanded, setExpanded] = useState(false)
  const aggregate = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of calls) counts.set(c.toolName, (counts.get(c.toolName) || 0) + 1)
    return [...counts.entries()].map(([name, n]) => ({ name, n }))
  }, [calls])

  return (
    <div className="compact-tool-summary">
      <button
        className="compact-tool-line"
        onClick={() => setExpanded(e => !e)}
        title={expanded ? 'Collapse tool details' : 'Expand tool details'}
      >
        <span className={`tool-call-group-chevron ${expanded ? 'expanded' : ''}`}>›</span>
        <span className="tool-call-group-labels">
          {aggregate.map((t, i) => (
            <span key={i} className="tool-call-group-label">
              {i > 0 && <span className="tool-call-group-sep">·</span>}
              <span className="tool-call-arg">{t.name}</span>
              {t.n > 1 && <span className="tool-call-count">×{t.n}</span>}
            </span>
          ))}
        </span>
      </button>
      {expanded && (
        <div className="tool-call-group-body">
          <NestedToolCalls
            calls={calls}
            resolveResult={(toolId) => {
              const r = toolResults.get(toolId)
              return r ? { output: r.output, isError: r.isError, isRunning: false } : { isRunning: true }
            }}
            defaultExpanded={false}
            verbosity={verbosity}
          />
        </div>
      )}
    </div>
  )
}

function SessionSummary({ toolCount }: { toolCount: number }) {
  return (
    <div className="chat-history-summary">
      <span className="chat-history-summary-icon">{'📜'}</span>
      <span className="chat-history-summary-text">Used {toolCount} tool{toolCount !== 1 ? 's' : ''}</span>
      <span className="chat-history-summary-count">{toolCount} action{toolCount !== 1 ? 's' : ''}</span>
    </div>
  )
}

interface ToolCallGroupProps {
  calls: ToolCallEntry[]
  toolResults: Map<string, { output: string; isError?: boolean }>
  verbosity: 1 | 2 | 3 | 4 | 5
}

function ToolCallGroup({ calls, toolResults, verbosity }: ToolCallGroupProps) {
  const hasSpecialTool = calls.some(tc =>
    tc.toolName === 'AskUserQuestion' ||
    tc.toolName === 'ExitPlanMode' ||
    isPlanFileWrite(tc.toolName, tc.input)
  )
  // A refusal opens its own group. At the default verbosity a tool group renders collapsed,
  // and the explanation for a refused call lives INSIDE it, so the answer to "why did that
  // get blocked" sat one unprompted click away behind a row that gives no hint it is there.
  // Nobody clicks a collapsed "Bash" line to find out why the agent gave up.
  const hasDenial = calls.some(tc => {
    const r = toolResults.get(tc.toolId)
    return !!r?.isError && looksLikeDenial(r.output)
  })
  const forceOpen = hasSpecialTool || hasDenial
  const [expanded, setExpanded] = useState(forceOpen || verbosity >= 4)

  useEffect(() => {
    if (forceOpen) setExpanded(true)
  }, [forceOpen])

  // Collapse repeats: identical events (same verb + arg) show once with an ×N count,
  // so "Edit foo · Edit foo · Edit foo" reads as a single "Edit foo ×3". The expanded
  // body still lists every individual call.
  const groupedLabels = useMemo(() => {
    const byKey = new Map<string, { verb: string; arg: string | null; count: number }>()
    const order: string[] = []
    for (const tc of calls) {
      const { verb, arg } = toolCallParts(tc.toolName, tc.input)
      // Separator below is U+001F (unit separator), written as an ESCAPE and never as a raw
      // control character. It used to be a literal U+0000, which worked but made git and
      // ripgrep classify this whole file as binary: every content search silently skipped
      // it, so greps for symbols defined here came back empty as though they did not exist.
      // Any separator that cannot occur in a tool verb or argument is fine; it just must
      // not be a NUL, and must not be pasted in as a raw byte.
      const key = `${verb}\u001F${arg ?? ''}`
      const hit = byKey.get(key)
      if (hit) hit.count++
      else { byKey.set(key, { verb, arg, count: 1 }); order.push(key) }
    }
    return order.map(k => byKey.get(k)!)
  }, [calls])

  // `has-interactive` is what keeps a question alive under Ultra Compact, which hides tool
  // breadcrumbs wholesale. It has to be a React class rather than a CSS `:has()` on the
  // body, because the body only exists while the group is expanded and a user who collapses
  // it once would otherwise lose the card with no way back.
  return (
    <div className={`tool-call-group${hasSpecialTool ? ' has-interactive' : ''}${hasDenial ? ' has-denial' : ''}`}>
      <button type="button" className="tool-call-group-header" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>
        <span className={`tool-call-group-chevron ${expanded ? 'expanded' : ''}`}>›</span>
        <span className="tool-call-group-labels">
          {groupedLabels.map((l, i) => (
            <span key={i} className="tool-call-group-label">
              {i > 0 && <span className="tool-call-group-sep">·</span>}
              <span className="tool-call-verb">{l.verb}</span>
              {l.arg && <span className="tool-call-arg">{l.arg}</span>}
              {l.count > 1 && <span className="tool-call-count">×{l.count}</span>}
            </span>
          ))}
        </span>
      </button>
      {expanded && (
        <div className="tool-call-group-body">
          <NestedToolCalls
            calls={calls}
            resolveResult={(toolId) => {
              const r = toolResults.get(toolId)
              return r ? { output: r.output, isError: r.isError, isRunning: false } : { isRunning: true }
            }}
            defaultExpanded={verbosity >= 4}
            verbosity={verbosity}
          />
        </div>
      )}
    </div>
  )
}
