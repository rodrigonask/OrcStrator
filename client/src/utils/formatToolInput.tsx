import type { ReactNode } from 'react'
import { shortenPath } from './toolFormat'

interface FormattedToolInputProps {
  toolName: string
  input: string
}

// Keys whose string values should render as code blocks
const CODE_KEYS = new Set(['code', 'command', 'new_string', 'old_string', 'content', 'script', 'prompt'])
const PATH_KEYS = new Set(['file_path', 'path', 'directory'])
const CODE_PATTERNS = /\b(await |const |let |var |function |import |export |if \(|else |return |=>|class |for \(|while \(|try |catch |switch )/

function isCodeLike(key: string, value: string): boolean {
  if (CODE_KEYS.has(key)) return true
  const lines = value.split('\n')
  return lines.length >= 3 && CODE_PATTERNS.test(value)
}

function isPathLike(key: string, value: string): boolean {
  if (PATH_KEYS.has(key)) return true
  return /^[A-Z]:[/\\]|^\/[a-z]/.test(value) && value.length > 5
}

// --- Structured renderers per tool ---

function renderBash(parsed: Record<string, unknown>): ReactNode {
  const { command, description, timeout, run_in_background } = parsed
  const chips: [string, unknown][] = []
  if (timeout) chips.push(['timeout', timeout])
  if (run_in_background) chips.push(['background', 'true'])
  return (
    <div className="tcf-structured">
      {description && <div className="tcf-description">{String(description)}</div>}
      {command && <pre className="tcf-bash-command">$ {String(command)}</pre>}
      {chips.length > 0 && renderKvChips(chips)}
    </div>
  )
}

function renderRead(parsed: Record<string, unknown>): ReactNode {
  const { file_path, offset, limit, pages } = parsed
  const chips: [string, unknown][] = []
  if (offset) chips.push(['offset', offset])
  if (limit) chips.push(['limit', limit])
  if (pages) chips.push(['pages', pages])
  return (
    <div className="tcf-structured">
      {file_path && <span className="tcf-file-path">{shortenPath(String(file_path))}</span>}
      {chips.length > 0 && renderKvChips(chips)}
    </div>
  )
}

function renderEdit(parsed: Record<string, unknown>): ReactNode {
  const { file_path, old_string, new_string, replace_all } = parsed
  const chips: [string, unknown][] = []
  if (replace_all) chips.push(['replace_all', 'true'])
  return (
    <div className="tcf-structured">
      {file_path && <span className="tcf-file-path">{shortenPath(String(file_path))}</span>}
      {old_string != null && (
        <>
          <span className="tcf-label">old_string:</span>
          <pre className="tcf-code-block old">{String(old_string)}</pre>
        </>
      )}
      {new_string != null && (
        <>
          <span className="tcf-label">new_string:</span>
          <pre className="tcf-code-block new">{String(new_string)}</pre>
        </>
      )}
      {chips.length > 0 && renderKvChips(chips)}
    </div>
  )
}

function renderWrite(parsed: Record<string, unknown>): ReactNode {
  const { file_path, content } = parsed
  return (
    <div className="tcf-structured">
      {file_path && <span className="tcf-file-path">{shortenPath(String(file_path))}</span>}
      {content != null && (
        <>
          <span className="tcf-label">content:</span>
          <pre className="tcf-code-block">{String(content)}</pre>
        </>
      )}
    </div>
  )
}

function renderGrep(parsed: Record<string, unknown>): ReactNode {
  const { pattern, path, glob, output_mode, type, ...rest } = parsed as Record<string, unknown>
  const chips: [string, unknown][] = []
  if (glob) chips.push(['glob', glob])
  if (output_mode) chips.push(['mode', output_mode])
  if (type) chips.push(['type', type])
  // Add remaining non-null options
  for (const [k, v] of Object.entries(rest)) {
    if (v != null && v !== false && v !== 0) chips.push([k, v])
  }
  return (
    <div className="tcf-structured">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {pattern && <span className="tcf-grep-pattern">{String(pattern)}</span>}
        {path && <><span className="tcf-label" style={{ margin: 0 }}>in</span> <span className="tcf-file-path">{shortenPath(String(path))}</span></>}
      </div>
      {chips.length > 0 && renderKvChips(chips)}
    </div>
  )
}

function renderGlob(parsed: Record<string, unknown>): ReactNode {
  const { pattern, path } = parsed
  return (
    <div className="tcf-structured">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {pattern && <span className="tcf-grep-pattern">{String(pattern)}</span>}
        {path && <><span className="tcf-label" style={{ margin: 0 }}>in</span> <span className="tcf-file-path">{shortenPath(String(path))}</span></>}
      </div>
    </div>
  )
}

function renderWebFetch(parsed: Record<string, unknown>): ReactNode {
  const { url, ...rest } = parsed
  const chips = Object.entries(rest).filter(([, v]) => v != null && v !== false) as [string, unknown][]
  return (
    <div className="tcf-structured">
      {url && <span className="tcf-file-path" style={{ wordBreak: 'break-all' }}>{String(url)}</span>}
      {chips.length > 0 && renderKvChips(chips)}
    </div>
  )
}

function renderWebSearch(parsed: Record<string, unknown>): ReactNode {
  const { query, ...rest } = parsed
  const chips = Object.entries(rest).filter(([, v]) => v != null && v !== false) as [string, unknown][]
  return (
    <div className="tcf-structured">
      {query && <span className="tcf-grep-pattern">{String(query)}</span>}
      {chips.length > 0 && renderKvChips(chips)}
    </div>
  )
}

function renderAgent(parsed: Record<string, unknown>): ReactNode {
  const { description, subagent_type, prompt, ...rest } = parsed
  const chips: [string, unknown][] = []
  if (subagent_type) chips.push(['type', subagent_type])
  for (const [k, v] of Object.entries(rest)) {
    if (v != null && v !== false && k !== 'prompt') chips.push([k, v])
  }
  return (
    <div className="tcf-structured">
      {description && <div className="tcf-description">{String(description)}</div>}
      {chips.length > 0 && renderKvChips(chips)}
      {prompt != null && (
        <>
          <span className="tcf-label">prompt:</span>
          <pre className="tcf-code-block">{String(prompt)}</pre>
        </>
      )}
    </div>
  )
}

/** Generic: tool has a `code` field — render it prominently */
function renderCodeTool(parsed: Record<string, unknown>): ReactNode | null {
  if (!('code' in parsed)) return null
  const { code, ...rest } = parsed
  const chips = Object.entries(rest).filter(([, v]) => v != null && v !== false) as [string, unknown][]
  return (
    <div className="tcf-structured">
      {chips.length > 0 && renderKvChips(chips)}
      <pre className="tcf-code-block">{String(code)}</pre>
    </div>
  )
}

// --- Helpers ---

function renderKvChips(pairs: [string, unknown][]): ReactNode {
  return (
    <div className="tcf-kv-row">
      {pairs.map(([k, v]) => (
        <span key={k} className="tcf-kv-chip">
          <span className="tcf-kv-key">{k}</span>
          <span className="tcf-kv-val">{String(v)}</span>
        </span>
      ))}
    </div>
  )
}

function tryStructuredRender(toolName: string, parsed: Record<string, unknown>): ReactNode | null {
  switch (toolName) {
    case 'Bash': return renderBash(parsed)
    case 'Read': return renderRead(parsed)
    case 'Edit': return renderEdit(parsed)
    case 'Write': return renderWrite(parsed)
    case 'Grep': return renderGrep(parsed)
    case 'Glob': return renderGlob(parsed)
    case 'WebFetch': return renderWebFetch(parsed)
    case 'WebSearch': return renderWebSearch(parsed)
    case 'Agent': return renderAgent(parsed)
    default:
      // For MCP tools or any tool with a `code` field
      if ('code' in parsed) return renderCodeTool(parsed)
      return null
  }
}

// --- Syntax-highlighted JSON fallback ---

function renderHighlightedJson(value: unknown, indent: number = 0): ReactNode[] {
  const pad = '  '.repeat(indent)
  const nodes: ReactNode[] = []
  let key = 0

  if (value === null) {
    nodes.push(<span key={key++} className="tcf-null">null</span>)
  } else if (typeof value === 'boolean') {
    nodes.push(<span key={key++} className="tcf-bool">{String(value)}</span>)
  } else if (typeof value === 'number') {
    nodes.push(<span key={key++} className="tcf-num">{String(value)}</span>)
  } else if (typeof value === 'string') {
    nodes.push(<span key={key++} className="tcf-str">"{escapeForDisplay(value)}"</span>)
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      nodes.push(<span key={key++} className="tcf-bracket">[]</span>)
    } else {
      nodes.push(<span key={key++} className="tcf-bracket">[</span>)
      nodes.push('\n')
      value.forEach((item, i) => {
        nodes.push(pad + '  ')
        nodes.push(...renderHighlightedJson(item, indent + 1))
        if (i < value.length - 1) nodes.push(<span key={`c${i}`} className="tcf-bracket">,</span>)
        nodes.push('\n')
      })
      nodes.push(pad)
      nodes.push(<span key={key++} className="tcf-bracket">]</span>)
    }
  } else if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) {
      nodes.push(<span key={key++} className="tcf-bracket">{'{}'}</span>)
    } else {
      nodes.push(<span key={key++} className="tcf-bracket">{'{'}</span>)
      nodes.push('\n')
      entries.forEach(([k, v], i) => {
        const valStr = typeof v === 'string' ? v : ''
        // Detect code-like strings and render as code blocks
        if (typeof v === 'string' && isCodeLike(k, v)) {
          nodes.push(pad + '  ')
          nodes.push(<span key={`k${i}`} className="tcf-key">"{k}"</span>)
          nodes.push(<span key={`colon${i}`} className="tcf-bracket">: </span>)
          nodes.push('\n')
          nodes.push(<pre key={`code${i}`} className="tcf-code-block" style={{ margin: `2px 0 2px ${(indent + 1) * 16}px` }}>{v}</pre>)
        } else if (typeof v === 'string' && isPathLike(k, valStr)) {
          nodes.push(pad + '  ')
          nodes.push(<span key={`k${i}`} className="tcf-key">"{k}"</span>)
          nodes.push(<span key={`colon${i}`} className="tcf-bracket">: </span>)
          nodes.push(<span key={`path${i}`} className="tcf-file-path" style={{ display: 'inline' }}>{shortenPath(v)}</span>)
        } else {
          nodes.push(pad + '  ')
          nodes.push(<span key={`k${i}`} className="tcf-key">"{k}"</span>)
          nodes.push(<span key={`colon${i}`} className="tcf-bracket">: </span>)
          nodes.push(...renderHighlightedJson(v, indent + 1))
        }
        if (i < entries.length - 1) nodes.push(<span key={`comma${i}`} className="tcf-bracket">,</span>)
        nodes.push('\n')
      })
      nodes.push(pad)
      nodes.push(<span key={key++} className="tcf-bracket">{'}'}</span>)
    }
  }

  return nodes
}

function escapeForDisplay(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

// --- Main component ---

export function FormattedToolInput({ toolName, input }: FormattedToolInputProps) {
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(input)
  } catch {
    // Not valid JSON — show raw
    return <pre className="tool-call-json">{input}</pre>
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return <pre className="tcf-json">{renderHighlightedJson(parsed)}</pre>
  }

  // Try structured render for known tools
  const structured = tryStructuredRender(toolName, parsed)
  if (structured) return <>{structured}</>

  // Fallback: syntax-highlighted JSON
  return <pre className="tcf-json">{renderHighlightedJson(parsed)}</pre>
}
