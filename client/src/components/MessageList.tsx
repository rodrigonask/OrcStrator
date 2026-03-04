import { useMemo } from 'react'
import type { ChatMessage } from '@shared/types'
import { useApp } from '../context/AppContext'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { MessageBubble } from './MessageBubble'

export function MessageList() {
  const { state } = useApp()
  const instanceId = state.selectedInstanceId
  const messages: ChatMessage[] = instanceId ? (state.messages[instanceId] || []) : []
  const scrollRef = useAutoScroll(messages)

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

  if (messages.length === 0) {
    return (
      <div className="message-list" ref={scrollRef}>
        <div className="message-list-empty">No messages yet. Send a message to start.</div>
      </div>
    )
  }

  return (
    <div className="message-list" ref={scrollRef}>
      {messages.map(msg => (
        <MessageBubble key={msg.id} message={msg} toolResults={toolResults} />
      ))}
      {state.streaming?.[instanceId!] && (
        <div className="message-bubble assistant">
          <div className="streaming-indicator">
            <span />
            <span />
            <span />
          </div>
        </div>
      )}
    </div>
  )
}
