import { useState } from 'react'
import { NestedToolCalls } from './NestedToolCalls'

interface StreamingToolCall {
  toolId: string
  toolName: string
  input: string
  output?: string
  isError?: boolean
  isRunning: boolean
  parentToolUseId?: string
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
        <span className="activity-text" style={{ fontFamily: 'var(--font-mono)', fontSize: 7 }}>{activityLabel}</span>
        <span className="activity-bubble-count" style={{ fontFamily: 'var(--font-mono)', fontSize: 7 }}>{toolCalls.length} actions ›</span>
      </div>
      {expanded && (
        <div className="activity-bubble-tools">
          <NestedToolCalls calls={toolCalls} />
        </div>
      )}
    </div>
  )
}
