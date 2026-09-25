import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import DOMPurify from 'dompurify'
import type { ChatMessage, MessageContentBlock, VerbosityLevel } from '@shared/types'
import { findSecretMatches, SECRET_HOVER_HINT } from '@shared/secrets'
import { ToolCallBlock } from './ToolCallBlock'
import { useUI } from '../context/UIContext'
import { api } from '../api'
import { parseMarkdown, truncateMarkdown } from '../utils/markdown'
import { formatDuration } from '../utils/duration'

interface MessageBubbleProps {
  message: ChatMessage
  toolResults: Map<string, { output: string; isError?: boolean }>
  verbosity?: VerbosityLevel
  /** Set only on the chat's LAST message: how long that turn took, in ms. Comes from the
   *  instance (instance.lastTurnMs), not the message row, so it stays correct across
   *  reloads and moves to the new last message as the chat grows. */
  workedForMs?: number
}


// Time only for today ("8:45 AM"); older messages carry their date too
// ("Wed 11 · 9:51 PM") — a bare time on a stale chat read as "just now".
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function formatTimestamp(ts: number): string {
  const date = new Date(ts)
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const hours = date.getHours()
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const h12 = hours % 12 || 12
  const time = `${h12}:${minutes} ${ampm}`
  const now = new Date()
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  if (isToday) return time
  const sameYear = date.getFullYear() === now.getFullYear()
  const day = `${DAY_NAMES[date.getDay()]} ${date.getDate()}${sameYear ? '' : ` ${date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`}`
  return `${day} · ${time}`
}

export const MessageBubble = memo(function MessageBubble({ message, toolResults, verbosity = 3, workedForMs }: MessageBubbleProps) {
  const { role, content, createdAt } = message

  const nonToolContent = content.filter(b => {
    if (b.type === 'tool-call' || b.type === 'tool-result') return false
    // Level 1: hide cost blocks
    if (b.type === 'cost' && verbosity <= 1) return false
    return true
  })

  // One line, one element. The duration rides along with the timestamp rather than
  // occupying a row of its own: inside a grid tile the timestamp is hover-only, so a
  // separate always-visible footnote had to reserve a line under EVERY bubble to avoid
  // nudging the tile when a turn finished. That reservation cost 11px per message for
  // something shown on one message per chat. Both values now live in the hover pill and
  // the meta row takes no space at all until you hover.
  const metaText = [
    workedForMs ? `worked for ${formatDuration(workedForMs)}` : null,
    createdAt ? formatTimestamp(createdAt) : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className={`message-bubble ${role}`}>
      {role === 'system' && <div className="message-role-label" style={{ fontFamily: 'var(--font-mono)', fontSize: '7px' }}>The Orc</div>}
      {nonToolContent.map((block, i) => (
        <ContentBlock key={i} block={block} toolResults={toolResults} verbosity={verbosity} isHuman={String(role) === 'human'} persistKey={`${message.id}:${i}`} instanceId={message.instanceId} />
      ))}
      {metaText && (
        <div className="message-meta" style={{ fontFamily: 'var(--font-mono)' }}>
          {/* No per-chat record claim here. instances.max_turn_ms starts NULL on every
              existing chat, so the first turn after this ships writes both columns to the
              same value and any "longest here" marker derived from it would be trivially
              true: a 30s turn would announce itself as the record on a chat holding a real
              64-minute turn. It only becomes trustworthy once the historical backfill runs.
              The all-time record lives on the usage page, which reads turn_costs. */}
          <span className="message-timestamp" title={workedForMs ? `This turn took ${formatDuration(workedForMs)} end to end.` : undefined}>
            {metaText}
          </span>
        </div>
      )}
    </div>
  )
})

// Detects "API Error: 400 ... invalid_request_error ... surrogate ..." messages
// emitted by Claude CLI when the session JSONL contains an unpaired UTF-16 surrogate.
function isSurrogateApiError(text: string): boolean {
  return /invalid_request_error/.test(text) && /surrogate/.test(text)
}

// Detects the Claude CLI's isolation-worktree guard. A session that ran inside a worktree
// stays pinned to it; once the worktree is removed (but its empty directory survives, which
// is the norm on Windows) git resolves that path to the PARENT checkout, the CLI refuses to
// run there, and exits 1 before the turn starts. Nothing self-heals, so the tab is dead on
// every subsequent message until the pin is cleared.
function isDeadWorktreeError(text: string): boolean {
  return /cannot resume into worktree/i.test(text)
    || (/as an isolation worktree/i.test(text) && /Refusing to use/i.test(text))
}

function WorktreeRecoveryAction({ instanceId }: { instanceId: string }) {
  const [state, setState] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const [detail, setDetail] = useState<string>('')

  if (!instanceId) return null

  const handleClick = async () => {
    setState('running')
    setDetail('')
    try {
      const res = await api.repairWorktree(instanceId)
      if (res.ok) {
        setState('success')
        setDetail(
          res.alreadyClear
            ? 'No stale worktree left to clear — send your message again.'
            : `Unpinned from ${res.worktreeName || res.worktreePath}. Send your message again.`
        )
      } else {
        setState('error')
        setDetail(res.error || 'Unknown error')
      }
    } catch (e) {
      setState('error')
      setDetail((e as Error).message)
    }
  }

  return (
    <div className="worktree-recovery">
      <div className="worktree-recovery-explainer">
        This chat is pinned to an isolation worktree that no longer exists, so the CLI refuses to start a turn. Clearing the pin returns it to the chat's own folder. Your history is kept.
      </div>
      <button
        className="worktree-recovery-button"
        onClick={handleClick}
        disabled={state === 'running' || state === 'success'}
      >
        {state === 'idle' && 'Repair worktree pin'}
        {state === 'running' && 'Repairing…'}
        {state === 'success' && '✓ Repaired'}
        {state === 'error' && 'Retry repair'}
      </button>
      {detail && (
        <div className={`worktree-recovery-detail ${state}`}>{detail}</div>
      )}
    </div>
  )
}

function SurrogateRecoveryAction({ instanceId }: { instanceId: string }) {
  const [state, setState] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const [detail, setDetail] = useState<string>('')

  if (!instanceId) return null

  const handleClick = async () => {
    setState('running')
    setDetail('')
    try {
      const res = await api.sanitizeSurrogates(instanceId)
      if (res.ok) {
        setState('success')
        if (res.removedChars === 0) {
          setDetail('Session file already clean — try sending again.')
        } else {
          setDetail(`Removed ${res.removedChars} chars across ${res.affectedLines} line(s). Try sending again.`)
        }
      } else {
        setState('error')
        setDetail(res.error || 'Unknown error')
      }
    } catch (e) {
      setState('error')
      setDetail((e as Error).message)
    }
  }

  return (
    <div className="surrogate-recovery">
      <div className="surrogate-recovery-explainer">
        Session file contains an unpaired character (likely a truncated emoji paste). The API rejects every retry until it's removed.
      </div>
      <button
        className="surrogate-recovery-button"
        onClick={handleClick}
        disabled={state === 'running' || state === 'success'}
      >
        {state === 'idle' && 'Sanitize session file'}
        {state === 'running' && 'Sanitizing…'}
        {state === 'success' && '✓ Sanitized'}
        {state === 'error' && 'Retry sanitize'}
      </button>
      {detail && (
        <div className={`surrogate-recovery-detail ${state}`}>{detail}</div>
      )}
    </div>
  )
}

function ContentBlock({
  block,
  toolResults,
  defaultExpanded = false,
  verbosity = 3,
  isHuman = false,
  persistKey,
  instanceId,
}: {
  block: MessageContentBlock
  toolResults: Map<string, { output: string; isError?: boolean }>
  defaultExpanded?: boolean
  verbosity?: VerbosityLevel
  isHuman?: boolean
  persistKey?: string
  /** The message's OWN instance, not the selected one — recovery actions must target the
   *  chat that actually failed, which in Grid is rarely the selected tile. */
  instanceId?: string
}) {
  if (block.type === 'text') {
    if (!block.text.trim()) return null
    const collapseAt = verbosity >= 5 ? Infinity : verbosity >= 4 ? 1200 : 600
    if (instanceId && isSurrogateApiError(block.text)) {
      return (
        <>
          <TextContent text={block.text} collapseChars={collapseAt} escapeHtml={isHuman} persistKey={persistKey} />
          <SurrogateRecoveryAction instanceId={instanceId} />
        </>
      )
    }
    if (instanceId && isDeadWorktreeError(block.text)) {
      return (
        <>
          <TextContent text={block.text} collapseChars={collapseAt} escapeHtml={isHuman} persistKey={persistKey} />
          <WorktreeRecoveryAction instanceId={instanceId} />
        </>
      )
    }
    return <TextContent text={block.text} collapseChars={collapseAt} escapeHtml={isHuman} persistKey={persistKey} />
  }

  // Thinking blocks are never rendered — they're internal model reasoning, not output.
  if (block.type === 'thinking') return null

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
        toolId={block.toolId}
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

// Auto-linkify URLs (http/https) in rendered HTML. Runs after marked so it sees the
// actual rendered output (including inside <code>); skips content already inside <a>
// tags so markdown links aren't double-wrapped. File paths are linkified earlier, by
// parseMarkdown({ linkPaths: true }): they have to be lifted out before parsing, or
// markdown's escape rules eat the backslashes.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g
const TRAILING_PUNCT_RE = /([.,;:!?)\]}'"`]+)$/

function autoLinkify(html: string): string {
  const parts = html.split(/(<a\b[^>]*>[\s\S]*?<\/a>)/g)
  return parts.map((part, i) => {
    if (i % 2 === 1) return part
    return part
      .replace(URL_RE, (m) => {
        const trail = m.match(TRAILING_PUNCT_RE)
        const core = trail ? m.slice(0, m.length - trail[0].length) : m
        const trailing = trail ? trail[0] : ''
        const safe = core.replace(/"/g, '&quot;')
        return `<a class="auto-url" href="${safe}" target="_blank" rel="noopener noreferrer">${core}</a>${trailing}`
      })
  }).join('')
}

// Wrap API-key / password shaped tokens in a red flag with a hover hint. Operates
// on rendered HTML: split into tag vs. text runs and scan only the text runs, so a
// match can never land inside a tag or attribute. Runs before autoLinkify (a bare
// key isn't a URL, so order is safe) and before DOMPurify (span/class/title are
// already allow-listed). Same detector the server scrub uses, so the warning and
// the deletion can't disagree.
function highlightSecretsHtml(html: string): string {
  const parts = html.split(/(<[^>]+>)/g)
  for (let i = 0; i < parts.length; i += 2) { // even indices = text between tags
    const text = parts[i]
    if (!text) continue
    const matches = findSecretMatches(text)
    if (!matches.length) continue
    let out = ''
    let last = 0
    for (const m of matches) {
      out += text.slice(last, m.start)
      out += `<span class="secret-flag" title="${SECRET_HOVER_HINT}">${text.slice(m.start, m.end)}</span>`
      last = m.end
    }
    out += text.slice(last)
    parts[i] = out
  }
  return parts.join('')
}

// Every fenced code block gets a copy button. It is injected AFTER DOMPurify (static
// markup we author, so it needs no sanitizing) and sits inside a positioned wrapper, so
// showing it can never reflow the block underneath. The button carries no copy of the
// text: the click handler reads it back off the <pre> in the DOM, which keeps long
// blocks out of the HTML twice over and stays truthful if the block re-renders.
const PRE_RE = /<pre[^>]*>[\s\S]*?<\/pre>/g
const COPY_ICON = '<svg class="cc-idle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
const DONE_ICON = '<svg class="cc-done" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'

function addCopyButtons(html: string): string {
  return html.replace(PRE_RE, (pre) =>
    `<div class="code-block">${pre}` +
    `<button type="button" class="code-copy" title="Copy" aria-label="Copy code">${COPY_ICON}${DONE_ICON}</button>` +
    `</div>`)
}

// navigator.clipboard needs a secure context. localhost qualifies, a LAN IP does not,
// so keep the old execCommand path as a fallback rather than failing silently there.
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(ta)
  if (!ok) throw new Error('clipboard unavailable')
}

function renderContentHtml(text: string, escapeHtml: boolean): string {
  const safeText = escapeHtml ? text.replace(/</g, '&lt;').replace(/>/g, '&gt;') : text
  const raw = parseMarkdown(safeText, { linkPaths: true })
  const flagged = highlightSecretsHtml(raw)
  const linked = autoLinkify(flagged)
  return DOMPurify.sanitize(linked, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'del',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
      'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'hr', 'div', 'span', 'sup', 'sub',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'target', 'rel', 'data-path', 'data-path-alt'],
  })
}

// A collapsed bubble renders a TRUNCATED copy of the text, so the <pre> on screen can
// be a fragment of the real block — reading the DOM then copies half a prompt. Render
// the full text off-screen instead and take the block's complete text from there.
function fullCodeBlockTexts(text: string, escapeHtml: boolean): string[] {
  const holder = document.createElement('div')
  holder.innerHTML = renderContentHtml(text, escapeHtml)
  return Array.from(holder.querySelectorAll('pre')).map(pre => pre.textContent ?? '')
}

// "View more" expansion must survive component remounts — Virtuoso recycles
// off-screen items while a chat streams, and useState alone made expanded
// bubbles silently re-collapse mid-read. Keyed by message id + block index.
const expandedTextKeys = new Set<string>()

/**
 * The "couldn't open / couldn't copy" toast, rendered at the cursor, on document.body and
 * never inside the bubble that raised it.
 *
 * The UI zoom setting puts a `transform: scale()` on `.app`, and a transformed ancestor
 * becomes the containing block for `position: fixed` descendants. Rendered in place, the
 * toast read its left/top (viewport pixels, straight off clientX/clientY) as `.app`-local
 * pixels: a click at x=1922 put the box at x=3819, off screen, squeezed to a 56px-wide
 * vertical sliver, with max-width measured against the wrong box. So a failed click showed
 * no error at all.
 *
 * The worse half was the layout. Sitting in the message list, that runaway box counted as
 * the list's own overflow: scrollWidth 1955px against a 414px client width. A horizontal
 * scrollbar appeared, the list lost 7px of height, its scrollHeight was re-measured and
 * it re-pinned to the bottom: the transcript lurched ~470px on every click of a path link
 * that failed to open. Clicking a file path looked like the window rearranging itself.
 *
 * A portal to document.body escapes the transform, so `fixed` means the viewport again and
 * the toast can never contribute overflow to a scroller.
 */
function CursorToast({ msg, x, y }: { msg: string; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null)

  // Keep it on screen. The CSS centres the box on x and floats it above y, so a click near
  // an edge would otherwise push half of a long path out of view.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const half = rect.width / 2
    el.style.left = `${Math.min(Math.max(x, half + 8), window.innerWidth - half - 8)}px`
    el.style.top = `${Math.max(y, rect.height + 18)}px`
  }, [msg, x, y])

  return createPortal(
    <div ref={ref} className="path-open-error" role="alert" style={{ left: x, top: y }}>
      {msg}
    </div>,
    document.body,
  )
}

function TextContent({ text, collapseChars = 600, escapeHtml = false, persistKey }: { text: string; collapseChars?: number; escapeHtml?: boolean; persistKey?: string }) {
  const [expanded, setExpandedRaw] = useState(() => (persistKey ? expandedTextKeys.has(persistKey) : false))
  const setExpanded = (updater: (prev: boolean) => boolean) => {
    setExpandedRaw(prev => {
      const next = updater(prev)
      if (persistKey) {
        if (next) expandedTextKeys.add(persistKey)
        else expandedTextKeys.delete(persistKey)
      }
      return next
    })
  }
  const isTall = collapseChars < Infinity && text.length > collapseChars
  const displayText = isTall && !expanded ? truncateMarkdown(text, collapseChars) : text

  const html = useMemo(() => addCopyButtons(renderContentHtml(displayText, escapeHtml)), [displayText, escapeHtml])

  // A dead click used to be indistinguishable from a successful one: every failure
  // went to console.error. Say what went wrong, at the cursor, and get out of the way.
  const [openError, setOpenError] = useState<{ msg: string; x: number; y: number } | null>(null)
  const errorTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(errorTimer.current), [])

  const copyTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const copyBtn = target.closest('button.code-copy') as HTMLButtonElement | null
    if (copyBtn) {
      e.preventDefault()
      const wrapper = copyBtn.parentElement
      let blockText = wrapper?.querySelector('pre')?.textContent ?? ''
      if (isTall && !expanded && wrapper) {
        // Truncation only ever cuts the tail, so the Nth block on screen is still the
        // Nth block of the full text.
        const idx = Array.from(e.currentTarget.querySelectorAll('div.code-block')).indexOf(wrapper)
        const full = idx === -1 ? undefined : fullCodeBlockTexts(text, escapeHtml)[idx]
        if (full !== undefined) blockText = full
      }
      const { clientX: cx, clientY: cy } = e
      copyText(blockText)
        .then(() => {
          copyBtn.dataset.copied = 'true'
          window.clearTimeout(copyTimer.current)
          copyTimer.current = window.setTimeout(() => { delete copyBtn.dataset.copied }, 1400)
        })
        .catch((err: Error) => {
          window.clearTimeout(errorTimer.current)
          setOpenError({ msg: `Couldn't copy (${err.message})`, x: cx, y: cy })
          errorTimer.current = window.setTimeout(() => setOpenError(null), 5000)
        })
      return
    }
    const pathLink = target.closest('a.auto-path') as HTMLAnchorElement | null
    // .auto-url anchors fall through to the browser's default open-in-new-tab behavior.
    if (!pathLink) return
    e.preventDefault()
    const filePath = pathLink.getAttribute('data-path')
    if (!filePath) return
    const alt = pathLink.getAttribute('data-path-alt')
    const { clientX: x, clientY: y } = e
    api.openPath(filePath)
      .catch(err => (alt ? api.openPath(alt) : Promise.reject(err)))
      .catch((err: Error) => {
        window.clearTimeout(errorTimer.current)
        setOpenError({ msg: `Couldn't open ${filePath} (${err.message})`, x, y })
        errorTimer.current = window.setTimeout(() => setOpenError(null), 5000)
      })
  }

  return (
    <div className="message-content-wrapper">
      <div className="message-content" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />
      {openError && <CursorToast msg={openError.msg} x={openError.x} y={openError.y} />}
      {isTall && (
        <span className="view-more-inline" onClick={() => setExpanded(e => !e)}>
          {expanded ? 'View less ↑' : '... View more ↓'}
        </span>
      )}
    </div>
  )
}
