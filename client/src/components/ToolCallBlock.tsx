import { useState, useRef, useMemo } from 'react'
import DOMPurify from 'dompurify'
// Link and image rules for every sanitize call.
import { installSanitizerHooks } from '../utils/sanitize'
import type { VerbosityLevel } from '@shared/types'
import { parseMarkdown } from '../utils/markdown'
import { formatToolCall } from '../utils/toolFormat'
import { FormattedToolInput } from '../utils/formatToolInput'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { sendFailureText } from '../utils/sendFailure'
import { readPermMode } from '../utils/permMode'
import { looksLikeDenial } from '../utils/permissionMatch'
import { PermissionDenialNote } from './PermissionDenialNote'
import { api } from '../api'
import { effectivePermissionMode } from '@shared/constants'
import { isPlanFileWrite } from '../utils/planWrite'

installSanitizerHooks()

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
  return isPlanFileWrite(toolName, input)
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
    const raw = parseMarkdown(planContent)
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'del',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
        'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'hr', 'div', 'span',
      ],
      ALLOWED_ATTR: ['href', 'title', 'class', 'target', 'rel'],
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
  const { selectedInstanceId, settings } = useUI()
  const { dispatch } = useAppDispatch()
  // A click that never reached Claude says so in the chat, like a failed send does.
  const noteFailure = (instanceId: string, what: string, err: unknown) => dispatch({
    type: 'ADD_MESSAGE',
    payload: { id: crypto.randomUUID(), instanceId, role: 'system', content: [{ type: 'text', text: sendFailureText(what, err) }], createdAt: Date.now() },
  })

  const label = formatToolCall(toolName, input)
  const icon = TOOL_ICONS[toolName] ?? '🔧'

  const outputTruncated = output !== undefined && !showFullOutput && output.length > MAX_OUTPUT_PREVIEW
  const displayOutput = output !== undefined
    ? (outputTruncated ? output.slice(0, MAX_OUTPUT_PREVIEW) + '…' : output)
    : undefined

  // Cheap string test first. The explainer subscribes to the instance list and the app
  // settings, so it is only mounted on the rare call that was actually refused.
  const isDenial = !!isError && looksLikeDenial(output)

  // An interactive card's own tool_result is an expected auto-fail, not a failure: the CLI
  // aborts AskUserQuestion/ExitPlanMode because the hard-stop killed the process, and the
  // answer arrives as a resumed turn. Painting the live question red (and its "error" output)
  // reads as "this broke" on the one card the user is supposed to act on.
  const showsAsError = !!isError && toolName !== 'AskUserQuestion' && toolName !== 'ExitPlanMode'

  const isAskUser = toolName === 'AskUserQuestion'
  const askUserData = isAskUser ? parseAskUserInput(input) : null
  const isMultiQuestion = !!(askUserData?.questions && askUserData.questions.length > 0)
  // A tool_result on AskUserQuestion is NEVER an answer, so it must not gate the buttons.
  // stream-json mode has no channel back into a live CLI, so every one of these results is
  // the tool giving up: "The user did not answer the questions." normally, or "Tool
  // permission request failed: AbortError: Stream closed" when the hard-stop kill lands
  // first (both verified in the CLI session transcripts, 2.1.261). The real answer is
  // delivered as a resumed turn through the answer-question route.
  //
  // This was gated on `!output || /answer questions\?/i.test(output)`, matching a string the
  // CLI does not emit, and it went unnoticed for as long as tool results never reached a
  // message-rendered block: the map MessageList built was always empty, so output was always
  // undefined and the first clause carried it. Once results were made real, the card went
  // dead on arrival — rendering an empty bordered box with the question's buttons gone. A
  // reload dropped the in-memory result map and the card came back, which is exactly the
  // "refresh fixes it" report.
  const canRespond = isAskUser && !responded && !!selectedInstanceId

  // Multi-question selections: Map<questionIndex, selectedLabels[]>
  const [multiSelections, setMultiSelections] = useState<Map<number, string[]>>(new Map())

  const handleRespond = async (text: string) => {
    if (!selectedInstanceId) return
    const id = selectedInstanceId
    setResponded(text)
    // Optimistically flip to running so the thinking indicator appears immediately.
    // The server resumes via injectUserTurn, which first waits up to ~20s for the asking
    // turn to go idle before it spawns the resumed turn — without this flip the chat shows
    // no feedback for that whole window (the reported "no waving dots after answering").
    // Mirrors the optimistic update in AppContext.sendMessage for normal sends.
    dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates: { state: 'running' } } })
    try {
      if (toolId) {
        // Deliver the answer as a resumed user turn keyed to this tool_use.
        const res = await api.answerQuestion(id, toolId, text)
        if (!res.ok) {
          // Process exited / stdin closed — fall back to a normal chat message so the
          // user's intent isn't lost.
          await api.sendMessage(id, { text })
        }
      } else {
        await api.sendMessage(id, { text })
      }
    } catch (err) {
      console.error('Failed to send response:', err)
      noteFailure(id, 'that answer', err)
      setResponded(null)
      // Roll back the optimistic running state so the UI isn't stuck pretending to work.
      dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates: { state: 'idle' } } })
    }
  }

  const handleOptionClick = (opt: AskUserOption) => {
    // For single-question AskUserQuestion, send just the label — that's what the agent
    // expects in tool_result. We keep description out so the agent gets a clean choice.
    handleRespond(opt.label)
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
    // Combined response, one line per question keyed by its header so the agent can map
    // answers back to the questions it asked.
    const parts = askUserData.questions.map((q, i) => {
      const sel = multiSelections.get(i) || []
      return `${q.header}: ${sel.join(', ')}`
    })
    handleRespond(parts.join('\n'))
  }

  // --- ExitPlanMode (plan approval) state ---
  const isPlanMode = toolName === 'ExitPlanMode'
  // Same reasoning as canRespond above, and the same regression: approve/reject are resumed
  // turns (decide-plan → injectUserTurn), so a tool_result here is only ever the CLI giving
  // up after the hard-stop killed the process. `isRunning` fails for the same reason — a
  // message-rendered call is "running" only while MessageList has no result for it, so the
  // arriving auto-fail flipped it false and took the buttons with it.
  const canDecidePlan = isPlanMode && !responded && !!selectedInstanceId && !!toolId
  const [showReject, setShowReject] = useState(false)
  const [rejectFeedback, setRejectFeedback] = useState('')
  const allowedPrompts = useMemo(() => {
    if (!isPlanMode) return null
    try {
      const parsed = JSON.parse(input)
      if (Array.isArray(parsed?.allowedPrompts)) {
        return parsed.allowedPrompts as Array<{ tool: string; prompt: string }>
      }
    } catch { /* still streaming */ }
    return null
  }, [isPlanMode, input])
  const [showAllowedPrompts, setShowAllowedPrompts] = useState(false)

  // Does this block render something the user is meant to ACT on (a question, a plan to
  // approve, the plan text itself) rather than a record of something already done? Density
  // settings hide the records; they must never hide these. The flag lives on the DOM node
  // because the decision is made in CSS (Ultra Compact), and CSS cannot tell an AskUser
  // block from a Read block by structure alone.
  const isInteractiveCard = (isAskUser && !!askUserData) || isPlanMode || (isPlanTool && !!planContent)

  const handlePlanApprove = async () => {
    if (!selectedInstanceId || !toolId) return
    const id = selectedInstanceId
    setResponded('Approved')
    // Optimistically flip to running — same dead-air window as answer-question (see handleRespond).
    dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates: { state: 'running' } } })
    try {
      // Carry the composer's mode across — otherwise the server falls back to forcing
      // acceptEdits, which silently downgrades an instance set to Bypass (and then
      // prompts on every Bash for the rest of that process's life).
      const permissionMode = readPermMode(id, effectivePermissionMode(settings))
      const res = await api.decidePlan(id, toolId, 'approve', { permissionMode })
      if (!res.ok) {
        setResponded(null)
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates: { state: 'idle' } } })
        console.error('decidePlan approve failed:', res.error)
      }
    } catch (err) {
      console.error('Failed to approve plan:', err)
      noteFailure(id, 'that decision', err)
      setResponded(null)
      dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates: { state: 'idle' } } })
    }
  }
  const handlePlanReject = async () => {
    if (!selectedInstanceId || !toolId) return
    const id = selectedInstanceId
    const fb = rejectFeedback.trim()
    setResponded(`Rejected${fb ? `: ${fb}` : ''}`)
    // Optimistically flip to running — same dead-air window as answer-question (see handleRespond).
    dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates: { state: 'running' } } })
    try {
      const res = await api.decidePlan(id, toolId, 'reject', { feedback: fb || undefined })
      if (!res.ok) {
        setResponded(null)
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates: { state: 'idle' } } })
        console.error('decidePlan reject failed:', res.error)
      }
    } catch (err) {
      console.error('Failed to reject plan:', err)
      noteFailure(id, 'that decision', err)
      setResponded(null)
      dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates: { state: 'idle' } } })
    }
  }

  const handleFreeTextSubmit = () => {
    if (freeText.trim()) {
      handleRespond(freeText.trim())
    }
  }

  return (
    <div className={`tool-call-block ${isInteractiveCard ? 'is-interactive' : ''} ${isRunning ? 'is-running' : ''} ${showsAsError ? 'is-error' : ''}`}>
      <div className="tool-call-header" onClick={() => setExpanded(e => !e)}>
        <span className="tool-call-icon">{icon}</span>
        {isRunning && <span className="tool-call-running-dot" />}
        <span className="tool-call-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>{label}</span>
        <span className={`tool-call-chevron ${expanded ? 'expanded' : ''}`}>›</span>
      </div>
      {/* Outside the collapsible on purpose: a refusal nobody expands is a refusal nobody
          can explain, and this is the answer to the question the refusal always raises. */}
      {isDenial && <PermissionDenialNote toolId={toolId} toolName={toolName} input={input} output={output} />}
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
              Waiting...
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
      {/* Plan approval card — only for ExitPlanMode, while the tool is awaiting a result. */}
      {isPlanMode && (
        <div className="plan-approval-block" style={{ padding: '10px 12px', borderLeft: '3px solid var(--accent)', marginTop: 4, borderRadius: '0 4px 4px 0', background: 'var(--bg-tertiary)' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            Plan ready for review
          </div>
          {!planContent && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', marginBottom: 8 }}>
              The agent finished planning. {allowedPrompts && allowedPrompts.length > 0 ? `${allowedPrompts.length} pre-approved tool call(s) attached.` : ''}
            </div>
          )}
          {allowedPrompts && allowedPrompts.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <button
                className="tool-call-show-more"
                onClick={(e) => { e.stopPropagation(); setShowAllowedPrompts(s => !s) }}
                style={{ fontSize: 10, fontFamily: 'var(--font-mono)' }}
              >
                {showAllowedPrompts ? 'Hide' : 'Show'} tool calls the agent wants to make ({allowedPrompts.length})
              </button>
              {showAllowedPrompts && (
                <ul style={{ margin: '4px 0 0 0', paddingLeft: 18, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)' }}>
                  {allowedPrompts.map((p, i) => (
                    <li key={i}><strong>{p.tool}</strong>: {p.prompt}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {responded ? (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent)' }}>
              {responded}
            </div>
          ) : canDecidePlan ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {!showReject ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn btn-primary"
                    onClick={(e) => { e.stopPropagation(); handlePlanApprove() }}
                    style={{ fontSize: 11, padding: '4px 12px' }}
                  >
                    Approve
                  </button>
                  <button
                    className="chat-header-btn"
                    onClick={(e) => { e.stopPropagation(); setShowReject(true) }}
                    style={{ fontSize: 11, padding: '4px 12px' }}
                  >
                    Reject…
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <textarea
                    value={rejectFeedback}
                    onChange={(e) => setRejectFeedback(e.target.value)}
                    placeholder="Feedback for the agent…"
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      fontFamily: 'var(--font-mono)', fontSize: 11,
                      background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                      border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px',
                      outline: 'none', minHeight: 60, resize: 'vertical',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="btn btn-primary"
                      onClick={(e) => { e.stopPropagation(); handlePlanReject() }}
                      style={{ fontSize: 11, padding: '4px 12px' }}
                    >
                      Send rejection
                    </button>
                    <button
                      className="chat-header-btn"
                      onClick={(e) => { e.stopPropagation(); setShowReject(false); setRejectFeedback('') }}
                      style={{ fontSize: 11, padding: '4px 12px' }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="tool-call-section-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-secondary)' }}>
              Waiting...
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
              <pre className={`tool-call-output ${showsAsError ? 'error' : ''}`}>{displayOutput}</pre>
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
