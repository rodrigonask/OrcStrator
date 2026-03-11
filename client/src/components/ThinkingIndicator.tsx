import { useMemo } from 'react'
import { ORC_TOOL_VERBS, ORC_VERB_FALLBACK } from '@shared/constants'

interface StreamingToolCall {
  toolId: string
  toolName: string
  input: string
  output?: string
  isError?: boolean
  isRunning: boolean
}

interface ThinkingIndicatorProps {
  toolCalls: StreamingToolCall[]
  isRunning: boolean
  liveText?: string
  verbosity: 1 | 2 | 3 | 4 | 5
}

export function ThinkingIndicator({ toolCalls, isRunning, liveText, verbosity }: ThinkingIndicatorProps) {
  const orcLabel = useMemo(() => {
    const active = [...toolCalls].reverse().find(tc => tc.isRunning)
    const toolName = active?.toolName ?? toolCalls[toolCalls.length - 1]?.toolName
    if (!toolName) return ORC_VERB_FALLBACK
    return ORC_TOOL_VERBS[toolName] ?? ORC_VERB_FALLBACK
  }, [toolCalls])

  return (
    <div className="thinking-indicator">
      <div className="thinking-indicator-row">
        <div className="thinking-wave">
          <span /><span /><span /><span /><span />
        </div>
        <span className="thinking-label" key={orcLabel}>{orcLabel}</span>
        {toolCalls.length > 0 && (
          <span className="thinking-tool-badge">x{toolCalls.length}</span>
        )}
      </div>
      {verbosity >= 2 && liveText && (
        <div className="thinking-preview" style={{ whiteSpace: 'pre-wrap' }}>
          {liveText.length > 300 ? liveText.slice(-300) : liveText}
        </div>
      )}
    </div>
  )
}
