import { memo, useMemo, useState } from 'react'
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

  const TERSE_CHAR_THRESHOLD = 60
  const totalNonToolText = nonToolContent
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text.trim())
    .join('')
  const isToolOnly = role === 'assistant' &&
    toolCallBlocks.length > 0 &&
    totalNonToolText.length <= TERSE_CHAR_THRESHOLD &&
    nonToolContent.every(b => b.type !== 'image')
  const chipLabel = totalNonToolText ? `${totalNonToolText} · ${summary}` : summary

  if (isToolOnly) {
    return (
      <div className="tool-chip" onClick={() => setToolsExpanded(e => !e)}>
        <span className="tool-chip-icon">🔧</span>
        <span className="tool-chip-text">{chipLabel}</span>
        <span className={`tool-call-chevron ${toolsExpanded ? 'expanded' : ''}`}>›</span>
        {toolsExpanded && (
          <div className="tool-chip-expanded" onClick={e => e.stopPropagation()}>
            {toolCallBlocks.map((block, i) => (
              <ContentBlock key={i} block={block} toolResults={toolResults} defaultExpanded={false} />
            ))}
          </div>
        )}
      </div>
    )
  }

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

const COLLAPSE_CHARS = 600

function TextContent({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const isTall = text.length > COLLAPSE_CHARS
  const displayText = isTall && !expanded ? text.slice(0, COLLAPSE_CHARS) : text

  const html = useMemo(() => {
    const raw = marked.parse(displayText) as string
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
  }, [displayText])

  return (
    <div className="message-content-wrapper">
      <div className="message-content" dangerouslySetInnerHTML={{ __html: html }} />
      {isTall && (
        <span className="view-more-inline" onClick={() => setExpanded(e => !e)}>
          {expanded ? 'View less ↑' : '... View more ↓'}
        </span>
      )}
    </div>
  )
}
