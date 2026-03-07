import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import { createStreamParser } from './stream-parser.js'
import { broadcastEvent, broadcastTerminalLine } from '../ws/handler.js'
import { db } from '../db.js'
import { sanitizeSession } from './session-sanitizer.js'
import type { ClaudeStreamEvent, ClaudeProcessExitEvent } from '@nasklaude/shared'
import crypto from 'crypto'

// Lazily imported to avoid circular dependency at module init time
export interface ProcessExitTokens { inputTokens: number; outputTokens: number; costUsd: number; cacheReadTokens?: number; cacheCreationTokens?: number }
let _orchestratorNotify: ((instanceId: string, tokens?: ProcessExitTokens) => void) | null = null
export function setOrchestratorCallback(fn: (instanceId: string, tokens?: ProcessExitTokens) => void): void {
  _orchestratorNotify = fn
}

const processes = new Map<string, ChildProcess>()
const processTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
const supersededProcesses = new Set<ChildProcess>()

const PROCESS_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const BATCH_INTERVAL_MS = 32

interface SendMessageOpts {
  instanceId: string
  text: string
  images?: Array<{ base64: string; mediaType: string }>
  cwd: string
  sessionId?: string
  resume?: boolean
  flags?: string[]
  agentPrompt?: string
  mcpConfigPath?: string
}

const ALLOWED_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--system-prompt', '--append-system-prompt',
  '--permission-mode', '--model', '--max-tokens',
  '--verbose', '--output-format', '--input-format',
  '--resume', '--session-id', '--no-cache',
  '--mcp-config', '--strict-mcp-config',
  '--tools', '--allowedTools', '--disallowedTools'
])

function filterFlags(flags: string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    const flagName = flag.split('=')[0]
    if (ALLOWED_FLAGS.has(flagName)) {
      result.push(flag)
      // If next element is a value (not a flag), keep it as the argument
      if (i + 1 < flags.length && !flags[i + 1].startsWith('--')) {
        result.push(flags[++i])
      }
    }
  }
  return result
}

export function sendMessage(opts: SendMessageOpts): { sessionId: string } {
  const { instanceId, text, images, cwd, sessionId, resume, flags = [], agentPrompt, mcpConfigPath } = opts

  // Kill any existing process for this instance
  // Mark old child as superseded BEFORE killing so its exit handler is a no-op
  const oldChild = processes.get(instanceId)
  if (oldChild) supersededProcesses.add(oldChild)
  killProcess(instanceId)

  // Build CLI args
  const args: string[] = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json']

  // MCP scoping — --strict-mcp-config alone blocks all global servers;
  // --mcp-config adds back specific ones (e.g. playwriter for tester)
  if (mcpConfigPath) {
    args.push('--strict-mcp-config')
    // Only add --mcp-config if the file has actual server definitions (not empty)
    if (mcpConfigPath !== 'none') {
      args.push('--mcp-config', mcpConfigPath)
    }
  }

  // Resume existing session or start new one
  if (sessionId) {
    args.push('--resume', sessionId)
  }

  // Filtered user flags
  const safeFlags = filterFlags(flags)
  args.push(...safeFlags)

  // Agent system prompt — strip null bytes and other control chars (except \n, \r, \t)
  if (agentPrompt) {
    const sanitized = agentPrompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    if (sanitized.length > 0) {
      args.push('--append-system-prompt', sanitized)
    }
  }

  // Environment — delete CLAUDECODE to prevent nested session issues
  const env = { ...process.env }
  delete env['CLAUDECODE']
  // Trigger auto-compaction earlier to prevent runaway context growth
  env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'] = '60'

  // Spawn the process
  const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude'
  const child = spawn(cmd, args, {
    cwd,
    env,
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe']
  })

  processes.set(instanceId, child)

  // Update instance state
  db.prepare('UPDATE instances SET state = ? WHERE id = ?').run('running', instanceId)
  broadcastEvent({ type: 'instance:state', payload: { instanceId, state: 'running' } })

  // Stateful stream parser for this process (tracks index→toolId mapping)
  const parseLine = createStreamParser(instanceId)

  // Track session ID from system event
  let resolvedSessionId = sessionId || ''
  let lastCostUsd: number | undefined
  let lastInputTokens: number | undefined
  let lastOutputTokens: number | undefined
  let lastCacheCreation: number | undefined
  let lastCacheRead: number | undefined

  // Batching: accumulate events in 32ms windows
  let eventBatch: ClaudeStreamEvent[] = []
  let batchTimer: ReturnType<typeof setTimeout> | null = null

  function flushBatch(): void {
    if (eventBatch.length === 0) return
    const events = eventBatch
    eventBatch = []
    broadcastEvent({ type: 'claude:output-batch', payload: { instanceId, events } })
  }

  function enqueueEvent(event: ClaudeStreamEvent): void {
    // Raw lines go only to terminal subscribers (opt-in), not all clients
    if (event.type === 'raw-line') {
      broadcastTerminalLine(instanceId, { instanceId, events: [event] })
      return
    }
    // System events and results are sent immediately
    if (event.type === 'system' || event.type === 'result' || event.type === 'error') {
      flushBatch()
      broadcastEvent({ type: 'claude:output-batch', payload: { instanceId, events: [event] } })
      return
    }
    eventBatch.push(event)
    if (!batchTimer) {
      batchTimer = setTimeout(() => {
        batchTimer = null
        flushBatch()
      }, BATCH_INTERVAL_MS)
    }
  }

  // Read stdout line by line
  let stdoutBuffer = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString()
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() || ''

    for (const line of lines) {
      // Save assistant messages to DB before parsing
      try {
        const raw = JSON.parse(line.trim())
        if (raw.type === 'assistant' && raw.message?.content) {
          const msgId = crypto.randomUUID()
          const content = raw.message.content.map((b: Record<string, unknown>) => {
            if (b.type === 'text') return { type: 'text', text: b.text }
            if (b.type === 'tool_use') return { type: 'tool-call', toolId: b.id, toolName: b.name, input: JSON.stringify(b.input) }
            return b
          })
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, instance_id, role, content, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(msgId, instanceId, 'assistant', JSON.stringify(content), Date.now())
          db.prepare(`
            DELETE FROM messages
            WHERE instance_id = ?
            AND id NOT IN (
              SELECT id FROM messages
              WHERE instance_id = ?
              ORDER BY created_at DESC
              LIMIT 50
            )
          `).run(instanceId, instanceId)
        }
      } catch {
        // non-JSON line, ignore
      }

      // Forward raw line to client for terminal stream view
      if (line.trim()) {
        enqueueEvent({ type: 'raw-line', instanceId, line })
      }

      const parsed = parseLine(line)
      if (!parsed) continue
      const lineEvents = Array.isArray(parsed) ? parsed : [parsed]

      for (const event of lineEvents) {
        if (event.type === 'system' && event.sessionId) {
          resolvedSessionId = event.sessionId
          db.prepare('UPDATE instances SET session_id = ? WHERE id = ?').run(resolvedSessionId, instanceId)
        }

        if (event.type === 'result') {
          lastCostUsd = event.costUsd
          lastInputTokens = event.inputTokens
          lastOutputTokens = event.outputTokens
          lastCacheCreation = event.cacheCreationTokens
          lastCacheRead = event.cacheReadTokens
          console.log(`[claude-process] Result for ${instanceId}: in=${lastInputTokens} out=${lastOutputTokens} cost=$${lastCostUsd} cache_create=${lastCacheCreation} cache_read=${lastCacheRead}`)
        }

        enqueueEvent(event)
      }
    }
  })

  // Stderr — forward line-by-line as raw-line events
  let stderrBuffer = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString()
    const lines = stderrBuffer.split('\n')
    stderrBuffer = lines.pop() || ''
    for (const line of lines) {
      if (line.trim()) {
        console.error(`[claude-process] stderr [${instanceId.slice(0, 8)}]:`, line)
        enqueueEvent({ type: 'raw-line', instanceId, line, isStderr: true })
      }
    }
  })

  // Write user message to stdin as NDJSON, then close
  // stream-json format: { type: "user", message: { role: "user", content: "..." }, session_id, parent_tool_use_id }
  const messageContent: unknown[] = [{ type: 'text', text }]
  if (images && images.length > 0) {
    for (const img of images) {
      messageContent.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } })
    }
  }
  const inputMessage = {
    type: 'user',
    message: { role: 'user', content: messageContent },
    session_id: resolvedSessionId,
    parent_tool_use_id: null
  }
  child.stdin?.write(JSON.stringify(inputMessage) + '\n')
  child.stdin?.end()

  // Set process timeout
  const timeout = setTimeout(() => {
    console.warn(`[claude-process] Timeout for instance ${instanceId}, killing process`)
    killProcess(instanceId)
  }, PROCESS_TIMEOUT_MS)
  processTimeouts.set(instanceId, timeout)

  // Handle exit
  child.on('exit', (code) => {
    // Guard: skip cleanup if this process was replaced by a newer sendMessage call
    if (supersededProcesses.has(child)) {
      supersededProcesses.delete(child)
      return
    }

    // Clear timeout
    const t = processTimeouts.get(instanceId)
    if (t) {
      clearTimeout(t)
      processTimeouts.delete(instanceId)
    }

    // Flush remaining events (result line often arrives without trailing newline)
    if (stdoutBuffer.trim()) {
      const parsed = parseLine(stdoutBuffer)
      if (parsed) {
        const events = Array.isArray(parsed) ? parsed : [parsed]
        for (const event of events) {
          // Extract token data from result events flushed from buffer
          if (event.type === 'result') {
            lastCostUsd = event.costUsd
            lastInputTokens = event.inputTokens
            lastOutputTokens = event.outputTokens
            lastCacheCreation = event.cacheCreationTokens
            lastCacheRead = event.cacheReadTokens
            if (event.sessionId) resolvedSessionId = event.sessionId
            console.log(`[claude-process] Result (flush) for ${instanceId}: in=${lastInputTokens} out=${lastOutputTokens} cost=$${lastCostUsd}`)
          }
          enqueueEvent(event)
        }
      }
    }
    flushBatch()
    if (batchTimer) {
      clearTimeout(batchTimer)
      batchTimer = null
    }

    processes.delete(instanceId)

    // Update instance state, preserve session_id for resume on next task
    db.prepare('UPDATE instances SET state = ? WHERE id = ?').run('idle', instanceId)

    // Persist token usage to DB for monitoring
    if (lastInputTokens || lastOutputTokens) {
      const cacheRatio = lastInputTokens
        ? Math.round(((lastCacheRead || 0) / lastInputTokens) * 100)
        : 0
      console.log(`[claude-process] Token summary ${instanceId}: cost=$${(lastCostUsd || 0).toFixed(4)} cache_hit=${cacheRatio}% (read=${lastCacheRead || 0} create=${lastCacheCreation || 0})`)
      try {
        db.prepare(
          `UPDATE token_usage
           SET session_id = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?,
               cache_creation_tokens = ?, cache_read_tokens = ?, is_overdrive_session = ?
           WHERE instance_id = ? AND created_at = (SELECT MAX(created_at) FROM token_usage WHERE instance_id = ?)`
        ).run(
          resolvedSessionId || null,
          lastInputTokens || 0,
          lastOutputTokens || 0,
          lastCostUsd || 0,
          lastCacheCreation || 0,
          lastCacheRead || 0,
          sessionId ? 1 : 0,
          instanceId,
          instanceId
        )
      } catch { /* non-critical */ }
    } else {
      console.warn(`[claude-process] No token data captured for ${instanceId} — result event may not have arrived`)
    }

    // Clean up temp MCP config file if orchestrator generated one
    if (mcpConfigPath && mcpConfigPath.includes('nasklaude-mcp-')) {
      try { fs.unlinkSync(mcpConfigPath) } catch { /* already gone */ }
    }

    // Broadcast exit event
    const exitEvent: ClaudeProcessExitEvent = {
      instanceId,
      sessionId: resolvedSessionId || undefined,
      exitCode: code,
      costUsd: lastCostUsd,
      inputTokens: lastInputTokens,
      outputTokens: lastOutputTokens
    }
    broadcastEvent({ type: 'claude:process-exit', payload: exitEvent })
    broadcastEvent({ type: 'instance:state', payload: { instanceId, state: 'idle' } })

    // Notify orchestrator — event-driven dispatch (with token data for task accumulation)
    if (_orchestratorNotify) {
      const tokens: ProcessExitTokens | undefined = (lastInputTokens || lastOutputTokens)
        ? { inputTokens: lastInputTokens || 0, outputTokens: lastOutputTokens || 0, costUsd: lastCostUsd || 0, cacheReadTokens: lastCacheRead, cacheCreationTokens: lastCacheCreation }
        : undefined
      try { _orchestratorNotify(instanceId, tokens) } catch { /* ignore */ }
    }

    // Best-effort session sanitization
    if (resolvedSessionId && cwd) {
      sanitizeSession(cwd, resolvedSessionId).catch(() => {})
    }

  })

  child.on('error', (err) => {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null }
    console.error(`[claude-process] Spawn error for ${instanceId}:`, err.message)
    processes.delete(instanceId)
    const t = processTimeouts.get(instanceId)
    if (t) {
      clearTimeout(t)
      processTimeouts.delete(instanceId)
    }
    db.prepare('UPDATE instances SET state = ? WHERE id = ?').run('idle', instanceId)
    broadcastEvent({
      type: 'claude:output-batch',
      payload: { instanceId, events: [{ type: 'error', instanceId, message: `Failed to spawn claude: ${err.message}` }] }
    })
    broadcastEvent({ type: 'instance:state', payload: { instanceId, state: 'idle' } })
  })

  // Generate a session ID if we don't have one yet (will be updated by system event)
  if (!resolvedSessionId) {
    resolvedSessionId = crypto.randomUUID()
  }

  return { sessionId: resolvedSessionId }
}

export function killProcess(instanceId: string): void {
  const child = processes.get(instanceId)
  if (!child) return

  const t = processTimeouts.get(instanceId)
  if (t) {
    clearTimeout(t)
    processTimeouts.delete(instanceId)
  }

  try {
    child.kill('SIGTERM')
  } catch {
    // ignore
  }

  // Force kill after 5 seconds
  const forceKillTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // ignore
    }
  }, 5000)

  child.once('exit', () => {
    clearTimeout(forceKillTimer)
  })

  processes.delete(instanceId)
}

export function killAll(): void {
  for (const instanceId of processes.keys()) {
    killProcess(instanceId)
  }
}

export function isRunning(instanceId: string): boolean {
  return processes.has(instanceId)
}

export function getActiveProcessCount(): number {
  return processes.size
}
