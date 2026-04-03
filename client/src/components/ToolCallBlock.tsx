import { useState, useRef, useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
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

interface AskUserQuestion {
  header: string
  question?: string
  options: AskUserOption[]
  multiSelect?: boolean
}

interface AskUserInput {
  question?: string
  options?: AskUserOption[]
  multiSelect?: boolean
  questions?: AskUserQuestion[]
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

function isPlanWrite(toolName: string, input: string): boolean {
  if (toolName === 'ExitPlanMode') return true
  if (toolName !== 'Write') return false
  try {
    return JSON.parse(input)?.file_path?.includes('.claude/plans/') ?? false
  } catch { return false }
}

function extractPlanContent(toolName: string, input: string): string | null {
  try {
    const parsed = JSON.parse(input)
    if (toolName === 'Write') return parsed.content ?? null
    if (toolName === 'ExitPlanMode') return parsed.plan ?? null
  } catch { /* input may still be streaming */ }
  return null
}

function parseAskUserInput(input: string): AskUserInput | null {
  try {
    const parsed = JSON.parse(input)
    if (typeof parsed === 'object' && parsed !== null) {
      if (Array.isArray(parsed.questions)) {
        return { questions: parsed.questions } as AskUserInput
      }
      return parsed as AskUserInput
    }
  } catch { /* not valid JSON yet — input may still be streaming */ }
  return null
}

export function ToolCallBlock({ toolName, toolId, input, output, isError, isRunning, defaultExpanded = false, verbosity = 3 }: ToolCallBlockProps) {
  const isAskUserTool = toolName === 'AskUserQuestion'
  const isPlanTool = isPlanWrite(toolName, input)
  const planContent = isPlanTool ? extractPlanContent(toolName, input) : null
  const renderedPlanHtml = useMemo(() => {
    if (!planContent) return ''
    const raw = marked.parse(planContent) as string
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'del',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
        'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'hr', 'div', 'span',
      ],
      ALLOWED_ATTR: ['href', 'title', 'class'],
    })
  }, [planContent])
  const [expanded, setExpanded] = useState(
    isAskUserTool ? false :
    isPlanTool ? false :
    (verbosity >= 4 ? true : defaultExpanded)
  )
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
  const isMultiQuestion = !!(askUserData?.questions && askUserData.questions.length > 0)
  const canRespond = isAskUser && isRunning && !output && !responded && selectedInstanceId

  // Multi-question selections: Map<questionIndex, selectedLabels[]>
  const [multiSelections, setMultiSelections] = useState<Map<number, string[]>>(new Map())

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

  const handleMultiOptionClick = (qIndex: number, label: string, isMultiSelect: boolean) => {
    setMultiSelections(prev => {
      const next = new Map(prev)
      const current = next.get(qIndex) || []
      if (isMultiSelect) {
        // Toggle
        next.set(qIndex, current.includes(label)
          ? current.filter(l => l !== label)
          : [...current, label])
      } else {
        // Single-select: replace
        next.set(qIndex, [label])
      }
      return next
    })
  }

  const allQuestionsAnswered = isMultiQuestion && askUserData!.questions!.every((_q, i) => {
    const sel = multiSelections.get(i)
    return sel && sel.length > 0
  })

  const handleMultiSubmit = () => {
    if (!askUserData?.questions) return
    const parts = askUserData.questions.map((q, i) => {
      const sel = multiSelections.get(i) || []
      return `${q.header}: ${sel.join(', ')}`
    })
    handleRespond(parts.join('; '))
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
          {/* Single-question format (backward compat) */}
          {!isMultiQuestion && askUserData.question && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginBottom: 8, color: 'var(--text-primary)', lineHeight: 1.5 }}>
              {askUserData.question}
            </div>
          )}
          {responded ? (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent)', padding: '6px 0' }}>
              Responded: {responded}
            </div>
          ) : canRespond ? (
            isMultiQuestion ? (
              <div className="askuser-multi">
                {askUserData.questions!.map((q, qi) => {
                  const selected = multiSelections.get(qi) || []
                  return (
                    <div key={qi} className="askuser-multi-section">
                      <div className="askuser-multi-header">{q.header}</div>
                      {q.question && (
                        <div className="askuser-multi-question">{q.question}</div>
                      )}
                      <div className="askuser-multi-options">
                        {q.options.map((opt, oi) => {
                          const isSelected = selected.includes(opt.label)
                          return (
                            <button
                              key={oi}
                              className={`askuser-multi-opt${isSelected ? ' selected' : ''}`}
                              onClick={(e) => { e.stopPropagation(); handleMultiOptionClick(qi, opt.label, !!q.multiSelect) }}
                            >
                              <span className="askuser-multi-opt-indicator">
                                {q.multiSelect ? (isSelected ? '\u2611' : '\u2610') : (isSelected ? '\u25C9' : '\u25CB')}
                              </span>
                              <span className="askuser-multi-opt-label">{opt.label}</span>
                              {opt.description && <span className="askuser-multi-opt-desc">{opt.description}</span>}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
                <button
                  className="btn btn-primary askuser-multi-submit"
                  onClick={(e) => { e.stopPropagation(); handleMultiSubmit() }}
                  disabled={!allQuestionsAnswered}
                >
                  Submit answers
                </button>
              </div>
            ) : askUserData.options && askUserData.options.length > 0 ? (
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
      {/* Plan content — rendered as markdown outside collapsible */}
      {isPlanTool && planContent && (
        <div className="plan-content-block">
          <div className="plan-content-body" dangerouslySetInnerHTML={{ __html: renderedPlanHtml }} />
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
