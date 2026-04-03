import { useMemo, useState, useCallback, useEffect } from 'react'
import type { ChatMessage } from '@shared/types'
import { useUI } from '../context/UIContext'
import { useMessages } from '../context/MessagesContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useAutoScroll } from '../hooks/useAutoScroll'
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
  const scrollRef = useAutoScroll([messages])

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
        // Always include groups that contain AskUser/Plan so the interactive UI is visible
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
        // Level 1: no summary. Level 2: summary line. Level 3+: session summary
        if (verbosity >= 2) {
          result.push({ kind: 'session-summary', toolCount: sessionToolCount, key: summaryKey })
        }
      }
    }

    for (const msg of messages) {
      const tools = extractToolCalls(msg)
      const isOrcBrief = msg.content[0]?.type === 'orc-brief'

      if (isOrcBrief) {
        // End previous session
        flushTools()
        endSession(msg.id + '-session-end')
        // Start new session
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

    // Flush trailing tools + close final session (only if agent is done)
    flushTools()
    if (!isAgentRunning) {
      endSession('final-session-end')
    }

    return result
  }, [messages, isAgentRunning, verbosity])

  if (messages.length === 0) {
    return (
      <div className="message-list" ref={scrollRef}>
        <div className="message-list-empty">No messages yet. Send a message to start.</div>
      </div>
    )
  }

  return (
    <div className="message-list" ref={scrollRef}>
      {hasMore && (
        <div className="message-list-load-older">
          <button
            className="btn btn-sm"
            onClick={handleLoadOlder}
            disabled={loadingOlder}
          >
            {loadingOlder ? 'Loading...' : 'Load older messages'}
          </button>
        </div>
      )}
      {items.map(item => {
        if (item.kind === 'message') return <MessageBubble key={item.msg.id} message={item.msg} toolResults={toolResults} verbosity={verbosity} />
        if (item.kind === 'tools') {
          // Level 2: collapsed summary, UNLESS the group contains AskUser/Plan
          const hasSpecial = item.calls.some(tc =>
            tc.toolName === 'AskUserQuestion' || tc.toolName === 'ExitPlanMode'
          )
          if (verbosity <= 2 && !hasSpecial) {
            return <SessionSummary key={item.key} toolCount={item.calls.length} />
          }
          return <ToolCallGroup key={item.key} calls={item.calls} toolResults={toolResults} verbosity={verbosity} />
        }
        return <SessionSummary key={item.key} toolCount={item.toolCount} />
      })}
      {showLiveTurn && (
        <div className="message-bubble assistant">
          {/* Levels 1-2: ThinkingIndicator, Levels 3+: existing ActivityBubble + streaming */}
          {verbosity <= 2 ? (
            <>
              <ThinkingIndicator
                toolCalls={liveToolCalls}
                isRunning={isAgentRunning}
                liveText={liveText}
                verbosity={verbosity}
              />
              {/* Always show AskUser/Plan blocks even at low verbosity */}
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
                    {/* Show live AskUser/Plan tool blocks inline at any verbosity so their UI is visible */}
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
                    {/* Levels 4-5: show live tool blocks inline */}
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
      )}
    </div>
  )
}

function SessionSummary({ toolCount }: { toolCount: number }) {
  return (
    <div className="chat-history-summary">
      <span className="chat-history-summary-icon">{'\uD83D\uDCDC'}</span>
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
  // Auto-expand if group contains AskUser or plan tools so their UI is immediately visible
  const hasSpecialTool = calls.some(tc =>
    tc.toolName === 'AskUserQuestion' ||
    tc.toolName === 'ExitPlanMode' ||
    (tc.toolName === 'Write' && (() => {
      try { return JSON.parse(tc.input)?.file_path?.includes('.claude/plans/') } catch { return false }
    })())
  )
  const [expanded, setExpanded] = useState(hasSpecialTool || verbosity >= 4)

  // Auto-expand when a special tool (AskUser/Plan) is added to an already-mounted group
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
