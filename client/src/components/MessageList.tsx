import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { ChatMessage } from '@shared/types'
import { useUI } from '../context/UIContext'
import { useMessages } from '../context/MessagesContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useVerbosity } from '../hooks/useVerbosity'
import { MessageBubble } from './MessageBubble'
import { ActivityBubble } from './ActivityBubble'
import { ToolCallBlock } from './ToolCallBlock'
import { ThinkingIndicator } from './ThinkingIndicator'
import { formatToolLabel, formatToolCall } from '../utils/toolFormat'

type ToolCallEntry = { type: 'tool-call'; toolId: string; toolName: string; input: string }

function hasTextContent(msg: ChatMessage): boolean {
  return msg.content.some(b => {
    if (b.type === 'text' && b.text?.trim()) return true
    if (b.type === 'image') return true
    if (b.type === 'orc-brief') return true
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
  | { kind: 'session-summary'; toolCount: number; key: string }

export function MessageList() {
  const { selectedInstanceId: instanceId } = useUI()
  const { messages: allMessages, hasMore: allHasMore, streamingContent, streamingToolCalls } = useMessages()
  const { instances } = useInstances()
  const { loadOlderMessages } = useAppDispatch()
  const verbosity = useVerbosity(instanceId)
  const messages: ChatMessage[] = instanceId ? (allMessages[instanceId] || []) : []
  const hasMore = instanceId ? (allHasMore[instanceId] ?? false) : false
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  const handleLoadOlder = useCallback(async () => {
    if (!instanceId || loadingOlder) return
    setLoadingOlder(true)
    try {
      await loadOlderMessages(instanceId)
    } finally {
      setLoadingOlder(false)
    }
  }, [instanceId, loadingOlder, loadOlderMessages])

  const instance = instanceId ? instances.find(i => i.id === instanceId) : null
  const isAgentRunning = instance?.state === 'running'
  const liveText = instanceId ? (streamingContent?.[instanceId] || '') : ''
  const liveToolCalls = instanceId ? (streamingToolCalls?.[instanceId] || []) : []

  const showLiveTurn = isAgentRunning || !!liveText || liveToolCalls.length > 0

  // Build a map of toolId -> result for the current message set
  const toolResults = useMemo(() => {
    const map = new Map<string, { output: string; isError?: boolean }>()
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'tool-result') {
          map.set(block.toolId, { output: block.output, isError: block.isError })
        }
      }
    }
    return map
  }, [messages])

  // Build display items: text messages, aggregated tool groups, and per-session summaries
  const items = useMemo(() => {
    const result: DisplayItem[] = []
    let pendingTools: ToolCallEntry[] = []
    let pendingKey = ''
    let sessionToolCount = 0
    let hasSession = messages.length > 0

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
          result.push({ kind: 'session-summary', toolCount: sessionToolCount, key: summaryKey })
        }
      }
    }

    for (const msg of messages) {
      const tools = extractToolCalls(msg)
      const isOrcBrief = msg.content[0]?.type === 'orc-brief'

      if (isOrcBrief) {
        flushTools()
        endSession(msg.id + '-session-end')
        sessionToolCount = 0
        hasSession = true
        result.push({ kind: 'message', msg })
      } else {
        sessionToolCount += tools.length
        pendingTools.push(...tools)
        if (!pendingKey && tools.length > 0) pendingKey = msg.id

        if (hasTextContent(msg)) {
          flushTools()
          result.push({ kind: 'message', msg })
        }
      }
    }

    flushTools()
    if (!isAgentRunning) {
      endSession('final-session-end')
    }

    return result
  }, [messages, isAgentRunning, verbosity])

  // While streaming, follow the bottom — the live turn (in Footer) grows but the
  // data array doesn't change, so Virtuoso's followOutput won't trigger. Scroll manually.
  useEffect(() => {
    if (!showLiveTurn || !atBottom || !virtuosoRef.current) return
    virtuosoRef.current.scrollToIndex({ index: items.length - 1, behavior: 'auto', align: 'end' })
  }, [liveText, liveToolCalls.length, showLiveTurn, atBottom, items.length])

  const renderItem = useCallback((_index: number, item: DisplayItem) => {
    if (item.kind === 'message') {
      return <MessageBubble key={item.msg.id} message={item.msg} toolResults={toolResults} verbosity={verbosity} />
    }
    if (item.kind === 'tools') {
      const hasSpecial = item.calls.some(tc =>
        tc.toolName === 'AskUserQuestion' || tc.toolName === 'ExitPlanMode'
      )
      if (verbosity <= 2 && !hasSpecial) {
        return <SessionSummary key={item.key} toolCount={item.calls.length} />
      }
      return <ToolCallGroup key={item.key} calls={item.calls} toolResults={toolResults} verbosity={verbosity} />
    }
    return <SessionSummary key={item.key} toolCount={item.toolCount} />
  }, [toolResults, verbosity])

  if (messages.length === 0 && !showLiveTurn) {
    return (
      <div className="message-list">
        <div className="message-list-empty">No messages yet. Send a message to start.</div>
      </div>
    )
  }

  const LoadOlderHeader = hasMore
    ? () => (
        <div className="message-list-load-older">
          <button
            className="btn btn-sm"
            onClick={handleLoadOlder}
            disabled={loadingOlder}
          >
            {loadingOlder ? 'Loading...' : 'Load older messages'}
          </button>
        </div>
      )
    : undefined

  const LiveTurnFooter = showLiveTurn
    ? () => (
        <LiveTurn
          verbosity={verbosity}
          liveText={liveText}
          liveToolCalls={liveToolCalls}
          isAgentRunning={!!isAgentRunning}
        />
      )
    : undefined

  return (
    <Virtuoso
      ref={virtuosoRef}
      className="message-list message-list-virtuoso"
      data={items}
      itemContent={(index, item) => (
        <div className="message-list-item-wrap">{renderItem(index, item)}</div>
      )}
      components={{
        Header: LoadOlderHeader,
        Footer: LiveTurnFooter,
      }}
      followOutput={atBottom ? 'auto' : false}
      atBottomStateChange={setAtBottom}
      initialTopMostItemIndex={Math.max(0, items.length - 1)}
      increaseViewportBy={{ top: 600, bottom: 1200 }}
    />
  )
}

interface LiveTurnProps {
  verbosity: 1 | 2 | 3 | 4 | 5
  liveText: string
  liveToolCalls: Array<{ toolId: string; toolName: string; input: string; output?: string; isError?: boolean; isRunning: boolean }>
  isAgentRunning: boolean
}

function LiveTurn({ verbosity, liveText, liveToolCalls, isAgentRunning }: LiveTurnProps) {
  return (
    <div className="message-bubble assistant">
      {verbosity <= 2 ? (
        <>
          <ThinkingIndicator
            toolCalls={liveToolCalls}
            isRunning={isAgentRunning}
            liveText={liveText}
            verbosity={verbosity}
          />
          {liveToolCalls.some(tc => tc.toolName === 'AskUserQuestion' || tc.toolName === 'ExitPlanMode') && (
            <div className="live-tool-blocks">
              {liveToolCalls
                .filter(tc => tc.toolName === 'AskUserQuestion' || tc.toolName === 'ExitPlanMode')
                .map(tc => (
                  <ToolCallBlock
                    key={tc.toolId}
                    toolName={tc.toolName}
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
        </>
      ) : (
        <>
          {liveToolCalls.length > 0 && (() => {
            const activeTool = [...liveToolCalls].reverse().find(tc => tc.isRunning)
            const lastTool = liveToolCalls[liveToolCalls.length - 1]
            const activityLabel = activeTool
              ? formatToolLabel(activeTool.toolName, activeTool.input || '{}')
              : lastTool
                ? formatToolLabel(lastTool.toolName, lastTool.input || '{}')
                : 'Working...'
            return (
              <>
                <ActivityBubble
                  toolCalls={liveToolCalls}
                  isRunning={isAgentRunning}
                  activityLabel={activityLabel}
                />
                {verbosity < 4 && liveToolCalls.some(tc =>
                  tc.toolName === 'AskUserQuestion' ||
                  tc.toolName === 'ExitPlanMode' ||
                  (tc.toolName === 'Write' && (() => {
                    try { return JSON.parse(tc.input || '{}')?.file_path?.includes('.claude/plans/') } catch { return false }
                  })())
                ) && (
                  <div className="live-tool-blocks">
                    {liveToolCalls
                      .filter(tc =>
                        tc.toolName === 'AskUserQuestion' ||
                        tc.toolName === 'ExitPlanMode' ||
                        (tc.toolName === 'Write' && (() => {
                          try { return JSON.parse(tc.input || '{}')?.file_path?.includes('.claude/plans/') } catch { return false }
                        })())
                      )
                      .map(tc => (
                        <ToolCallBlock
                          key={tc.toolId}
                          toolName={tc.toolName}
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
            )
          })()}
          {liveText && (
            <div className="message-content" style={{ whiteSpace: 'pre-wrap' }}>{liveText}</div>
          )}
          {isAgentRunning && liveToolCalls.length === 0 && !liveText && (
            <div className="wave-indicator">
              <span /><span /><span />
            </div>
          )}
        </>
      )}
      {!isAgentRunning && !liveText && liveToolCalls.length === 0 && (
        <div className="wave-indicator">
          <span /><span /><span />
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
    (tc.toolName === 'Write' && (() => {
      try { return JSON.parse(tc.input)?.file_path?.includes('.claude/plans/') } catch { return false }
    })())
  )
  const [expanded, setExpanded] = useState(hasSpecialTool || verbosity >= 4)

  useEffect(() => {
    if (hasSpecialTool) setExpanded(true)
  }, [hasSpecialTool])

  return (
    <div className="tool-call-group">
      <div className="tool-call-group-header" onClick={() => setExpanded(e => !e)}>
        <span className={`tool-call-group-chevron ${expanded ? 'expanded' : ''}`}>›</span>
        <span className="tool-call-group-labels">
          {calls.map((tc, i) => (
            <span key={tc.toolId} className="tool-call-group-label">
              {i > 0 && <span className="tool-call-group-sep">·</span>}
              {formatToolCall(tc.toolName, tc.input)}
            </span>
          ))}
        </span>
      </div>
      {expanded && (
        <div className="tool-call-group-body">
          {calls.map(tc => {
            const result = toolResults.get(tc.toolId)
            return (
              <ToolCallBlock
                key={tc.toolId}
                toolName={tc.toolName}
                input={tc.input}
                output={result?.output}
                isError={result?.isError}
                isRunning={!result}
                defaultExpanded={verbosity >= 4}
                verbosity={verbosity}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
