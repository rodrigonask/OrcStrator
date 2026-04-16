import { useState, useCallback, useRef, useEffect } from 'react'
import { useMessages } from '../context/MessagesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'

/** Friendly labels for common CLI prompt event types */
function promptLabel(eventType: string, data: Record<string, unknown>): string {
  const sub = data.subtype as string | undefined
  if (sub === 'login_required' || eventType === 'login_required') return 'Login Required'
  if (sub === 'permission' || eventType === 'permission') return 'Permission Request'
  if (sub === 'api_key' || eventType === 'api_key') return 'API Key Required'
  return 'CLI Prompt'
}

function promptDetail(eventType: string, data: Record<string, unknown>): string {
  // Try common fields that Claude CLI sends
  if (typeof data.message === 'string') return data.message
  if (typeof data.question === 'string') return data.question
  if (typeof data.prompt === 'string') return data.prompt
  const inner = data.data as Record<string, unknown> | undefined
  if (typeof inner?.message === 'string') return inner.message as string
  return `Claude CLI needs your attention (${eventType})`
}

export function CliPromptBanner({ instanceId }: { instanceId: string }) {
  const { cliPrompts } = useMessages()
  const { dispatch } = useAppDispatch()
  const prompt = cliPrompts[instanceId]
  const [response, setResponse] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the input when a prompt appears
  useEffect(() => {
    if (prompt) {
      inputRef.current?.focus()
      setResponse('')
    }
  }, [prompt?.receivedAt])

  const handleSend = useCallback(() => {
    if (!prompt) return
    api.writeStdin(instanceId, response + '\n').catch(() => {})
    dispatch({ type: 'CLEAR_CLI_PROMPT', payload: instanceId })
    setResponse('')
  }, [instanceId, prompt, response, dispatch])

  const handleDismiss = useCallback(() => {
    dispatch({ type: 'CLEAR_CLI_PROMPT', payload: instanceId })
  }, [instanceId, dispatch])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape') {
      handleDismiss()
    }
  }, [handleSend, handleDismiss])

  if (!prompt) return null

  const label = promptLabel(prompt.eventType, prompt.data)
  const detail = promptDetail(prompt.eventType, prompt.data)

  return (
    <div className="cli-prompt-banner">
      <span className="cli-prompt-icon">&#x26A0;</span>
      <div className="cli-prompt-body">
        <div className="cli-prompt-label">{label}</div>
        <div className="cli-prompt-detail">{detail}</div>
        <div className="cli-prompt-input-row">
          <input
            ref={inputRef}
            className="cli-prompt-input"
            value={response}
            onChange={e => setResponse(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type response and press Enter..."
          />
          <button className="cli-prompt-send" onClick={handleSend}>Send</button>
        </div>
      </div>
      <button className="cli-prompt-dismiss" onClick={handleDismiss} title="Dismiss">&times;</button>
    </div>
  )
}
