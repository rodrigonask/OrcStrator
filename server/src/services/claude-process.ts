import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import { createStreamParser } from './stream-parser.js'
import { broadcastEvent, broadcastTerminalLine } from '../ws/handler.js'
import { db } from '../db.js'
import { sanitizeSession } from './session-sanitizer.js'
import type { ClaudeStreamEvent, ClaudeProcessExitEvent } from '@orcstrator/shared'
import crypto from 'crypto'
import { processRegistry } from './process-registry.js'

// Lazily imported to avoid circular dependency at module init time
export interface ProcessExitTokens { inputTokens: number; outputTokens: number; costUsd: number; cacheReadTokens?: number; cacheCreationTokens?: number }
let _orchestratorNotify: ((instanceId: string, tokens?: ProcessExitTokens) => void) | null = null
export function setOrchestratorCallback(fn: (instanceId: string, tokens?: ProcessExitTokens) => void): void {
  _orchestratorNotify = fn
}

const PROCESS_TIMEOUT_MS = 20 * 60 * 1000 // 20 minutes — aligned with LOCK_TIMEOUT_MS
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
  compact?: boolean
}

const ALLOWED_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--system-prompt', '--append-system-prompt',
  '--permission-mode', '--model', '--max-tokens',
  '--verbose', '--output-format', '--input-format',
  '--resume', '--session-id', '--no-cache',
  '--mcp-config', '--strict-mcp-config',
  '--tools', '--allowedTools', '--disallowedTools',
  '--effort', '--max-budget-usd', '--fallback-model',
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

export async function sendMessage(opts: SendMessageOpts): Promise<{ sessionId: string }> {
  const { instanceId, text, images, cwd, sessionId, resume, flags = [], agentPrompt, mcpConfigPath, compact } = opts

  console.log(`[claude-process] sendMessage START instance=${instanceId} cwd=${cwd} resume=${!!sessionId} hasPrompt=${!!agentPrompt} mcpConfig=${mcpConfigPath || 'none'}`)

  // Kill any existing process for this instance (await ensures it's dead before spawning)
  if (processRegistry.isTracked(instanceId)) {
    console.log(`[claude-process] Killing existing process for ${instanceId} before spawning new one`)
    await processRegistry.killProcess(instanceId)
  }

  // Pre-compact session context to reduce input tokens on warm sessions
  if (compact && sessionId) {
    const compactCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude'
    const compactArgs = ['--resume', sessionId, '-p', '/compact', '--output-format', 'stream-json']
    const compactEnv = { ...process.env }
    delete compactEnv['CLAUDECODE']
    console.log(`[claude-process] compact: starting for session ${sessionId.slice(0, 8)}`)
    try {
      const compactChild = spawn(compactCmd, compactArgs, {
        cwd,
        env: compactEnv,
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      await new Promise<void>((resolve, reject) => {
        let stderrOut = ''
        compactChild.stderr?.on('data', (chunk: Buffer) => { stderrOut += chunk.toString() })
        compactChild.once('error', (err) => reject(err))
        compactChild.once('close', (code) => {
          if (stderrOut.trim()) {
            console.warn(`[claude-process] compact stderr: ${stderrOut.trim().slice(0, 200)}`)
          }
          if (code !== 0) {
            console.warn(`[claude-process] compact: exited with code ${code}`)
          }
          resolve()
        })
      })
      console.log(`[claude-process] compact: done for session ${sessionId.slice(0, 8)}`)
    } catch (err) {
      console.warn(`[claude-process] compact: failed (non-fatal), continuing with main spawn:`, err)
    }
  }

  // Pre-resume sanitization: strip leftover base64 image data from the session file
  // so Claude CLI doesn't load invalid [STRIPPED] markers or bloated image payloads
  if (sessionId && cwd) {
    await sanitizeSession(cwd, sessionId)
  }

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

  // System context — always tell Claude it's running inside OrcStrator
  const orcstratorContext = 'You are running inside OrcStrator, a multi-instance Claude orchestration platform. The user is chatting with you through its UI, not a terminal.'
  const fullSystemPrompt = agentPrompt
    ? `${orcstratorContext}\n\n${agentPrompt}`
    : orcstratorContext

  // Strip null bytes and other control chars (except \n, \r, \t)
  const sanitized = fullSystemPrompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  if (sanitized.length > 0) {
    args.push('--append-system-prompt', sanitized)
  }

  // Environment — delete CLAUDECODE to prevent nested session issues
  const env = { ...process.env }
  delete env['CLAUDECODE']
  // Trigger auto-compaction to prevent runaway context growth (CLI default is ~80-95%)
  env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'] = '80'

  // Spawn the process
  const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude'
  console.log(`[claude-process] SPAWNING: ${cmd} ${args.join(' ')}`)
  const child = spawn(cmd, args, {
    cwd,
    env,
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  // Transition: reserved → spawning (version-checked)
  const spawnTransition = db.prepare(
    `UPDATE instances SET process_state = 'spawning', state = 'running', version = version + 1
     WHERE id = ? AND process_state IN ('reserved', 'idle')`
  ).run(instanceId)
  if (spawnTransition.changes === 0) {
    console.warn(`[claude-process] State transition to spawning REJECTED for ${instanceId}`)
  }

  // Wait for 'spawn' event to confirm PID before registering
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => {
      console.log(`[claude-process] SPAWNED: instance=${instanceId} PID=${child.pid}`)
      resolve()
    })
    child.once('error', (err) => {
      console.error(`[claude-process] SPAWN ERROR: instance=${instanceId}:`, err)
      reject(err)
    })
  })

  // Register in ProcessRegistry (only after confirmed spawn)
  processRegistry.registerProcess(instanceId, child)

  // Transition: spawning → running + set PID
  db.prepare(
    `UPDATE instances SET process_state = 'running', state = 'running', process_pid = ?, version = version + 1
     WHERE id = ? AND process_state = 'spawning'`
  ).run(child.pid, instanceId)
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
  let lastResultText: string | undefined
  let sawAssistantText = false

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
    try {
      resetTimeout()
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
            if (raw.message.content.some((b: Record<string, unknown>) => b.type === 'text' && typeof b.text === 'string' && (b.text as string).trim())) {
              sawAssistantText = true
            }
            const createdAt = Date.now()
            db.prepare(`
              INSERT OR IGNORE INTO messages (id, instance_id, role, content, created_at)
              VALUES (?, ?, ?, ?, ?)
            `).run(msgId, instanceId, 'assistant', JSON.stringify(content), createdAt)

            // Broadcast the saved message so the client can display it immediately
            enqueueEvent({
              type: 'assistant-message',
              instanceId,
              message: { id: msgId, instanceId, role: 'assistant', content, createdAt }
            })
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
            try { db.prepare('UPDATE instances SET session_id = ? WHERE id = ?').run(resolvedSessionId, instanceId) } catch { /* non-critical */ }
          }

          if (event.type === 'result') {
            lastCostUsd = event.costUsd
            lastInputTokens = event.inputTokens
            lastOutputTokens = event.outputTokens
            lastCacheCreation = event.cacheCreationTokens
            lastCacheRead = event.cacheReadTokens
            if (event.resultText) lastResultText = event.resultText
            console.log(`[claude-process] Result for ${instanceId}: in=${lastInputTokens} out=${lastOutputTokens} cost=$${lastCostUsd} cache_create=${lastCacheCreation} cache_read=${lastCacheRead}`)

            // Eagerly persist token data NOW — protects against server crash before exit handler runs
            try {
              db.prepare(
                `UPDATE token_usage
                 SET session_id = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?,
                     cache_creation_tokens = ?, cache_read_tokens = ?
                 WHERE instance_id = ? AND created_at = (SELECT MAX(created_at) FROM token_usage WHERE instance_id = ?)`
              ).run(
                resolvedSessionId || null,
                lastInputTokens || 0,
                lastOutputTokens || 0,
                lastCostUsd || 0,
                lastCacheCreation || 0,
                lastCacheRead || 0,
                instanceId,
                instanceId
              )
            } catch { /* non-critical — exit handler will retry */ }
          }

          enqueueEvent(event)
        }
      }
    } catch (err) {
      console.error(`[claude-process] stdout handler error [${instanceId.slice(0, 8)}]:`, err)
    }
  })

  // Stderr — forward line-by-line as raw-line events
  let stderrBuffer = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    try {
      stderrBuffer += chunk.toString()
      const lines = stderrBuffer.split('\n')
      stderrBuffer = lines.pop() || ''
      for (const line of lines) {
        if (line.trim()) {
          console.error(`[claude-process] stderr [${instanceId.slice(0, 8)}]:`, line)
          enqueueEvent({ type: 'raw-line', instanceId, line, isStderr: true })
        }
      }
    } catch (err) {
      console.error(`[claude-process] stderr handler error [${instanceId.slice(0, 8)}]:`, err)
    }
  })

  // Write user message to stdin as NDJSON, then close
  // stream-json format: { type: "user", message: { role: "user", content: "..." }, session_id, parent_tool_use_id }
  const messageContent: unknown[] = []
  // Only include text block if non-empty — API rejects { type: 'text', text: '' }
  if (text) messageContent.push({ type: 'text', text })
  if (images && images.length > 0) {
    for (const img of images) {
      messageContent.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } })
    }
  }
  // Fallback: content must have at least one block
  if (messageContent.length === 0) messageContent.push({ type: 'text', text })
  const inputMessage = {
    type: 'user',
    message: { role: 'user', content: messageContent },
    session_id: resolvedSessionId,
    parent_tool_use_id: null
  }
  const stdinPayload = JSON.stringify(inputMessage)
  console.log(`[claude-process] STDIN → ${instanceId}: ${stdinPayload.length} chars (text: ${text.slice(0, 100)}...)`)
  // Guard against unhandled 'error' on stdin (e.g. process dies before write completes)
  child.stdin?.on('error', (err) => {
    console.warn(`[claude-process] stdin write error [${instanceId.slice(0, 8)}]:`, err.message)
  })
  child.stdin?.write(stdinPayload + '\n')
  child.stdin?.end()

  // Activity-based timeout: resets on every stdout chunk so long-running but active processes aren't killed
  let activityTimeout: ReturnType<typeof setTimeout> | null = null
  function resetTimeout() {
    if (activityTimeout) clearTimeout(activityTimeout)
    activityTimeout = setTimeout(() => {
      console.warn(`[claude-process] Timeout (${PROCESS_TIMEOUT_MS / 60_000}min idle) for instance ${instanceId}, killing process`)
      processRegistry.killProcess(instanceId).catch(err => {
        console.error(`[claude-process] Kill after timeout failed for ${instanceId}:`, err)
      })
    }, PROCESS_TIMEOUT_MS)
    processRegistry.setTimeoutTimer(instanceId, activityTimeout)
  }
  resetTimeout()

  // Idempotent cleanup dedup — prevents double cleanup if killProcess() already ran
  const cleanedUp = new Set<string>()

  // Handle exit — ALWAYS clean up DB state and record tokens, even if killed externally
  child.on('exit', (code) => {
    console.log(`[claude-process] EXIT: instance=${instanceId} PID=${child.pid} code=${code}`)
    if (cleanedUp.has(instanceId)) {
      console.log(`[claude-process] EXIT DEDUP: instance ${instanceId} already cleaned up`)
      return
    }
    cleanedUp.add(instanceId)

    // Flush remaining events (result line often arrives without trailing newline)
    if (stdoutBuffer.trim()) {
      const parsed = parseLine(stdoutBuffer)
      if (parsed) {
        const events = Array.isArray(parsed) ? parsed : [parsed]
        for (const event of events) {
          if (event.type === 'result') {
            lastCostUsd = event.costUsd
            lastInputTokens = event.inputTokens
            lastOutputTokens = event.outputTokens
            lastCacheCreation = event.cacheCreationTokens
            lastCacheRead = event.cacheReadTokens
            if (event.resultText) lastResultText = event.resultText
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

    // Unregister from ProcessRegistry (no-op if already removed by killProcess)
    processRegistry.unregisterProcess(instanceId)

    // Transition to 'exiting' — prevents re-assignment during orchestrator cleanup
    // Orchestrator.onProcessExit will do the final transition to 'idle'
    db.prepare(
      `UPDATE instances SET process_state = 'exiting', process_pid = NULL, version = version + 1
       WHERE id = ? AND process_state = 'running'`
    ).run(instanceId)

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
    if (mcpConfigPath && mcpConfigPath.includes('orcstrator-mcp-')) {
      try { fs.unlinkSync(mcpConfigPath) } catch { /* already gone */ }
    }

    // Save synthetic assistant message when CLI produced no text (e.g. /compact, slash commands)
    if (!sawAssistantText && lastResultText) {
      const syntheticId = crypto.randomUUID()
      const syntheticContent = JSON.stringify([{ type: 'text', text: lastResultText }])
      db.prepare(`
        INSERT OR IGNORE INTO messages (id, instance_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(syntheticId, instanceId, 'assistant', syntheticContent, Date.now())
    }

    // Broadcast exit event (orchestrator will broadcast instance:state idle after cleanup)
    const exitEvent: ClaudeProcessExitEvent = {
      instanceId,
      sessionId: resolvedSessionId || undefined,
      exitCode: code,
      costUsd: lastCostUsd,
      inputTokens: lastInputTokens,
      outputTokens: lastOutputTokens
    }
    broadcastEvent({ type: 'claude:process-exit', payload: exitEvent })

    // Notify orchestrator — event-driven dispatch (with token data for task accumulation)
    const tokens: ProcessExitTokens | undefined = (lastInputTokens || lastOutputTokens)
      ? { inputTokens: lastInputTokens || 0, outputTokens: lastOutputTokens || 0, costUsd: lastCostUsd || 0, cacheReadTokens: lastCacheRead, cacheCreationTokens: lastCacheCreation }
      : undefined
    if (_orchestratorNotify) {
      try { _orchestratorNotify(instanceId, tokens) } catch (err) {
        console.error(`[claude-process] orchestratorNotify error for ${instanceId}:`, err)
        // Safety: if orchestrator fails, still transition to idle
        db.prepare(
          `UPDATE instances SET process_state = 'idle', state = 'idle', assigned_task_ids = NULL, version = version + 1 WHERE id = ?`
        ).run(instanceId)
        broadcastEvent({ type: 'instance:state', payload: { instanceId, state: 'idle' } })
      }
    } else {
      // No orchestrator callback — do the transition ourselves
      db.prepare(
        `UPDATE instances SET process_state = 'idle', state = 'idle', assigned_task_ids = NULL, version = version + 1 WHERE id = ?`
      ).run(instanceId)
      broadcastEvent({ type: 'instance:state', payload: { instanceId, state: 'idle' } })
    }

    // Best-effort session sanitization
    if (resolvedSessionId && cwd) {
      sanitizeSession(cwd, resolvedSessionId).catch(() => {})
    }

  })

  // Generate a session ID if we don't have one yet (will be updated by system event)
  if (!resolvedSessionId) {
    resolvedSessionId = crypto.randomUUID()
  }

  return { sessionId: resolvedSessionId }
}

// Re-export registry methods for backwards compatibility in routes
export { processRegistry } from './process-registry.js'
