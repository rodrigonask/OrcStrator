import { useState } from 'react'
import { ToolCallBlock } from './ToolCallBlock'

interface StreamingToolCall {
  toolId: string
  toolName: string
  input: string
  output?: string
  isError?: boolean
  isRunning: boolean
}

interface ActivityBubbleProps {
  toolCalls: StreamingToolCall[]
  isRunning: boolean
  activityLabel: string
}

export function ActivityBubble({ toolCalls, isRunning, activityLabel }: ActivityBubbleProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="activity-bubble">
      <div className="activity-bubble-header" onClick={() => setExpanded(e => !e)}>
        <span className={isRunning ? 'activity-dot' : 'activity-bubble-dot'} />
        <span className="activity-text">{activityLabel}</span>
        <span className="activity-bubble-count">{toolCalls.length} actions ›</span>
      </div>
      {expanded && (
        <div className="activity-bubble-tools">
          {toolCalls.map(tc => (
            <ToolCallBlock
              key={tc.toolId}
              toolName={tc.toolName}
              input={tc.input || '{}'}
              output={tc.output}
              isError={tc.isError}
              isRunning={tc.isRunning}
            />
          ))}
        </div>
      )}
    </div>
  )
}
