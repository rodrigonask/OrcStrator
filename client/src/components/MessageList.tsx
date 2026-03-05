import { useMemo } from 'react'
import type { ChatMessage } from '@shared/types'
import { useApp } from '../context/AppContext'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { MessageBubble } from './MessageBubble'
import { ToolCallBlock } from './ToolCallBlock'

function hasVisibleContent(msg: ChatMessage): boolean {
  return msg.content.some(b => b.type !== 'tool-result')
}

export function MessageList() {
  const { state } = useApp()
  const instanceId = state.selectedInstanceId
  const messages: ChatMessage[] = instanceId ? (state.messages[instanceId] || []) : []
  const scrollRef = useAutoScroll([messages])

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
      {visibleMessages.map(msg => (
        <MessageBubble key={msg.id} message={msg} toolResults={toolResults} />
      ))}
      {showLiveTurn && (
        <div className="message-bubble assistant">
          {liveToolCalls.map(tc => (
            <ToolCallBlock
              key={tc.toolId}
              toolName={tc.toolName}
              input={tc.input || '{}'}
              output={tc.output}
              isError={tc.isError}
              isRunning={tc.isRunning}
            />
          ))}
          {liveText && (
            <div className="message-content" style={{ whiteSpace: 'pre-wrap' }}>{liveText}</div>
          )}
          {!liveText && liveToolCalls.length === 0 && (
            <div className="wave-indicator">
              <span /><span /><span />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
