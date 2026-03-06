import { useMemo, useState, useCallback } from 'react'
import type { ChatMessage } from '@shared/types'
import { useUI } from '../context/UIContext'
import { useMessages } from '../context/MessagesContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { MessageBubble } from './MessageBubble'
import { ActivityBubble } from './ActivityBubble'
import { ToolCallBlock } from './ToolCallBlock'
import { formatToolLabel, summarizeToolCalls } from '../utils/toolFormat'

function hasVisibleContent(msg: ChatMessage): boolean {
  return msg.content.some(b => {
    if (b.type === 'tool-result') return false
    if (b.type === 'text' && !b.text?.trim()) return false
    return true
  })
}

function isToolOnlyMsg(msg: ChatMessage): boolean {
  return msg.role === 'assistant' && msg.content.every(b => b.type === 'tool-call')
}

type MsgGroup =
  | { kind: 'single'; msg: ChatMessage }
  | { kind: 'tools'; msgs: ChatMessage[] }

export function MessageList() {
  const { selectedInstanceId: instanceId } = useUI()
  const { messages: allMessages, hasMore: allHasMore, streamingContent, streamingToolCalls } = useMessages()
  const { instances } = useInstances()
  const { loadOlderMessages } = useAppDispatch()
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

  // Show live assistant turn bubble when: agent is running, streaming text, or live tool calls exist
  const lastMessage = messages[messages.length - 1]
  const showLiveTurn = isAgentRunning || !!liveText || liveToolCalls.length > 0 || lastMessage?.role === 'user'

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

  const visibleMessages = useMemo(() => messages.filter(hasVisibleContent), [messages])

  const groups = useMemo<MsgGroup[]>(() => {
    const result: MsgGroup[] = []
    let toolBatch: ChatMessage[] = []
    for (const msg of visibleMessages) {
      if (isToolOnlyMsg(msg)) {
        toolBatch.push(msg)
      } else {
        if (toolBatch.length > 0) {
          result.push({ kind: 'tools', msgs: toolBatch })
          toolBatch = []
        }
        result.push({ kind: 'single', msg })
      }
    }
    if (toolBatch.length > 0) result.push({ kind: 'tools', msgs: toolBatch })
    return result
  }, [visibleMessages])

  if (visibleMessages.length === 0) {
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
      {groups.map((group, i) =>
        group.kind === 'single'
          ? <MessageBubble key={group.msg.id} message={group.msg} toolResults={toolResults} />
          : <CondensedToolChip key={group.msgs[0].id + '-group-' + i} msgs={group.msgs} toolResults={toolResults} />
      )}
      {showLiveTurn && (
        <div className="message-bubble assistant">
          {liveToolCalls.length > 0 && (() => {
            const activeTool = [...liveToolCalls].reverse().find(tc => tc.isRunning)
            const lastTool = liveToolCalls[liveToolCalls.length - 1]
            const activityLabel = activeTool
              ? formatToolLabel(activeTool.toolName, activeTool.input || '{}')
              : lastTool
                ? formatToolLabel(lastTool.toolName, lastTool.input || '{}')
                : 'Working...'
            return (
              <ActivityBubble
                toolCalls={liveToolCalls}
                isRunning={isAgentRunning}
                activityLabel={activityLabel}
              />
            )
          })()}
          {liveText && (
            <div className="message-content" style={{ whiteSpace: 'pre-wrap' }}>{liveText}</div>
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

interface CondensedToolChipProps {
  msgs: ChatMessage[]
  toolResults: Map<string, { output: string; isError?: boolean }>
}

function CondensedToolChip({ msgs, toolResults }: CondensedToolChipProps) {
  const [expanded, setExpanded] = useState(false)
  const allToolCalls = msgs.flatMap(m =>
    m.content.filter(b => b.type === 'tool-call') as Array<{ type: 'tool-call'; toolId: string; toolName: string; input: string }>
  )
  const label = summarizeToolCalls(allToolCalls)

  return (
    <div className="condensed-tool-chip">
      <button className="condensed-tool-chip-toggle" onClick={() => setExpanded(e => !e)}>
        <span className="condensed-tool-chip-icon">{expanded ? '▾' : '▸'}</span>
        {label}
      </button>
      {expanded && (
        <div className="condensed-tool-chip-body">
          {allToolCalls.map(tc => {
            const result = toolResults.get(tc.toolId)
            return (
              <ToolCallBlock
                key={tc.toolId}
                toolName={tc.toolName}
                input={tc.input}
                output={result?.output}
                isError={result?.isError}
                isRunning={false}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
