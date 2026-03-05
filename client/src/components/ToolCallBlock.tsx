import { useState } from 'react'

interface ToolCallBlockProps {
  toolName: string
  input: string
  output?: string
  isError?: boolean
  isRunning?: boolean
}

export function ToolCallBlock(props: ToolCallBlockProps) {
  if (props.toolName === 'Bash') {
    return <BashBlock {...props} />
  }
  return <GenericToolCallBlock {...props} />
}

function GenericToolCallBlock({ toolName, input, output, isError, isRunning }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(true)

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

function BashBlock({ input, output, isError, isRunning }: Omit<ToolCallBlockProps, 'toolName'>) {
  let command = input
  let description: string | undefined
  try {
    const parsed = JSON.parse(input)
    command = parsed.command ?? input
    description = parsed.description
  } catch {}

  const statusClass = isRunning ? 'running' : isError ? 'error' : 'success'

  return (
    <div className="bash-block">
      <div className="bash-block-header">
        <span className="bash-block-dollar">$</span>
        <span className="bash-block-label">bash</span>
        {description && <span className="bash-block-desc">{description}</span>}
        <span className={`tool-call-status ${statusClass}`} />
      </div>
      <pre className="bash-block-command">{command}</pre>
      {output !== undefined && (
        <pre className={`bash-block-output ${isError ? 'error' : ''}`}>{output}</pre>
      )}
      {isRunning && output === undefined && (
        <div className="bash-block-running">
          <span className="bash-cursor" />
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
