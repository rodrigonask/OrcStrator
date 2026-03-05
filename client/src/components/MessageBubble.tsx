import { useMemo, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { marked } from 'marked'
import type { ChatMessage, MessageContentBlock } from '@shared/types'
import { ToolCallBlock } from './ToolCallBlock'

interface MessageBubbleProps {
  message: ChatMessage
  toolResults: Map<string, { output: string; isError?: boolean }>
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const hours = date.getHours()
  const minutes = pad(date.getMinutes())
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const h12 = hours % 12 || 12
  const time = `${h12}:${minutes} ${ampm}`

  const todayStr = now.toDateString()
  const dateStr = date.toDateString()
  if (dateStr === todayStr) return `Today at ${time}`

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (dateStr === yesterday.toDateString()) return `Yesterday at ${time}`

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return `${days[date.getDay()]} ${date.getDate()} at ${time}`
}

export function MessageBubble({ message, toolResults }: MessageBubbleProps) {
  const { role, content, createdAt } = message
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMouseEnter = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    const rect = e.currentTarget.getBoundingClientRect()
    setTooltip({ x: rect.left + rect.width / 2, y: rect.top - 8 })
  }, [])

  const handleMouseLeave = useCallback(() => {
    hideTimer.current = setTimeout(() => setTooltip(null), 80)
  }, [])

  return (
    <div
      className={`message-bubble ${role}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {role === 'system' && <div className="message-role-label">System</div>}
      {content.map((block, i) => (
        <ContentBlock key={i} block={block} toolResults={toolResults} />
      ))}
      {tooltip && createdAt && createPortal(
        <div
          className="bubble-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {formatTimestamp(createdAt)}
        </div>,
        document.body
      )}
    </div>
  )
}

function ContentBlock({
  block,
  toolResults,
}: {
  block: MessageContentBlock
  toolResults: Map<string, { output: string; isError?: boolean }>
}) {
  if (block.type === 'text') {
    return <TextContent text={block.text} />
  }

  if (block.type === 'image') {
    return (
      <div className="message-content">
        <img
          src={`data:${block.mediaType};base64,${block.base64}`}
          alt="Attached image"
          style={{ maxWidth: '100%', borderRadius: 8, marginTop: 4 }}
        />
      </div>
    )
  }

  if (block.type === 'tool-call') {
    const result = toolResults.get(block.toolId)
    return (
      <ToolCallBlock
        toolName={block.toolName}
        input={block.input}
        output={result?.output}
        isError={result?.isError}
        isRunning={!result}
      />
    )
  }

  if (block.type === 'tool-result') {
    // Tool results are rendered inline with their tool-call blocks
    return null
  }

  if (block.type === 'cost') {
    return (
      <div className="message-cost">
        <span>{block.inputTokens.toLocaleString()} in</span>
        <span>{block.outputTokens.toLocaleString()} out</span>
        {block.costUsd !== undefined && (
          <span>${block.costUsd.toFixed(4)}</span>
        )}
        {block.durationMs !== undefined && (
          <span>{(block.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>
    )
  }

  if (block.type === 'error') {
    return <div className="message-error">{block.message}</div>
  }

  return null
}

function TextContent({ text }: { text: string }) {
  const html = useMemo(() => {
    const renderer = new marked.Renderer()
    marked.setOptions({
      renderer,
      breaks: true,
    })
    return marked.parse(text) as string
  }, [text])

  return (
    <div
      className="message-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
