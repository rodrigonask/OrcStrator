import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
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

const URL_RE = /https?:\/\/[^\s<>"'`)]+/i

// Recursively scan the data payload for any string that looks like an http(s) URL.
// Login/OAuth prompts often nest the URL under data.url, data.data.url, etc.
function findUrlInData(data: unknown, depth = 0): string | null {
  if (depth > 4 || data == null) return null
  if (typeof data === 'string') {
    const m = data.match(URL_RE)
    if (m) {
      // Strip trailing punctuation that's likely sentence-glue, not part of the URL.
      return m[0].replace(/[.,;:!?)\]}'"`]+$/, '')
    }
    return null
  }
  if (typeof data === 'object') {
    for (const v of Object.values(data as Record<string, unknown>)) {
      const found = findUrlInData(v, depth + 1)
      if (found) return found
    }
  }
  return null
}

// Heuristics for permission-style prompts that take a y/n decision.
function isPermissionPrompt(label: string, detail: string, data: Record<string, unknown>): boolean {
  if (label === 'Permission Request') return true
  const sub = data.subtype as string | undefined
  if (sub && /perm|approve|allow|consent|confirm/i.test(sub)) return true
  // Match common patterns in the detail text
  if (/\[y\/n\]|\(y\/n\)|yes\/no|approve\?|allow\?|grant\?/i.test(detail)) return true
  return false
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

  const writeAndClear = useCallback((payload: string) => {
    if (!prompt) return
    api.writeStdin(instanceId, payload).catch(() => {})
    dispatch({ type: 'CLEAR_CLI_PROMPT', payload: instanceId })
    setResponse('')
  }, [instanceId, prompt, dispatch])

  const handleSend = useCallback(() => {
    writeAndClear(response + '\n')
  }, [response, writeAndClear])

  const handleAllow = useCallback(() => writeAndClear('y\n'), [writeAndClear])
  const handleDeny = useCallback(() => writeAndClear('n\n'), [writeAndClear])

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

  const url = useMemo(() => prompt ? findUrlInData(prompt.data) : null, [prompt])
  const isPerm = useMemo(() => {
    if (!prompt) return false
    const label = promptLabel(prompt.eventType, prompt.data)
    const detail = promptDetail(prompt.eventType, prompt.data)
    return isPermissionPrompt(label, detail, prompt.data)
  }, [prompt])

  if (!prompt) return null

  const label = promptLabel(prompt.eventType, prompt.data)
  const detail = promptDetail(prompt.eventType, prompt.data)

  return (
    <div className="cli-prompt-banner">
      <span className="cli-prompt-icon">&#x26A0;</span>
      <div className="cli-prompt-body">
        <div className="cli-prompt-label">{label}</div>
        <div className="cli-prompt-detail">{detail}</div>

        {/* OAuth / login URL — primary CTA opens it in a new tab */}
        {url && (
          <div className="cli-prompt-action-row">
            <button
              className="cli-prompt-open-url"
              onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
              title={url}
            >
              Open in browser ↗
            </button>
            <button
              className="cli-prompt-copy-url"
              onClick={() => navigator.clipboard.writeText(url).catch(() => {})}
              title="Copy URL to clipboard"
            >
              Copy URL
            </button>
          </div>
        )}

        {/* Permission-style yes/no decision */}
        {isPerm && (
          <div className="cli-prompt-action-row">
            <button className="cli-prompt-allow" onClick={handleAllow}>
              Allow
            </button>
            <button className="cli-prompt-deny" onClick={handleDeny}>
              Deny
            </button>
          </div>
        )}

        {/* Free-form text fallback — useful for anything we haven't classified yet */}
        <div className="cli-prompt-input-row">
          <input
            ref={inputRef}
            className="cli-prompt-input"
            value={response}
            onChange={e => setResponse(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type response and press Enter..."
            type={prompt.eventType === 'api_key' || (prompt.data.subtype as string) === 'api_key' ? 'password' : 'text'}
          />
          <button className="cli-prompt-send" onClick={handleSend}>Send</button>
        </div>
      </div>
      <button className="cli-prompt-dismiss" onClick={handleDismiss} title="Dismiss">&times;</button>
    </div>
  )
}
