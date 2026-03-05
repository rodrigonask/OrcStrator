import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { ChatMessage, MessageContentBlock } from '@shared/types'
import { ToolCallBlock } from './ToolCallBlock'
import { summarizeToolCalls } from '../utils/toolFormat'

// Configure marked once at module level
marked.setOptions({ breaks: true })

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
  if (dateStr === todayStr) return time

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (dateStr === yesterday.toDateString()) return `Yesterday ${time}`

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return `${days[date.getDay()]} ${date.getDate()} ${time}`
}

export const MessageBubble = memo(function MessageBubble({ message, toolResults }: MessageBubbleProps) {
  const { role, content, createdAt } = message
  const [toolsExpanded, setToolsExpanded] = useState(false)

  const toolCallBlocks = useMemo(
    () => content.filter(b => b.type === 'tool-call'),
    [content]
  )
  const summary = useMemo(
    () => summarizeToolCalls(toolCallBlocks.map(b => ({ toolName: (b as { type: 'tool-call'; toolName: string }).toolName }))),
    [toolCallBlocks]
  )

  const nonToolContent = content.filter(b => b.type !== 'tool-call' && b.type !== 'tool-result')
  const hasSummary = role === 'assistant' && toolCallBlocks.length > 0

  return (
    <div className={`message-bubble ${role}`}>
      {role === 'system' && <div className="message-role-label">System</div>}
      {nonToolContent.map((block, i) => (
        <ContentBlock key={i} block={block} toolResults={toolResults} />
      ))}
      {hasSummary && (
        <div className="tool-summary" onClick={() => setToolsExpanded(e => !e)}>
          <span className="tool-summary-icon">🔧</span>
          <span className="tool-summary-text">{summary}</span>
          <span className={`tool-call-chevron ${toolsExpanded ? 'expanded' : ''}`}>›</span>
        </div>
      )}
      {hasSummary && toolsExpanded && toolCallBlocks.map((block, i) => (
        <ContentBlock key={`tc-${i}`} block={block} toolResults={toolResults} defaultExpanded={false} />
      ))}
      {createdAt && (
        <div className="message-timestamp">{formatTimestamp(createdAt)}</div>
      )}
    </div>
  )
})

function ContentBlock({
  block,
  toolResults,
  defaultExpanded = false,
}: {
  block: MessageContentBlock
  toolResults: Map<string, { output: string; isError?: boolean }>
  defaultExpanded?: boolean
}) {
  if (block.type === 'text') {
    if (!block.text.trim()) return null
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
        defaultExpanded={defaultExpanded}
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

const COLLAPSE_HEIGHT = 280

function TextContent({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text) as string
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'del',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
        'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'hr', 'div', 'span', 'sup', 'sub',
      ],
      ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'target', 'rel'],
    })
  }, [text])

  const contentRef = useRef<HTMLDivElement>(null)
  const [isTall, setIsTall] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (contentRef.current) {
      setIsTall(contentRef.current.scrollHeight > COLLAPSE_HEIGHT)
    }
  }, [html])

  const isCollapsed = isTall && !expanded

  return (
    <div className={`message-content-wrapper${isCollapsed ? ' collapsed' : ''}`}>
      <div
        ref={contentRef}
        className="message-content"
        style={isCollapsed ? { maxHeight: COLLAPSE_HEIGHT, overflow: 'hidden' } : undefined}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {isCollapsed && <div className="message-content-fade" />}
      {isTall && (
        <button className="view-more-btn" onClick={() => setExpanded(e => !e)}>
          {expanded ? 'View less ↑' : 'View more... ↓'}
        </button>
      )}
    </div>
  )
}
