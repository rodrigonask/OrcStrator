import { useMemo, useState, useCallback } from 'react'
import type { ChatMessage } from '@shared/types'
import { useApp } from '../context/AppContext'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { MessageBubble } from './MessageBubble'
import { ActivityBubble } from './ActivityBubble'
import { formatToolLabel } from '../utils/toolFormat'

function hasVisibleContent(msg: ChatMessage): boolean {
  return msg.content.some(b => b.type !== 'tool-result')
}

export function MessageList() {
  const { state, loadOlderMessages } = useApp()
  const instanceId = state.selectedInstanceId
  const messages: ChatMessage[] = instanceId ? (state.messages[instanceId] || []) : []
  const hasMore = instanceId ? (state.hasMore[instanceId] ?? false) : false
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

  const instance = instanceId ? state.instances.find(i => i.id === instanceId) : null
  const isAgentRunning = instance?.state === 'running'
  const liveText = instanceId ? (state.streamingContent?.[instanceId] || '') : ''
  const liveToolCalls = instanceId ? (state.streamingToolCalls?.[instanceId] || []) : []

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
      {visibleMessages.map(msg => (
        <MessageBubble key={msg.id} message={msg} toolResults={toolResults} />
      ))}
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
