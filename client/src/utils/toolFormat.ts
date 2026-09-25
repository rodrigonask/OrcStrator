export function shortenPath(path: string, max = 45): string {
  if (!path) return ''
  // Normalize separators
  const normalized = path.replace(/\\/g, '/')
  if (normalized.length <= max) return normalized
  // Try stripping common prefixes
  const prefixes = ['/c/Agents/', 'C:/Agents/', '/Users/', 'C:/Users/']
  for (const prefix of prefixes) {
    const lower = normalized.toLowerCase()
    const prefixLower = prefix.toLowerCase()
    if (lower.startsWith(prefixLower)) {
      const stripped = normalized.slice(prefix.length)
      if (stripped.length <= max) return stripped
      // Still too long — take last N chars
      return '...' + stripped.slice(-(max - 3))
    }
  }
  return '...' + normalized.slice(-(max - 3))
}

function bashCommand(input: string, maxLen = 60): string {
  try {
    const parsed = JSON.parse(input)
    const cmd = String(parsed.command ?? input)
    return cmd.length > maxLen ? cmd.slice(0, maxLen) + '…' : cmd
  } catch {
    return input.slice(0, maxLen)
  }
}

function firstPathArg(input: string): string {
  try {
    const parsed = JSON.parse(input)
    const val = parsed.file_path ?? parsed.path ?? parsed.pattern ?? parsed.query ?? ''
    return shortenPath(String(val))
  } catch {
    return ''
  }
}

function agentType(input: string): string {
  try {
    const parsed = JSON.parse(input)
    return parsed.subagent_type ?? parsed.type ?? 'sub'
  } catch {
    return 'sub'
  }
}

function hostname(input: string): string {
  try {
    const parsed = JSON.parse(input)
    const url = parsed.url ?? parsed.query ?? ''
    try { return new URL(url).hostname } catch { return url.slice(0, 30) }
  } catch {
    return ''
  }
}

function webQuery(input: string): string {
  try {
    const parsed = JSON.parse(input)
    const q = String(parsed.query ?? '')
    return q.length > 40 ? q.slice(0, 40) + '…' : q
  } catch {
    return ''
  }
}

function grepPattern(input: string): string {
  try {
    const parsed = JSON.parse(input)
    const p = String(parsed.pattern ?? '')
    return p.length > 40 ? p.slice(0, 40) + '…' : p
  } catch {
    return ''
  }
}

/** Live activity label shown while a tool is running */
export function formatToolLabel(toolName: string, input: string): string {
  switch (toolName) {
    case 'Read':       return `Reading ${firstPathArg(input)}...`
    case 'Edit':       return `Editing ${firstPathArg(input)}...`
    case 'Write':      return `Writing ${firstPathArg(input)}...`
    case 'Bash':       return `Running: ${bashCommand(input)}...`
    case 'Grep':       return `Searching "${grepPattern(input)}"...`
    case 'Glob':       return `Finding ${firstPathArg(input)}...`
    case 'WebFetch':   return `Fetching ${hostname(input)}...`
    case 'WebSearch':  return `Searching web: "${webQuery(input)}"...`
    case 'Agent':      return `Launching ${agentType(input)} agent...`
    case 'AskUserQuestion': return `Asking you a question...`
    case 'ExitPlanMode': return `Submitting plan...`
    case 'EnterPlanMode': return `Entering plan mode...`
    default:           return `Using ${toolName}...`
  }
}

/** Compressed static label for collapsed tool blocks */
export function formatToolCall(toolName: string, input: string): string {
  switch (toolName) {
    case 'Read':       return `Read: ${firstPathArg(input)}`
    case 'Edit':       return `Edit: ${firstPathArg(input)}`
    case 'Write':      return `Write: ${firstPathArg(input)}`
    case 'Bash':       return `Bash: ${bashCommand(input)}`
    case 'Grep':       return `Grep: "${grepPattern(input)}"`
    case 'Glob':       return `Glob: ${firstPathArg(input)}`
    case 'WebFetch':   return `Fetch: ${hostname(input)}`
    case 'WebSearch':  return `Web: "${webQuery(input)}"`
    case 'Agent':      return `Agent: ${agentType(input)}`
    case 'AskUserQuestion': return `AskUser`
    case 'ExitPlanMode': return `ExitPlan`
    case 'EnterPlanMode': return `EnterPlan`
    default:           return toolName
  }
}

/** Last path segment only — "…/components/FolderGroup.tsx" → "FolderGroup.tsx" */
function basename(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? norm.slice(i + 1) : norm
}

function firstPathBasename(input: string): string {
  try {
    const parsed = JSON.parse(input)
    const val = parsed.file_path ?? parsed.path ?? parsed.pattern ?? parsed.query ?? ''
    return basename(String(val))
  } catch {
    return ''
  }
}

/** Split a tool call into a muted verb + a highlightable argument (basename / command /
 *  pattern). The collapsed tool-group line renders the arg as a violet "file pill" while
 *  the verb and separators stay muted — matching the Aurora mockup's `.toolline`. Keeps a
 *  whole multi-tool group on one truncatable line; expand the group for full paths. */
export function toolCallParts(toolName: string, input: string): { verb: string; arg: string | null } {
  switch (toolName) {
    case 'Read':       return { verb: 'Read', arg: firstPathBasename(input) || null }
    case 'Edit':       return { verb: 'Edit', arg: firstPathBasename(input) || null }
    case 'Write':      return { verb: 'Write', arg: firstPathBasename(input) || null }
    case 'Bash':       return { verb: 'Bash', arg: bashCommand(input, 28) || null }
    case 'Grep':       return { verb: 'Grep', arg: `"${grepPattern(input)}"` }
    case 'Glob':       return { verb: 'Glob', arg: firstPathBasename(input) || null }
    case 'WebFetch':   return { verb: 'Fetch', arg: hostname(input) || null }
    case 'WebSearch':  return { verb: 'Web', arg: `"${webQuery(input)}"` }
    case 'Agent':      return { verb: 'Agent', arg: agentType(input) || null }
    case 'AskUserQuestion': return { verb: 'AskUser', arg: null }
    case 'ExitPlanMode':    return { verb: 'ExitPlan', arg: null }
    case 'EnterPlanMode':   return { verb: 'EnterPlan', arg: null }
    default:           return { verb: toolName, arg: null }
  }
}

/** Flat-string form of {@link toolCallParts} — "Read App.tsx", "Edit styles.css". */
export function formatToolCallShort(toolName: string, input: string): string {
  const { verb, arg } = toolCallParts(toolName, input)
  return arg ? `${verb} ${arg}` : verb
}

/** "4 tools: Read ×2, Edit, Bash" summary string */
export function summarizeToolCalls(tools: Array<{ toolName: string }>): string {
  if (tools.length === 0) return ''
  const counts = new Map<string, number>()
  for (const t of tools) {
    counts.set(t.toolName, (counts.get(t.toolName) ?? 0) + 1)
  }
  const parts = Array.from(counts.entries()).map(([name, count]) =>
    count > 1 ? `${name} ×${count}` : name
  )
  return `${tools.length} tool${tools.length > 1 ? 's' : ''}: ${parts.join(', ')}`
}
