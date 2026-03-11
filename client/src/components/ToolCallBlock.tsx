import { useState, useRef } from 'react'
import type { VerbosityLevel } from '@shared/types'
import { formatToolCall } from '../utils/toolFormat'
import { FormattedToolInput } from '../utils/formatToolInput'
import { useUI } from '../context/UIContext'
import { api } from '../api'

interface ToolCallBlockProps {
  toolName: string
  toolId?: string
  input: string
  output?: string
  isError?: boolean
  isRunning?: boolean
  defaultExpanded?: boolean
  verbosity?: VerbosityLevel
}

interface AskUserOption {
  label: string
  description?: string
}

interface AskUserInput {
  question?: string
  options?: AskUserOption[]
  multiSelect?: boolean
}

const TOOL_ICONS: Record<string, string> = {
  Read: '📄',
  Edit: '✏️',
  Write: '💾',
  Bash: '⚡',
  Grep: '🔍',
  Glob: '🗂️',
  WebFetch: '🌐',
  WebSearch: '🔎',
  Agent: '🤖',
  AskUserQuestion: '❓',
  ExitPlanMode: '📋',
  EnterPlanMode: '📐',
}

function parseAskUserInput(input: string): AskUserInput | null {
  try {
    const parsed = JSON.parse(input)
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as AskUserInput
    }
  } catch { /* not valid JSON yet — input may still be streaming */ }
  return null
}

export function ToolCallBlock({ toolName, toolId, input, output, isError, isRunning, defaultExpanded = false, verbosity = 3 }: ToolCallBlockProps) {
  const isAskUserTool = toolName === 'AskUserQuestion'
  const [expanded, setExpanded] = useState(isAskUserTool ? false : (verbosity >= 4 ? true : defaultExpanded))
  const MAX_OUTPUT_PREVIEW = verbosity >= 5 ? Infinity : 400
  const [showFullOutput, setShowFullOutput] = useState(false)
  const [responded, setResponded] = useState<string | null>(null)
  const [freeText, setFreeText] = useState('')
  const freeTextRef = useRef<HTMLInputElement>(null)
  const { selectedInstanceId } = useUI()

  const label = formatToolCall(toolName, input)
  const icon = TOOL_ICONS[toolName] ?? '🔧'

  const outputTruncated = output !== undefined && !showFullOutput && output.length > MAX_OUTPUT_PREVIEW
  const displayOutput = output !== undefined
    ? (outputTruncated ? output.slice(0, MAX_OUTPUT_PREVIEW) + '…' : output)
    : undefined

  const isAskUser = toolName === 'AskUserQuestion'
  const askUserData = isAskUser ? parseAskUserInput(input) : null
  const canRespond = isAskUser && isRunning && !output && !responded && selectedInstanceId

  const handleRespond = async (text: string) => {
    if (!selectedInstanceId) return
    setResponded(text)
    try {
      await api.sendMessage(selectedInstanceId, { text })
    } catch (err) {
      console.error('Failed to send response:', err)
      setResponded(null)
    }
  }

  const handleOptionClick = (opt: AskUserOption) => {
    const text = opt.description
      ? `I choose: ${opt.label}. ${opt.description}`
      : `I choose: ${opt.label}`
    handleRespond(text)
  }

  const handleFreeTextSubmit = () => {
    if (freeText.trim()) {
      handleRespond(freeText.trim())
    }
  }

  return (
    <div className={`tool-call-block ${isRunning ? 'is-running' : ''} ${isError ? 'is-error' : ''}`}>
      <div className="tool-call-header" onClick={() => setExpanded(e => !e)}>
        <span className="tool-call-icon">{icon}</span>
        {isRunning && <span className="tool-call-running-dot" />}
        <span className="tool-call-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>{label}</span>
        <span className={`tool-call-chevron ${expanded ? 'expanded' : ''}`}>›</span>
      </div>
      {/* AskUser interactive UI — always visible outside collapsible */}
      {isAskUser && askUserData && (
        <div style={{ padding: '8px 12px', borderLeft: '3px solid var(--accent)', marginTop: 4, borderRadius: '0 4px 4px 0', background: 'var(--bg-tertiary)' }}>
          {askUserData.question && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginBottom: 8, color: 'var(--text-primary)', lineHeight: 1.5 }}>
              {askUserData.question}
            </div>
          )}
          {responded ? (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent)', padding: '6px 0' }}>
              Responded: {responded}
            </div>
          ) : canRespond ? (
            askUserData.options && askUserData.options.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {askUserData.options.map((opt, i) => (
                  <button
                    key={i}
                    className="cmd-menu-item"
                    onClick={(e) => { e.stopPropagation(); handleOptionClick(opt) }}
                    style={{ textAlign: 'left' }}
                  >
                    <span className="cmd-menu-cmd">{opt.label}</span>
                    {opt.description && <span className="cmd-menu-desc">{opt.description}</span>}
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  ref={freeTextRef}
                  type="text"
                  value={freeText}
                  onChange={(e) => setFreeText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleFreeTextSubmit() }}
                  placeholder="Type your response..."
                  style={{
                    flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11,
                    background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                    border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px',
                    outline: 'none',
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  className="chat-header-btn"
                  onClick={(e) => { e.stopPropagation(); handleFreeTextSubmit() }}
                  disabled={!freeText.trim()}
                  style={{ fontSize: 11, padding: '4px 10px' }}
                >
                  Send
                </button>
              </div>
            )
          ) : (
            <div className="tool-call-section-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 7 }}>
              {output ? '' : 'Waiting...'}
            </div>
          )}
        </div>
      )}
      {expanded && (
        <div className="tool-call-body">
          <div className="tool-call-section">
            {isAskUser ? (
              <>
                <div className="tool-call-section-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 7 }}>Raw Input</div>
                <FormattedToolInput toolName={toolName} input={input} />
              </>
            ) : (
              <>
                <div className="tool-call-section-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 7 }}>Input</div>
                <FormattedToolInput toolName={toolName} input={input} />
              </>
            )}
          </div>
          {output !== undefined && (
            <div className="tool-call-section">
              <div className="tool-call-section-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 7 }}>Output</div>
              <pre className={`tool-call-output ${isError ? 'error' : ''}`}>{displayOutput}</pre>
              {outputTruncated && (
                <button className="tool-call-show-more" onClick={e => { e.stopPropagation(); setShowFullOutput(true) }}>
                  show more
                </button>
              )}
            </div>
          )}
          {isRunning && output === undefined && !isAskUser && (
            <div className="tool-call-section">
              <div className="bash-block-running"><span className="bash-cursor" /></div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
