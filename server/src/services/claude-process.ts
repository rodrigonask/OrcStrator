import { spawn, type ChildProcess } from 'child_process'
import { createStreamParser } from './stream-parser.js'
import { broadcastEvent } from '../ws/handler.js'
import { db } from '../db.js'
import { sanitizeSession } from './session-sanitizer.js'
import { ALLOWED_FLAG_PREFIXES } from '@nasklaude/shared'
import type { ClaudeStreamEvent, ClaudeProcessExitEvent } from '@nasklaude/shared'
import crypto from 'crypto'

const processes = new Map<string, ChildProcess>()
const processTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

const PROCESS_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const BATCH_INTERVAL_MS = 32

interface SendMessageOpts {
  instanceId: string
  text: string
  images?: string[]
  cwd: string
  sessionId?: string
  resume?: boolean
  flags?: string[]
  agentPrompt?: string
}

function filterFlags(flags: string[]): string[] {
  return flags.filter(flag => {
    const flagName = flag.split('=')[0]
    return ALLOWED_FLAG_PREFIXES.some(prefix => flagName === prefix || flagName.startsWith(prefix + '='))
  })
}

export function sendMessage(opts: SendMessageOpts): { sessionId: string } {
  const { instanceId, text, images, cwd, sessionId, resume, flags = [], agentPrompt } = opts

  // Kill any existing process for this instance
  killProcess(instanceId)

  // Build CLI args
  const args: string[] = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json']

  // Resume existing session or start new one
  if (sessionId) {
    args.push('--resume', sessionId)
  }

  // Filtered user flags
  const safeFlags = filterFlags(flags)
  args.push(...safeFlags)

  // Agent system prompt
  if (agentPrompt) {
    args.push('--append-system-prompt', agentPrompt)
  }

  // Environment — delete CLAUDECODE to prevent nested session issues
  const env = { ...process.env }
  delete env['CLAUDECODE']

  // Spawn the process
  const child = spawn('claude', args, {
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
            if (b.type === 'tool_use') return { type: 'tool-use', toolId: b.id, toolName: b.name, input: JSON.stringify(b.input) }
            return b
          })
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, instance_id, role, content, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(msgId, instanceId, 'assistant', JSON.stringify(content), Date.now())
        }
      } catch {
        // non-JSON line, ignore
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
        }

        enqueueEvent(event)
      }
    }
  })

  // Stderr — treat as error text
  let stderrBuffer = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString()
  })

  // Write user message to stdin as NDJSON, then close
  // stream-json format: { type: "user", message: { role: "user", content: "..." }, session_id, parent_tool_use_id }
  const messageContent: unknown[] = [{ type: 'text', text }]
  if (images && images.length > 0) {
    for (const img of images) {
      messageContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } })
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
    // Clear timeout
    const t = processTimeouts.get(instanceId)
    if (t) {
      clearTimeout(t)
      processTimeouts.delete(instanceId)
    }

    // Flush remaining events
    if (stdoutBuffer.trim()) {
      const parsed = parseLine(stdoutBuffer)
      if (parsed) {
        const events = Array.isArray(parsed) ? parsed : [parsed]
        for (const event of events) enqueueEvent(event)
      }
    }
    flushBatch()
    if (batchTimer) {
      clearTimeout(batchTimer)
      batchTimer = null
    }

    processes.delete(instanceId)

    // Update instance state
    db.prepare('UPDATE instances SET state = ? WHERE id = ?').run('idle', instanceId)

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

    // Best-effort session sanitization
    if (resolvedSessionId && cwd) {
      sanitizeSession(cwd, resolvedSessionId).catch(() => {})
    }
  })

  child.on('error', (err) => {
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
