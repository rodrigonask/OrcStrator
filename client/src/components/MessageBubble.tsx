import { memo, useMemo, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { ChatMessage, MessageContentBlock, VerbosityLevel } from '@shared/types'
import { ToolCallBlock } from './ToolCallBlock'
import { getOrcQuip } from '../utils/orcQuips'
import { useAppDispatch } from '../context/AppDispatchContext'

// Configure marked once at module level
marked.setOptions({ breaks: true })

interface MessageBubbleProps {
  message: ChatMessage
  toolResults: Map<string, { output: string; isError?: boolean }>
  verbosity?: VerbosityLevel
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

interface OrcBriefBubbleProps {
  taskTitle: string
  taskId: string
  instanceName: string
  projectId?: string
  fullPrompt: string
  createdAt: number
  messageId: string
}

function OrcBriefBubble({ taskTitle, instanceName, projectId, fullPrompt, createdAt, messageId }: OrcBriefBubbleProps) {
  const [expanded, setExpanded] = useState(false)
  const { dispatch } = useAppDispatch()
  const quip = getOrcQuip(instanceName, messageId)
  const parts = quip.split('{task}')

  const handleTaskClick = () => {
    if (projectId) {
      dispatch({ type: 'SET_PIPELINE_PROJECT', projectId })
    }
    dispatch({ type: 'SET_VIEW', payload: 'pipeline' })
  }

  return (
    <div className="orc-brief-bubble" style={{ boxShadow: '0 0 12px 2px rgba(168, 85, 247, 0.4), 0 0 4px 1px rgba(168, 85, 247, 0.2)' }}>
      <div className="orc-brief-header">
        <span className="orc-brief-icon">{'\uD83D\uDD04'}</span>
        <span className="orc-brief-quip" style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
          {parts.map((part, i) => (
            <span key={i}>
              {part}
              {i < parts.length - 1 && (
                <button
                  className="orc-brief-task-link"
                  onClick={handleTaskClick}
                  title={taskTitle}
                >
                  {taskTitle}
                </button>
              )}
            </span>
          ))}
        </span>
      </div>
      <button className="orc-brief-toggle" onClick={() => setExpanded(e => !e)} style={{ fontFamily: 'var(--font-mono)', fontSize: '7px' }}>
        {expanded ? 'Hide brief ↑' : 'View full brief ↓'}
      </button>
      {expanded && (
        <div className="orc-brief-full">
          <pre className="orc-brief-text">{fullPrompt}</pre>
        </div>
      )}
      {createdAt && (
        <div className="message-timestamp" style={{ fontFamily: 'var(--font-mono)' }}>{formatTimestamp(createdAt)}</div>
      )}
    </div>
  )
}

export const MessageBubble = memo(function MessageBubble({ message, toolResults, verbosity = 3 }: MessageBubbleProps) {
  const { role, content, createdAt } = message

  const orcBriefBlock = content[0]?.type === 'orc-brief'
    ? content[0] as { type: 'orc-brief'; taskTitle: string; taskId: string; instanceName: string; projectId?: string }
    : null

  if (orcBriefBlock) {
    const textBlock = content.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined
    return (
      <OrcBriefBubble
        taskTitle={orcBriefBlock.taskTitle}
        taskId={orcBriefBlock.taskId}
        instanceName={orcBriefBlock.instanceName}
        projectId={orcBriefBlock.projectId}
        fullPrompt={textBlock?.text ?? ''}
        createdAt={createdAt}
        messageId={message.id}
      />
    )
  }

  const nonToolContent = content.filter(b => {
    if (b.type === 'tool-call' || b.type === 'tool-result') return false
    // Level 1: hide cost blocks
    if (b.type === 'cost' && verbosity <= 1) return false
    return true
  })

  return (
    <div className={`message-bubble ${role}`}>
      {role === 'system' && <div className="message-role-label" style={{ fontFamily: 'var(--font-mono)', fontSize: '7px' }}>The Orc</div>}
      {nonToolContent.map((block, i) => (
        <ContentBlock key={i} block={block} toolResults={toolResults} verbosity={verbosity} isHuman={role === 'human'} />
      ))}
      {createdAt && (
        <div className="message-timestamp" style={{ fontFamily: 'var(--font-mono)' }}>{formatTimestamp(createdAt)}</div>
      )}
    </div>
  )
})

function ContentBlock({
  block,
  toolResults,
  defaultExpanded = false,
  verbosity = 3,
  isHuman = false,
}: {
  block: MessageContentBlock
  toolResults: Map<string, { output: string; isError?: boolean }>
  defaultExpanded?: boolean
  verbosity?: VerbosityLevel
  isHuman?: boolean
}) {
  if (block.type === 'text') {
    if (!block.text.trim()) return null
    const collapseAt = verbosity >= 5 ? Infinity : verbosity >= 4 ? 1200 : 600
    return <TextContent text={block.text} collapseChars={collapseAt} escapeHtml={isHuman} />
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
        verbosity={verbosity}
      />
    )
  }

  if (block.type === 'tool-result') {
    // Tool results are rendered inline with their tool-call blocks
    return null
  }

  if (block.type === 'cost') {
    return (
      <div className="message-cost" style={{ fontFamily: 'var(--font-mono)', fontSize: '7px' }}>
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

function TextContent({ text, collapseChars = 600, escapeHtml = false }: { text: string; collapseChars?: number; escapeHtml?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const isTall = collapseChars < Infinity && text.length > collapseChars
  const displayText = isTall && !expanded ? text.slice(0, collapseChars) : text

  const html = useMemo(() => {
    const safeText = escapeHtml ? displayText.replace(/</g, '&lt;').replace(/>/g, '&gt;') : displayText
    const raw = marked.parse(safeText) as string
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
