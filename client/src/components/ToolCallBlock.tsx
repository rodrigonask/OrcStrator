import { useState } from 'react'
import { formatToolCall } from '../utils/toolFormat'

interface ToolCallBlockProps {
  toolName: string
  input: string
  output?: string
  isError?: boolean
  isRunning?: boolean
  defaultExpanded?: boolean
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

const MAX_OUTPUT_PREVIEW = 400

export function ToolCallBlock({ toolName, input, output, isError, isRunning, defaultExpanded = false }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [showFullOutput, setShowFullOutput] = useState(false)

  const label = formatToolCall(toolName, input)
  const icon = TOOL_ICONS[toolName] ?? '🔧'
  const statusClass = isRunning ? 'running' : isError ? 'error' : 'success'

  const formattedInput = formatJson(input)

  const outputTruncated = output !== undefined && !showFullOutput && output.length > MAX_OUTPUT_PREVIEW
  const displayOutput = output !== undefined
    ? (outputTruncated ? output.slice(0, MAX_OUTPUT_PREVIEW) + '…' : output)
    : undefined

  return (
    <div className={`tool-call-block ${isRunning ? 'is-running' : ''} ${isError ? 'is-error' : ''}`}>
      <div className="tool-call-header" onClick={() => setExpanded(e => !e)}>
        <span className="tool-call-icon">{icon}</span>
        {isRunning && <span className="tool-call-running-dot" />}
        <span className="tool-call-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>{label}</span>
        <span className={`tool-call-chevron ${expanded ? 'expanded' : ''}`}>›</span>
      </div>
      {expanded && (
        <div className="tool-call-body">
          <div className="tool-call-section">
            <div className="tool-call-section-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 7 }}>Input</div>
            <pre className="tool-call-json">{formattedInput}</pre>
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
          {isRunning && output === undefined && (
            <div className="tool-call-section">
              <div className="bash-block-running"><span className="bash-cursor" /></div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
