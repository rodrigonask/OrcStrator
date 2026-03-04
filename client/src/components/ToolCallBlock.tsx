import { useState } from 'react'

interface ToolCallBlockProps {
  toolName: string
  input: string
  output?: string
  isError?: boolean
  isRunning?: boolean
}

export function ToolCallBlock({ toolName, input, output, isError, isRunning }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false)

  const summary = (() => {
    try {
      const parsed = JSON.parse(input)
      const keys = Object.keys(parsed)
      if (keys.length === 0) return ''
      const firstVal = String(parsed[keys[0]])
      return firstVal.length > 50 ? firstVal.slice(0, 50) + '...' : firstVal
    } catch {
      return input.slice(0, 50)
    }
  })()

  const statusClass = isRunning ? 'running' : isError ? 'error' : 'success'

  return (
    <div className="tool-call-block">
      <div className="tool-call-header" onClick={() => setExpanded(e => !e)}>
        <span className={`tool-call-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
        <span className="tool-call-name">{toolName}</span>
        <span className="tool-call-summary">{summary}</span>
        <span className={`tool-call-status ${statusClass}`} />
      </div>
      {expanded && (
        <div className="tool-call-body">
          <div className="tool-call-section-label">Input</div>
          <pre className="tool-call-json">{formatJson(input)}</pre>
          {output !== undefined && (
            <>
              <div className="tool-call-section-label">Output</div>
              <pre className={`tool-call-output ${isError ? 'error' : ''}`}>{output}</pre>
            </>
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
