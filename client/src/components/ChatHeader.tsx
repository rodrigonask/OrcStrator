import { useCallback, useMemo } from 'react'
import type { ChatMessage } from '@shared/types'
import { useApp } from '../context/AppContext'
import { api } from '../api'

export function ChatHeader() {
  const { state, dispatch } = useApp()
  const instanceId = state.selectedInstanceId
  const instance = state.instances.find(i => i.id === instanceId)
  const messages: ChatMessage[] = instanceId ? (state.messages[instanceId] || []) : []

  const totalTokens = useMemo(() => {
    let input = 0
    let output = 0
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'cost') {
          input += block.inputTokens
          output += block.outputTokens
        }
      }
    }
    return { input, output }
  }, [messages])

  const handlePause = useCallback(() => {
    if (instanceId) api.pauseInstance(instanceId)
  }, [instanceId])

  const handleResume = useCallback(() => {
    if (instanceId) api.resumeInstance(instanceId)
  }, [instanceId])

  const handleCopyLast = useCallback(() => {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistant) return
    const text = lastAssistant.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('\n')
    navigator.clipboard.writeText(text)
  }, [messages])

  const handleClear = useCallback(() => {
    if (instanceId && confirm('Clear chat history for this instance?')) {
      dispatch({ type: 'CLEAR_MESSAGES', instanceId })
    }
  }, [instanceId, dispatch])

  if (!instance) return null

  return (
    <div className="chat-header">
      <div className="chat-header-left">
        <span className="chat-instance-name">{instance.name}</span>
        <span className={`chat-state-badge ${instance.state}`}>
          {instance.state}
        </span>
      </div>
      <div className="chat-header-right">
        <span className="chat-token-count">
          {totalTokens.input.toLocaleString()}in / {totalTokens.output.toLocaleString()}out
        </span>
        {instance.state === 'running' && (
          <button className="chat-header-btn" onClick={handlePause}>
            Pause
          </button>
        )}
        {instance.state === 'paused' && (
          <button className="chat-header-btn primary" onClick={handleResume}>
            Resume
          </button>
        )}
        <button className="chat-header-btn" onClick={handleCopyLast} title="Copy last response">
          Copy
        </button>
        <button className="chat-header-btn" onClick={handleClear} title="Clear history">
          Clear
        </button>
      </div>
    </div>
  )
}
