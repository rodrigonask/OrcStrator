import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { DATA_DIR, KEEPALIVE_TEXT } from '../config.js'
import { agentEnvFor } from './api-auth.js'
import { createStreamParser } from './stream-parser.js'
import { broadcastEvent, broadcastTerminalLine } from '../ws/handler.js'
import { db } from '../db.js'
import { sanitizeSession, healSessionLocation } from './session-sanitizer.js'
import { canonicalizeCwd } from './canonical-path.js'
import { scheduleWakeup, cancelPendingForInstance, WakeupCapError } from './wakeup-scheduler.js'
import { surfaceInstance, ackSurface } from './surface.js'
import { describeOrigin } from './turn-origins.js'
import type { ClaudeStreamEvent, ClaudeProcessExitEvent, TurnOrigin, MessageContentBlock } from '@orcstrator/shared'
import { computeCostUsd, resolveContextWindow, AUTOCOMPACT_OPTIONS, redactSecrets } from '@orcstrator/shared'
import crypto from 'crypto'
import { processRegistry, agentSlot, AgentLimitError } from './process-registry.js'
import { startTurn, addTurnOutput, endTurn } from './turn-progress.js'
import { markAwaitingInput, clearAwaitingInput, type AwaitingInputKind } from './awaiting-input.js'
import { resolveClaudeBinary, CLAUDE_MISSING_MESSAGE } from './claude-binary.js'
import { promptCache1hEnabled, promptCacheTtl } from './prompt-cache.js'
import { perTurnCost } from './turn-cost.js'
import { isWriteTool, extractFilePath, noteEdit, snapshotPreBash, onBashComplete, onTurnEnd as fileLocksTurnEnd, buildUpdateNote, getInstanceDirtyCount, type Conflict } from './file-locks.js'
import { compactionEnabled, compactionLossless, cliSettingsArgs, readStringSetting, SUBAGENT_OFFLOAD_NUDGE } from './hook-injector.js'
import { trackPermissionRequest, clearPermissionRequests, oldestPendingPermissionAt, resolvePermissionRequest } from './pending-permissions.js'
import { armAskOnce, disarmAskOnce } from './ask-once.js'
import { createStdinCloseTracker, SESSION_STATE_EVENTS_ENV } from './stdin-close.js'
import { buildTurnFlags } from './turn-flags.js'
import { reportPersistFailure } from './persist-errors.js'
import { compactContentForStorage } from './message-media.js'
import { agentBaseEnv } from './agent-env.js'
import { claim, claimOrThrow, claimKind, release, holds, isClaimed, attachChild, killClaimChild, chatKey, isCancelled, StartCancelledError, noteSpawn, spawnOf, claimToken, onRelease } from './turn-gate.js'

// A single stdout line longer than this with no newline is a runaway process, not a message:
// the largest real tool-result line is ~1 MB. Dropped rather than buffered.
const MAX_PARTIAL_LINE_CHARS = Number(process.env.ORCSTRATOR_MAX_LINE_CHARS) || 32 * 1024 * 1024

/**
 * Append a decoded chunk to the pending partial line and split on newlines. Only the new chunk
 * is searched for '\n', so a long line arriving in many chunks is not re-scanned each time.
 * The last element is always the new partial line (possibly empty).
 */
export function splitLines(pending: string, chunk: string): string[] {
  if (chunk.indexOf('\n') === -1) return [pending + chunk]
  const parts = chunk.split('\n')
  parts[0] = pending + parts[0]
  return parts
}

// Re-export so other modules (and the startup probe) share one resolved cache.
export { resolveClaudeBinary } from './claude-binary.js'

/**
 * Returns the absolute path to the native claude binary, throwing a helpful error if
 * nothing was found. Used by every spawn site so we fail loudly with the install hint
 * instead of opaquely with "spawn ENOENT".
 */
function requireClaudeBinary(): string {
  const { path: p, hint } = resolveClaudeBinary()
  if (!p) {
    // The install hint is for the log; the person in the chat gets a plain next step.
    // 424 keeps this message visible (the error handler masks every 5xx).
    console.error(
      `[claude] Could not find the claude CLI. ${hint}\n` +
      `If it is installed in a non-standard location, set ORCSTRATOR_CLAUDE_PATH to its absolute path.`
    )
    throw Object.assign(new Error(CLAUDE_MISSING_MESSAGE), { statusCode: 424 })
  }
  return p
}

export interface ProcessExitTokens { inputTokens: number; outputTokens: number; costUsd: number; cacheReadTokens?: number; cacheCreationTokens?: number }

// Lightweight turn-completion subscription - lets services (e.g. routine-scheduler)
// observe every finished turn with its token/cost data. Listeners run after the
// exit cleanup; errors are isolated.
export type TurnCompleteListener = (instanceId: string, tokens: ProcessExitTokens | undefined, exitCode: number | null) => void
const turnCompleteListeners = new Set<TurnCompleteListener>()
export function onTurnComplete(fn: TurnCompleteListener): () => void {
  turnCompleteListeners.add(fn)
  return () => { turnCompleteListeners.delete(fn) }
}
function notifyTurnComplete(instanceId: string, tokens: ProcessExitTokens | undefined, exitCode: number | null): void {
  for (const fn of turnCompleteListeners) {
    try { fn(instanceId, tokens, exitCode) } catch (err) {
      console.error(`[claude-process] turn-complete listener error for ${instanceId}:`, err)
    }
  }
}

// 20 minutes, aligned with LOCK_TIMEOUT_MS. Env-overridable so a scratch server can prove the
// timeout's behaviour in seconds.
const PROCESS_TIMEOUT_MS = Number(process.env.ORCSTRATOR_PROCESS_TIMEOUT_MS) || 20 * 60 * 1000
// How long an unanswered permission request may keep its silent process alive. A working
// afternoon: long enough to come back to a card, short enough that a forgotten one does not hold
// the dev.lock (and so every server restart) for days.
const PERMISSION_WAIT_CEILING_MS = Number(process.env.ORCSTRATOR_PERMISSION_WAIT_CEILING_MS) || 6 * 60 * 60 * 1000
// Streaming flush cadence. 32ms (~30fps) was overkill - every flush forces React to
// re-render the message list. 120ms (~8fps) is still visually smooth for typing-style
// streaming and cuts client render work by ~4x in long chats. Override via env if needed.
const BATCH_INTERVAL_MS = Number(process.env.ORCSTRATOR_STREAM_FLUSH_MS) || 120
const VERBOSE = !!process.env.ORCSTRATOR_VERBOSE

// Interactive tools OrcStrator surfaces as their own chat cards (AskUserQuestion → ask-user
// card; ExitPlanMode → plan card). Answering the card IS the interaction, so the CLI's
// can_use_tool permission gate for them is pure friction - an Allow/Deny banner sitting in
// front of the very question the user is meant to answer. Auto-allow these server-side and
// never surface a banner; the tool then auto-fails as usual and the hard-stop ends the turn
// with the card on screen. Real tools (Bash/Write/…) still go through the normal banner.
const AUTO_ALLOW_PERMISSION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

// Prompt-cache "still warm" heartbeat.
//
// The client anchors its cache countdown on `lastCacheCreatedAt`, which only advances when a
// turn's `result` event lands, i.e. at turn END. A turn that runs longer than the cache TTL
// therefore counted down against the PREVIOUS turn's timestamp and could read "Expired" while
// the model was reading that exact cache on every step. These events push the anchor forward
// mid-turn from real evidence (a step reporting cache_read_input_tokens > 0).
//
// Throttled per instance: a busy turn emits an assistant step every few seconds and this is a
// once-a-minute freshness ping, not a token feed. Nothing downstream needs every step.
const CACHE_TOUCH_THROTTLE_MS = 60_000
const lastCacheTouchAt = new Map<string, number>()

function noteCacheRead(instanceId: string, cacheReadTokens: number): void {
  if (!(cacheReadTokens > 0)) return
  const now = Date.now()
  const prev = lastCacheTouchAt.get(instanceId) ?? 0
  if (now - prev < CACHE_TOUCH_THROTTLE_MS) return
  lastCacheTouchAt.set(instanceId, now)
  broadcastEvent({ type: 'cache:touch', payload: { instanceId, at: now, cacheReadTokens } })
}

interface SendMessageOpts {
  instanceId: string
  text: string
  images?: Array<{ base64: string; mediaType: string }>
  cwd: string
  sessionId?: string
  resume?: boolean
  flags?: string[]
  agentPrompt?: string
  compact?: boolean
  /**
   * What kind of turn this is. REQUIRED, deliberately: the grid-surfacing decision is
   * made here from this field alone (see the switch in sendMessage and the table in
   * turn-origins.ts), so a new caller that forgets to think about visibility does not
   * compile. Never give this a default.
   */
  origin: TurnOrigin
  /** 'agent-edit' and 'summary' only: 'user' means the UI asked, so it stays quiet. */
  startedBy?: 'user' | 'agent'
  /** origin 'task': the pipeline card this turn was started from. */
  taskId?: string
  /**
   * The chat claim (turn-gate.ts) a caller already holds, e.g. /send, which claims before it
   * stores the message. Without it sendMessage claims the chat itself.
   */
  gateToken?: symbol
  /** origin 'routine': the routine that fired. */
  routineId?: string
}

const ALLOWED_FLAGS = new Set([
  '--dangerously-skip-permissions',
  // Not --system-prompt, --mcp-config or --strict-mcp-config: the first replaces
  // the app's own prompt, the second starts any program as an MCP server. The app adds the
  // system-prompt append itself, after this filter.
  '--append-system-prompt',
  '--permission-mode', '--model', '--max-tokens',
  '--verbose', '--output-format', '--input-format',
  '--resume', '--session-id', '--no-cache',
  '--tools', '--allowedTools', '--disallowedTools',
  '--effort', '--max-budget-usd', '--fallback-model',
])

/** One agent stderr line as it may appear in the server log: capped at 500
 *  characters, with keys and passwords removed. The caller skips stream-json lines first. */
export function stderrLogLine(line: string): string {
  // Redact the whole line first, then cap: capping first could leave half a key behind.
  const clean = redactSecrets(line).redacted
  return clean.length > 500 ? clean.slice(0, 500) + '...' : clean
}

export function filterFlags(flags: string[]): string[] {
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

// --- Auto-retry on transient server errors (normal chat instances only) ----------------
// When a chat turn ends with a *retryable server* error - rate limit / overload, explicitly
// NOT the user's usage limit - re-send "Try Again" as a normal user message after a backoff
// that grows per consecutive failure (10s → 20s → 40s …, capped). The streak resets the
// moment a turn succeeds. This mirrors what the user does by hand, but runs server-side so
// it works even with the browser closed. Setting-gated (autoRetryOnRateLimit, default on).
const RETRY_TRYAGAIN_TEXT = 'Try Again'
const RETRY_BASE_MS = 10_000          // first retry after 10s
const RETRY_MAX_MS = 5 * 60_000       // cap any single backoff at 5 min
const RETRY_MAX_ATTEMPTS = 6          // give up after this many consecutive auto-retries
// Transient throttles + connection drops - safe to retry. The throttle phrasings are what
// Claude Code emits for server-side rate limiting; the errno/connection patterns cover the
// CLI↔API socket being reset (common when many sessions run at once and the API sheds them).
const RETRYABLE_ERROR = /temporarily limiting|not your usage limit|overloaded|server is busy|too many requests|service unavailable|rate[ _-]?limit(?:ed)?|\b429\b|\b503\b|\b529\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|unable to connect/i
// Hard limits - retrying won't help until they reset, so never auto-retry these. (Carefully
// avoids matching the transient "(not your usage limit)" phrasing above.)
const HARD_LIMIT_ERROR = /usage limit reached|reached your usage limit|\d+\s*-?\s*hour limit|out of (?:quota|credits)|insufficient (?:quota|credit)|credit balance (?:is )?too low|spending limit/i

interface RetryState { failures: number; timer: NodeJS.Timeout | null; armedAt?: number }
const retryState = new Map<string, RetryState>()

function clearRetryTimer(instanceId: string): void {
  const s = retryState.get(instanceId)
  if (s?.timer) { clearTimeout(s.timer); s.timer = null }
}
function resetRetry(instanceId: string): void {
  clearRetryTimer(instanceId)
  retryState.delete(instanceId)
}
function autoRetryEnabled(): boolean {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'autoRetryOnRateLimit'").get() as { value: string } | undefined
    return !row || JSON.parse(row.value) !== false // default ON unless explicitly disabled
  } catch { return true }
}

interface AutoRetryOpts { instanceId: string; flags: string[]; agentPrompt?: string; resultText?: string; sawAssistantText: boolean; turnStartedAt?: number }

// Called from the exit handler for every finished turn. Resets the streak on success and on
// non-retryable errors; otherwise schedules a backed-off "Try Again".
function evaluateAutoRetry(opts: AutoRetryOpts): void {
  const { instanceId, resultText, sawAssistantText } = opts
  const text = resultText || ''
  const retryable = !sawAssistantText && RETRYABLE_ERROR.test(text) && !HARD_LIMIT_ERROR.test(text)
  if (!retryable || !autoRetryEnabled()) { resetRetry(instanceId); return }
  // The user stopped this chat while (or after) this turn ran: a "Try Again" nobody asked for must
  // not start it again. A turn that began after the stop (a routine's) retries as usual.
  if (processRegistry.stoppedByUserSince(instanceId, opts.turnStartedAt ?? 0)) { resetRetry(instanceId); return }

  const inst = db.prepare('SELECT id FROM instances WHERE id = ?').get(instanceId) as { id: string } | undefined
  if (!inst) { resetRetry(instanceId); return }

  const prev = retryState.get(instanceId) || { failures: 0, timer: null }
  if (prev.timer) clearTimeout(prev.timer)
  const failures = prev.failures + 1
  if (failures > RETRY_MAX_ATTEMPTS) {
    console.warn(`[auto-retry] ${instanceId.slice(0, 8)} giving up after ${RETRY_MAX_ATTEMPTS} attempts`)
    resetRetry(instanceId)
    broadcastSystemNote(instanceId, `Auto-retry stopped after ${RETRY_MAX_ATTEMPTS} attempts - still failing. Send a message to keep trying.`)
    return
  }
  // ±25% jitter so many instances dropped at once don't all retry in lockstep and re-hammer the API.
  const base = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS)
  const delay = Math.round(base * (0.75 + Math.random() * 0.5))
  console.log(`[auto-retry] ${instanceId.slice(0, 8)} attempt ${failures}/${RETRY_MAX_ATTEMPTS} scheduled in ${Math.round(delay / 1000)}s (transient error)`)
  const timer = setTimeout(() => { void fireAutoRetry(opts, failures) }, delay)
  retryState.set(instanceId, { failures, timer, armedAt: Date.now() })
}

async function fireAutoRetry(opts: AutoRetryOpts, attempt: number): Promise<void> {
  const { instanceId, flags, agentPrompt } = opts
  const s = retryState.get(instanceId); if (s) s.timer = null // timer consumed; keep streak count
  const armedAt = s?.armedAt ?? 0
  const inst = db.prepare('SELECT session_id, cwd, process_state, state FROM instances WHERE id = ?')
    .get(instanceId) as { session_id: string | null; cwd: string; process_state: string; state: string } | undefined
  if (!inst) { resetRetry(instanceId); return }
  // Armed before the user pressed Stop, Pause or Reset: the
  // retry stands down. A message the user sends clears both, and cancels the timer anyway.
  if (processRegistry.stoppedByUserSince(instanceId, armedAt) || inst.state === 'paused') { resetRetry(instanceId); return }
  // A turn is already running (the user resumed manually, or a prior retry is mid-flight) - stand down.
  if (inst.process_state === 'running') return

  // Persist + broadcast the "Try Again" user message so it shows up exactly like a typed one.
  const msgId = crypto.randomUUID()
  const now = Date.now()
  const content = [{ type: 'text', text: RETRY_TRYAGAIN_TEXT }]
  try {
    db.prepare('INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(msgId, instanceId, 'user', JSON.stringify(content), now)
  } catch (err) {
    // Not fatal to the retry itself, but never silent.
    reportPersistFailure('retry-message', err, { instanceId })
  }
  broadcastEvent({ type: 'message:added', payload: { instanceId, message: { id: msgId, instanceId, role: 'user', content, createdAt: now } } })

  try {
    // 'retry' never surfaces: this is a continuation of whatever started the turn, and a
    // second surfaced_at would re-glow a chat that already surfaced (see turn-origins.ts).
    await sendMessage({ instanceId, text: RETRY_TRYAGAIN_TEXT, cwd: inst.cwd, sessionId: inst.session_id || undefined, flags, agentPrompt, origin: 'retry' })
  } catch (err) {
    console.error(`[auto-retry] sendMessage failed for ${instanceId} (attempt ${attempt}):`, err)
  }
}

// --- Per-turn cost persistence -----------------------------------------------------------
// One place that writes turn_costs rows for normal turns AND pre-turn /compact runs.
// cli_total_usd keeps the CLI's raw total_cost_usd, which is a RUNNING total; cost_usd is
// this turn's own share of it (services/turn-cost.ts), 0 when the CLI gave none.
// computed_cost_usd is always derived locally from the pricing table when the model is
// known. Analytics prefer COALESCE(NULLIF(cost_usd, 0), computed_cost_usd, 0) - the
// "effective" cost below.
interface TurnCostRow {
  instanceId: string
  folderId: string
  sessionId: string | null
  messageId?: string | null
  taskId?: string | null
  kind: 'turn' | 'compact'
  inputTokens: number // TOTAL input (uncached + cache creation + cache read)
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number // the CLI's raw running total_cost_usd; 0 when the result event carried none
  durationMs?: number | null
  model?: string | null
}

/**
 * The previous raw CLI total in this SESSION, whichever chat wrote it: the CLI restores a
 * session's total on --resume, so a session reopened in another chat carries it along. Rows
 * the old code wrote have no cli_total_usd and hold the raw figure in cost_usd. A row with no
 * figure at all (a crash reports zeros) is skipped: the total kept running underneath it.
 */
function previousCliTotal(sessionId: string | null): number | null {
  if (!sessionId) return null
  try {
    const prev = db.prepare(
      `SELECT COALESCE(cli_total_usd, cost_usd) AS raw FROM turn_costs
       WHERE session_id = ? AND COALESCE(cli_total_usd, cost_usd) > 0
       ORDER BY id DESC LIMIT 1`
    ).get(sessionId) as { raw: number } | undefined
    return prev?.raw ?? null
  } catch {
    return null
  }
}

function recordTurnCost(row: TurnCostRow): { turnIndex: number; cumCost: number; effectiveCost: number; computedCost: number | null; turnCost: number } {
  const uncachedInput = Math.max(0, row.inputTokens - row.cacheCreationTokens - row.cacheReadTokens)
  // Cache writes are priced at the TTL the promptCache1h setting gives now, the same gate
  // that sets ENABLE_PROMPT_CACHING_1H at spawn. Flipping the setting mid-turn prices that
  // one turn at the new TTL; the spawn keeps the old one until the next turn.
  const computedCost = computeCostUsd(
    { input: uncachedInput, output: row.outputTokens, cacheWrite: row.cacheCreationTokens, cacheRead: row.cacheReadTokens },
    row.model,
    promptCacheTtl()
  )
  const now = Date.now()
  // A turn that ended on an API error reports model '<synthetic>', which has no price, yet it
  // carries real tokens. Price those at the session's last real model, for the restart test
  // only: computed_cost_usd stays NULL for it, as before.
  let chooserComputed = computedCost
  if (chooserComputed == null && row.sessionId && (row.inputTokens > 0 || row.outputTokens > 0)) {
    try {
      const last = db.prepare(
        `SELECT model FROM turn_costs WHERE session_id = ? AND model IS NOT NULL AND model != '<synthetic>'
         ORDER BY id DESC LIMIT 1`
      ).get(row.sessionId) as { model: string } | undefined
      if (last) chooserComputed = computeCostUsd(
        { input: uncachedInput, output: row.outputTokens, cacheWrite: row.cacheCreationTokens, cacheRead: row.cacheReadTokens },
        last.model,
        promptCacheTtl()
      )
    } catch (err) {
      // The restart test runs without it, so the turn still records; but say so.
      reportPersistFailure('turn-cost-context', err, { instanceId: row.instanceId, detail: 'last priced model' })
    }
  }
  const turnCost = perTurnCost({
    cliTotal: row.costUsd,
    prevCliTotal: previousCliTotal(row.sessionId),
    computed: chooserComputed,
    createdAt: now,
    noTokens: row.inputTokens === 0 && row.outputTokens === 0,
  })
  const effectiveCost = turnCost > 0 ? turnCost : (computedCost ?? 0)

  // Previous cumulative values for session running totals
  let prevCumCost = 0, prevCumInput = 0, prevCumOutput = 0, prevTurnIndex = -1
  if (row.sessionId) {
    try {
      const prev = db.prepare(
        'SELECT cumulative_cost, cumulative_input, cumulative_output, turn_index FROM turn_costs WHERE session_id = ? AND instance_id = ? ORDER BY turn_index DESC LIMIT 1'
      ).get(row.sessionId, row.instanceId) as { cumulative_cost: number; cumulative_input: number; cumulative_output: number; turn_index: number } | undefined
      if (prev) {
        prevCumCost = prev.cumulative_cost
        prevCumInput = prev.cumulative_input
        prevCumOutput = prev.cumulative_output
        prevTurnIndex = prev.turn_index
      }
    } catch (err) {
      // The row is still written, but its running totals restart from zero: worth a trace.
      reportPersistFailure('turn-cost-context', err, { instanceId: row.instanceId, detail: 'previous running total' })
    }
  }

  const turnIndex = prevTurnIndex + 1
  const cumCost = prevCumCost + effectiveCost
  const cumInput = prevCumInput + row.inputTokens
  const cumOutput = prevCumOutput + row.outputTokens

  db.prepare(
    `INSERT INTO turn_costs (instance_id, folder_id, session_id, message_id, task_id, turn_index,
       input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, cli_total_usd, computed_cost_usd, kind,
       duration_ms, model, cumulative_input, cumulative_output, cumulative_cost, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.instanceId, row.folderId, row.sessionId, row.messageId ?? null, row.taskId ?? null, turnIndex,
    row.inputTokens, row.outputTokens, row.cacheCreationTokens, row.cacheReadTokens, turnCost, row.costUsd, computedCost, row.kind,
    row.durationMs ?? null, row.model ?? null, cumInput, cumOutput, cumCost, now
  )

  return { turnIndex, cumCost, effectiveCost, computedCost, turnCost }
}

// Parse the stream-json output of a pre-turn /compact run and persist its usage as a
// turn_costs row (kind='compact'). Compact runs previously discarded all token data.
function recordCompactUsage(instanceId: string, folderId: string, sessionId: string, stdout: string): void {
  try {
    let resultLine: string | null = null
    for (const line of stdout.split('\n')) {
      if (line.includes('"type":"result"') || line.includes('"type": "result"')) resultLine = line
    }
    if (!resultLine) return
    const parsed = JSON.parse(resultLine.trim()) as Record<string, unknown>
    const usage = (parsed.usage ?? {}) as Record<string, unknown>
    const uncached = Number(usage.input_tokens) || 0
    const cacheCreation = Number(usage.cache_creation_input_tokens) || 0
    const cacheRead = Number(usage.cache_read_input_tokens) || 0
    const output = Number(usage.output_tokens) || 0
    const totalInput = uncached + cacheCreation + cacheRead
    if (totalInput === 0 && output === 0) return
    const { effectiveCost } = recordTurnCost({
      instanceId,
      folderId,
      sessionId,
      kind: 'compact',
      inputTokens: totalInput,
      outputTokens: output,
      cacheCreationTokens: cacheCreation,
      cacheReadTokens: cacheRead,
      costUsd: Number(parsed.total_cost_usd) || 0,
      durationMs: Number(parsed.duration_ms) || null,
      model: typeof parsed.model === 'string' ? parsed.model : null,
    })
    console.log(`[claude-process] compact: recorded usage in=${totalInput} out=${output} cost=$${effectiveCost.toFixed(4)}`)
  } catch (err) {
    console.warn(`[claude-process] compact: failed to record usage:`, err)
  }
}

/** Conflict detected: pause this run (kill, resumable), mark the chat, tell the client. */
async function pauseOnConflict(instanceId: string, conflict: Conflict): Promise<void> {
  console.warn(`[file-locks] CONFLICT: instance ${instanceId.slice(0, 8)} touched ${conflict.path} held by "${conflict.holderName}" - pausing run`)
  try { await processRegistry.killProcess(instanceId) } catch { /* already dead */ }
  broadcastSystemNote(
    instanceId,
    `⏸ Paused: conflict detected on ${conflict.path}. Instance "${conflict.holderName}" has uncommitted changes to that file. Commit or PR that work before proceeding, or use "Ignore restrictions for 30 minutes" if you know what you're doing.`
  )
  broadcastEvent({
    type: 'conflict:paused',
    payload: { instanceId, path: conflict.path, holderInstanceId: conflict.holderInstanceId, holderName: conflict.holderName },
  })
}

export function broadcastSystemNote(instanceId: string, text: string): void {
  const message = { id: crypto.randomUUID(), instanceId, role: 'system' as const, content: [{ type: 'text', text }], createdAt: Date.now() }
  try {
    db.prepare('INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(message.id, instanceId, 'system', JSON.stringify(message.content), message.createdAt)
  } catch (err) {
    // The note is still broadcast below, so it shows now; it just will not survive a reload.
    reportPersistFailure('system-note', err, { instanceId })
  }
  broadcastEvent({ type: 'message:added', payload: { instanceId, message } })
}

// A /compact that has not finished by now is hung: it is killed and reported, instead of
// holding the chat as "compacting" for ever. Env-overridable for tests.
const COMPACT_TIMEOUT_MS = Number(process.env.ORCSTRATOR_COMPACT_TIMEOUT_MS) || 10 * 60 * 1000

/**
 * Run `claude --resume <sid> -p /compact` to completion under the chat's claim: the child is
 * attached to the claim (so Stop and shutdown can reach it) and killed if it runs
 * past COMPACT_TIMEOUT_MS. Resolves with its stdout, or 'timeout'.
 */
async function runCompactChild(opts: { instanceId: string; sessionId: string; cwd: string; token: symbol; label: string }): Promise<{ stdout: string; timedOut: boolean; code: number | null }> {
  const cmd = requireClaudeBinary()
  // --verbose IS REQUIRED: `--print` with `--output-format=stream-json` is rejected by the CLI
  // without it ("requires --verbose"), stdout stays empty, and the compact silently did nothing.
  const args = ['--resume', opts.sessionId, '-p', '/compact', '--output-format', 'stream-json', '--verbose']
  const env = agentBaseEnv()
  Object.assign(env, agentEnvFor(opts.instanceId))
  const child = spawn(cmd, args, { cwd: opts.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  attachChild(chatKey(opts.instanceId), opts.token, child)
  let out = ''
  let timedOut = false
  const code = await new Promise<number | null>((resolve, reject) => {
    let stderrOut = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => { out += c })
    child.stderr?.on('data', (c: string) => { if (stderrOut.length < 64 * 1024) stderrOut += c })
    const timer = setTimeout(() => {
      timedOut = true
      console.warn(`[claude-process] ${opts.label}: still running after ${Math.round(COMPACT_TIMEOUT_MS / 1000)}s, killing it`)
      void killClaimChild(chatKey(opts.instanceId))
    }, COMPACT_TIMEOUT_MS)
    timer.unref?.()
    let done = false
    const finish = (c: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (stderrOut.trim()) console.warn(`[claude-process] ${opts.label} stderr: ${stderrLogLine(stderrOut.trim())}`)
      resolve(c)
    }
    child.once('error', (err) => { if (done) return; done = true; clearTimeout(timer); reject(err) })
    child.once('close', finish)
    // 'close' waits for every holder of the pipes; a program the compact left running could
    // hold stdout open for ever and keep the chat claimed. The process's own exit, plus a
    // short grace for its last output, is enough.
    child.once('exit', (c) => { setTimeout(() => finish(c), 2000).unref?.() })
  })
  return { stdout: out, timedOut, code }
}

/**
 * Compact an idle session's context on demand (the standalone twin of the pre-turn
 * `compact` path in sendMessage). Runs `claude --resume <sid> -p /compact`, persists the
 * run's token cost (kind='compact'), zeroes the context gauge, and tells the client.
 *
 * Offer-only lever for the cold-start / quota features: shrinking the context means the
 * NEXT turn (warm or cold) re-reads a smaller prompt. Never auto-runs on a live turn.
 */
export async function compactInstance(instanceId: string): Promise<{ ok: boolean; error?: string }> {
  const inst = db.prepare('SELECT cwd, session_id, folder_id FROM instances WHERE id = ?')
    .get(instanceId) as { cwd: string; session_id: string | null; folder_id: string } | undefined
  if (!inst) return { ok: false, error: 'not-found' }
  if (!inst.session_id) return { ok: false, error: 'no-session' }
  // The compact claims the chat in the SAME in-flight set every turn start uses, so
  // a message sent while it runs is refused (409) instead of starting a second agent on the
  // same conversation, and a compact cannot start while a turn is starting or running.
  if (processRegistry.isTracked(instanceId) || processRegistry.isAdopted(instanceId)) return { ok: false, error: 'busy' }
  const token = claim(chatKey(instanceId), 'compact')
  if (!token) return { ok: false, error: claimKind(chatKey(instanceId)) === 'compact' ? 'already-compacting' : 'busy' }

  try {
    let out: string
    try {
      const r = await runCompactChild({ instanceId, sessionId: inst.session_id, cwd: inst.cwd, token, label: 'compact(manual)' })
      if (r.timedOut) return { ok: false, error: 'timeout' }
      out = r.stdout
    } catch (err) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) }
    }
    // THE RESULT LINE IS THE PROOF IT RAN. Without this test the function reported success
    // whatever happened: the --verbose bug above meant the CLI rejected the invocation
    // before doing anything, stdout came back empty, and this still zeroed the context gauge
    // and told the chat its context had been compacted. A gauge reading zero against a
    // context that was never touched is worse than no gauge, because the next decision about
    // whether to compact is made from it.
    const ran = out.includes('"type":"result"') || out.includes('"type": "result"')
    if (!ran) {
      console.warn(`[claude-process] compact(manual) produced no result for ${instanceId}: the context was NOT compacted`)
      return { ok: false, error: 'no-result' }
    }
    recordCompactUsage(instanceId, inst.folder_id, inst.session_id, out)
    try { db.prepare('UPDATE instances SET ctx_tokens = 0 WHERE id = ?').run(instanceId) } catch { /* non-critical */ }
    broadcastEvent({ type: 'instance:updated', payload: { id: instanceId, ctxTokens: 0 } })
    broadcastSystemNote(instanceId, '🗜 Context compacted. The next turn re-reads a smaller context, so the cold start is cheaper.')
    return { ok: true }
  } catch (err) {
    console.warn(`[claude-process] compact(manual) failed for ${instanceId}:`, err)
    return { ok: false, error: String(err).slice(0, 120) }
  } finally {
    release(chatKey(instanceId), token)
    // A /btw sent while the compact ran was queued; a compact has no turn exit to flush it.
    scheduleBtwFlush(instanceId, inst.cwd, inst.session_id ?? undefined, buildTurnFlags({}))
  }
}

/**
 * Start a turn on a chat. Claims the chat in the in-flight set (turn-gate.ts) synchronously,
 * before the first await, and holds the claim until the new process is registered or the
 * start fails. A second start on the same chat inside that window throws a
 * BusyError (statusCode 409). A caller that already claimed the chat passes its token.
 */
// A routine fire is the user's schedule, but not the user coming back: after a Stop it may run
// (a paused chat is held back in the scheduler), and it leaves queued notes and retries held.
const AUTONOMOUS_ORIGINS = new Set<string>(['btw', 'wakeup', 'keepalive', 'retry', 'routine'])

// A user's stop: no pending wake-up and no armed retry may start the chat again on its own.
processRegistry.onUserStop(id => {
  resetRetry(id)
  cancelPendingForInstance(id)
})

export async function sendMessage(opts: SendMessageOpts): Promise<{ sessionId: string }> {
  const key = chatKey(opts.instanceId)
  const token = holds(key, opts.gateToken) ? opts.gateToken! : claimOrThrow(key, 'turn')
  // Any start other than a /btw flush is the user (or something on their behalf) moving on
  // from a Stop, so queued notes may ride again after this turn.
  // (Not a start a Stop already cancelled: a card Start claims the chat early, and a Stop in
  // between must keep its queued notes waiting.)
  // Only a start the user made (or asked for): a wake-up, a keep-warm ping or a retry is not
  // the user moving on, and must not re-enable the rest.
  if (!AUTONOMOUS_ORIGINS.has(opts.origin) && !isCancelled(key, token)) processRegistry.clearUserStop(opts.instanceId)
  try {
    return await spawnTurn(opts, token)
  } catch (err) {
    // A start that failed before a process was registered must not leave the chat reading
    // "starting" (or, after it replaced a killed turn, "running") for ever. Nothing is alive on
    // the chat at this point unless the registry or an adoption says so.
    if (!processRegistry.isTracked(opts.instanceId) && !processRegistry.isAdopted(opts.instanceId)) {
      try {
        db.prepare("UPDATE instances SET process_state = 'idle', state = 'idle', process_pid = NULL, version = version + 1 WHERE id = ? AND process_state IN ('spawning', 'running')").run(opts.instanceId)
      } catch { /* non-critical */ }
    }
    // /btw notes queued while this start was being set up would otherwise wait for a turn
    // exit that never comes. (Not for a btw flush itself: that puts its notes back instead.)
    if (opts.origin !== 'btw' && !(err instanceof StartCancelledError)) scheduleBtwFlush(opts.instanceId, opts.cwd, opts.sessionId, opts.flags ?? [])
    throw err
  } finally {
    release(key, token)
  }
}

// A replaced turn's end-of-turn work, waiting on the claim of the start that replaced it (see
// the exit handler). Keyed by chat, stamped with that claim's token.
const deferredFinish = new Map<string, { token: symbol; fn: () => void }>()

function deferFinish(instanceId: string, fn: () => void): void {
  const token = claimToken(chatKey(instanceId))
  if (token) deferredFinish.set(instanceId, { token, fn })
}

// Whoever releases that claim (sendMessage, the /send route after a refusal, a card Start), the
// replaced turn is settled then: dropped if the start spawned its own turn (whose exit finishes
// the chat), finished now if it did not. Never later, over some other turn.
onRelease((key, token) => {
  if (!key.startsWith('chat:')) return
  const instanceId = key.slice(5)
  const entry = deferredFinish.get(instanceId)
  if (!entry || entry.token !== token) return
  deferredFinish.delete(instanceId)
  if (spawnOf(token) || processRegistry.isTracked(instanceId) || isClaimed(key)) return
  try { entry.fn() } catch (err) { console.error(`[claude-process] finishing the replaced turn on ${instanceId} failed:`, err) }
})

async function spawnTurn(opts: SendMessageOpts, gateToken: symbol): Promise<{ sessionId: string }> {
  const { instanceId, text, images, sessionId, resume, flags = [], agentPrompt, compact, origin } = opts
  // Spawn with the real on-disk casing. Claude Code bakes the spawn cwd into the session's
  // worktree binding at EnterWorktree time, and a mis-cased cwd makes every later --resume
  // abort ("cannot resume into worktree ... a core.worktree redirect") with exit 1 and no
  // result event - a chat that silently stops replying. See canonical-path.ts.
  const cwd = canonicalizeCwd(opts.cwd)

  // origin is logged because the whole class of bug this guards against is invisible by
  // definition: a turn that ran and showed nothing. Now every turn says what it was.
  console.log(`[claude-process] sendMessage START instance=${instanceId} origin=${describeOrigin(origin)} cwd=${cwd} resume=${!!sessionId} hasPrompt=${!!agentPrompt}`)

  // No usable Claude (a 424): refused before anything below changes state, like the agent
  // limit, so the chat is left exactly as it was (no "fresh session" note, wake-ups kept).
  requireClaudeBinary()

  // The agent limit, when the user has switched it on. Checked before anything
  // below changes state, so a refused start leaves the chat exactly as it was.
  const slot = agentSlot(instanceId)
  if (!slot.ok) throw new AgentLimitError(slot.inUse, slot.max)

  // Cancel any pending auto-scheduled wake-ups for this instance - fresh activity
  // implicitly supersedes them. Wake-ups that are mid-fire are already marked 'fired'
  // in the DB before they call sendMessage, so this only clears truly pending ones.
  cancelPendingForInstance(instanceId)

  // A fresh send supersedes any pending auto-retry timer (e.g. the user sent manually while
  // a "Try Again" was queued) - drop the timer but keep the failure streak, so backoff keeps
  // escalating if this send also gets rate limited. The streak is reset on a successful turn.
  clearRetryTimer(instanceId)

  // Kill any existing process for this instance (await ensures it's dead before spawning).
  // An adopted one (started by the previous server run) counts too. If it will not die, this
  // start is abandoned: spawning next to a live agent is exactly the double run this prevents.
  if (processRegistry.isTracked(instanceId) || processRegistry.isAdopted(instanceId)) {
    console.log(`[claude-process] Killing existing process for ${instanceId} before spawning new one`)
    const killed = await processRegistry.killProcess(instanceId)
    if (!killed) {
      throw Object.assign(new Error('This chat is still working and could not be stopped, so your message was not sent. Try again, or use Force reset in its ☰ menu.'), { statusCode: 409 })
    }
  }

  // Look up folder_id once for turn_costs denormalization (used by compact + turn rows)
  const folderRow = db.prepare('SELECT folder_id FROM instances WHERE id = ?').get(instanceId) as { folder_id: string } | undefined
  const folderId = folderRow?.folder_id || ''

  // Pre-compact session context to reduce input tokens on warm sessions
  if (compact && sessionId) {
    console.log(`[claude-process] compact: starting for session ${sessionId.slice(0, 8)}`)
    try {
      // Under this turn's own claim, with the same timeout as a standalone compact.
      const r = await runCompactChild({ instanceId, sessionId, cwd, token: gateToken, label: 'compact' })
      if (r.code !== 0) console.warn(`[claude-process] compact: exited with code ${r.code}${r.timedOut ? ' (timed out)' : ''}`)
      // Compact runs burn real tokens - parse the result event and persist a
      // turn_costs row (kind='compact') so they stop disappearing from analytics.
      recordCompactUsage(instanceId, folderId, sessionId, r.stdout)
      console.log(`[claude-process] compact: done for session ${sessionId.slice(0, 8)}`)
    } catch (err) {
      console.warn(`[claude-process] compact: failed (non-fatal), continuing with main spawn:`, err)
    }
  }

  // Self-heal an orphaned session BEFORE deciding to resume. A session created inside a git
  // worktree is stored under the worktree's path-slug; once the worktree is removed and the
  // instance's cwd reverts to the main checkout, `--resume <id>` looks under the main slug,
  // fails to find it, and the CLI exits code 1 ("No conversation found") - a permanently
  // dead tab. Relocate the file if we can find it; if it's gone everywhere, start fresh
  // rather than resume into a void.
  let resumeSessionId = sessionId
  if (sessionId && cwd) {
    try {
      const heal = await healSessionLocation(cwd, sessionId)
      if (heal === 'relocated') {
        console.log(`[claude-process] Relocated orphaned session ${sessionId.slice(0, 8)} into the cwd slug for ${instanceId.slice(0, 8)} (worktree cleanup left it stranded)`)
      } else if (heal === 'absent') {
        console.warn(`[claude-process] Session ${sessionId.slice(0, 8)} for ${instanceId.slice(0, 8)} exists nowhere on disk - starting a FRESH session instead of dying on resume`)
        broadcastSystemNote(instanceId, '↻ The previous Claude session file was gone (usually a removed worktree), so this reply starts a fresh session. Your earlier messages above are preserved, but the model no longer has that prior context - recap anything important.')
        resumeSessionId = undefined
      }
    } catch (err) {
      console.warn(`[claude-process] healSessionLocation failed for ${instanceId.slice(0, 8)} (continuing):`, err)
    }
  }

  // Pre-resume sanitization: strip leftover base64 image data from the session file
  // so Claude CLI doesn't load invalid [STRIPPED] markers or bloated image payloads
  if (resumeSessionId && cwd) {
    await sanitizeSession(cwd, resumeSessionId)
  }

  // Build CLI args
  const args: string[] = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']

  // Resume existing session or start new one
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId)
  }

  // Filtered user flags
  const safeFlags = filterFlags(flags)
  args.push(...safeFlags)

  // Managed --settings file: the context-compaction PostToolUse hook (setting-gated, default ON /
  // opt-out) plus the Claude CLI settings OrcStrator exposes in its own Settings page (output
  // style, response language). Layered as a command-line settings source, so it MERGES with the
  // user's own ~/.claude and project settings rather than replacing them. One file, not two:
  // --settings is not repeatable, and a second one would silently drop the first.
  args.push(...cliSettingsArgs(instanceId))
  // Note which one-time ask rules that file just carried, so they are gone when this process is.
  armAskOnce(instanceId)

  // Auto-compact window (`--autocompact auto|100k-1M`). Only sent when the user picked one;
  // unset leaves OrcStrator's own CLAUDE_AUTOCOMPACT_PCT_OVERRIDE below in charge. Checked
  // against the known list because the CLI rejects anything else outright, and a bad value
  // would kill the turn on spawn rather than degrade.
  const autocompact = readStringSetting('autocompact')
  if (autocompact && AUTOCOMPACT_OPTIONS.some(o => o.value === autocompact)) {
    args.push('--autocompact', autocompact)
  }

  // System context - always tell Claude it's running inside OrcStrator.
  // AskUserQuestion + ExitPlanMode are both surfaced as interactive cards in the chat UI;
  // we intercept their tool_use blocks in the stream parser and reply via stdin once the
  // user answers/approves.
  const contextParts = [
    'You are running inside OrcStrator, a multi-instance Claude orchestration platform. The user is chatting with you through its UI, not a terminal.',
    'When you need user input, use the AskUserQuestion tool for structured choices or just ask in plain text. The user is in a chat UI, not a terminal.',
    'CRITICAL: AskUserQuestion and ExitPlanMode behave specially in this environment. They return an immediate ERROR result (for example "Answer questions?") instead of the answer. That error is EXPECTED and does NOT mean the tool failed. Treat calling AskUserQuestion (or ExitPlanMode) as the END of your turn: after the tool call, STOP immediately. Output no further text, do NOT answer your own question, and do NOT proceed with the plan. The user answers asynchronously through the UI and you will be resumed with their answer as a new message. Continuing past the question (for example giving your own recommendation anyway) defeats the feature and is a bug from the user perspective.',
    'CRITICAL - follow-up promises: If you tell the user you will "report back", "follow up", "let you know when done", or similar, you MUST use ScheduleWakeup BEFORE ending your turn to make that happen. Claude cannot initiate contact after a turn ends - only a scheduled wakeup can. Never make a follow-up promise without immediately scheduling it. If you have nothing time-sensitive to schedule, use PushNotification instead to fire a one-shot alert the moment background work completes.',
    // Native task-list steer. The chat renders ~/.claude/tasks/<session-id>/*.json live
    // (NativeTaskPanel), but NOTHING populates it unless the model calls TaskCreate, and in
    // OrcStrator sessions the task tools are usually DEFERRED behind ToolSearch (lots of MCP
    // schemas), so they were reached for almost never, and /goal never touches them at all. Static text, so it stays byte-identical per session
    // and costs one prefix rewrite when it first ships, not one per turn.
    'Task list: OrcStrator renders Claude Code\'s native task list as a live panel in the chat, so it is the user\'s main view of your progress. Keep it current for any multi-step work: call TaskCreate up front for each distinct step, mark exactly one task in_progress before you start it, and TaskUpdate it to completed as soon as it is done. ALWAYS maintain one while a /goal is active, since goal runs span many turns and the panel is how the user follows them. These tools may be deferred in this session: if TaskCreate/TaskUpdate are not already loaded, run ToolSearch with "select:TaskCreate,TaskUpdate,TaskList" first. Skip the list only for genuinely single-step or conversational requests.',
    'CRITICAL - process lifecycle & background work: OrcStrator runs ONE Claude Code process per turn. When your turn ends, that process exits and everything it hosts dies with it: background Bash commands (run_in_background), background Agent tasks, and Workflows do NOT survive into the next turn, and no completion record is left behind. A ScheduleWakeup resumes the CONVERSATION later in a fresh process - it does not keep anything alive in between, so "start background task, schedule wakeup, end turn, collect on wake" silently loses the work. Rules: (1) Backgrounding is fine WITHIN a turn - start tasks, keep working, collect results - but never end your turn while background work you still need is running; wait for it to finish first. (2) Work that must outlive the turn must not live in your process: push it to a server-side/external system (cloud pipeline, CI, deployed job) you can poll next turn, or launch a fully detached OS process that writes progress/results to a file you re-read later (detached processes survive turn end but die when the OrcStrator app closes). Make such kickoffs idempotent/resumable so a later turn can adopt or safely re-run them. (3) If long local work cannot finish within the current turn, say so and split it across turns instead of backgrounding it and hoping.',
  ]
  // Subagent context-offloading steer (same gate as the compaction hook): push bulky
  // exploration into subagents so heavy context never lands in the lead instance's window.
  if (compactionEnabled()) contextParts.push(SUBAGENT_OFFLOAD_NUDGE)
  // Sibling awareness - what other instances did to this repo since our last turn.
  // CACHE-CRITICAL: this note is per-turn dynamic text, so it must ride in the USER
  // message (end of the prompt prefix), never in --append-system-prompt. Injected into
  // the system prompt it changed the prefix near the top and busted the entire prompt
  // cache on every turn where the repo had activity: it rewrote the full cached prefix
  // on every warm turn, which is expensive. The system prompt
  // below must stay byte-identical across every turn of a session.
  let updateNote: string | null = null
  try {
    const lastTurn = db.prepare('SELECT MAX(created_at) ts FROM turn_costs WHERE instance_id = ?').get(instanceId) as { ts: number | null } | undefined
    updateNote = await buildUpdateNote(instanceId, cwd, lastTurn?.ts ?? null)
    if (updateNote) {
      // Breadcrumb for cache-bust attribution (read by the baseline analysis scripts).
      fs.appendFileSync(
        path.join(DATA_DIR, 'update-note-log.jsonl'),
        JSON.stringify({ ts: Date.now(), instanceId, chars: updateNote.length }) + '\n'
      )
    }
  } catch { /* non-critical */ }
  const orcstratorContext = contextParts.join('\n\n')
  const fullSystemPrompt = agentPrompt
    ? `${orcstratorContext}\n\n${agentPrompt}`
    : orcstratorContext

  // Strip null bytes and other control chars (except \n, \r, \t)
  const sanitized = fullSystemPrompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  if (sanitized.length > 0) {
    args.push('--append-system-prompt', sanitized)
  }

  // Environment: the server's own, minus what must not leak into an agent
  // (CLAUDECODE and a Claude Code session's identity, npm's variables, the server's settings).
  const env = agentBaseEnv()
  // Stable per-instance identity for the process and its hooks. Session ids rotate on
  // every --resume, so hooks that need to know WHICH chat instance they run under
  // (e.g. a user-level hook that checks which chat owns a file) key off this instead.
  Object.assign(env, agentEnvFor(instanceId))
  // Trigger auto-compaction to prevent runaway context growth (CLI default is ~80-95%)
  env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'] = '80'
  // Native task list. Claude Code 2.1.233 stopped registering the task tools
  // (TaskCreate/Get/Update/List, TodoWrite) for the newer models: the CLI keeps a
  // hardcoded allowlist that ends at the 4-family, so an Opus 5 tab has no tool that
  // can write ~/.claude/tasks/<session-id>/*.json and NativeTaskPanel renders empty
  // forever. This is the CLI's own documented opt-in and it restores them verbatim.
  env['CLAUDE_CODE_ENABLE_TODO_TOOLS'] = '1'
  // Session state events ('running' / 'requires_action' / 'idle') on stdout: the signal that the
  // CLI's input queue is drained and stdin may end. Without it the first `result` was taken as the
  // end of the turn, which cut off permission answers to the turn after it (stdin-close.ts).
  env[SESSION_STATE_EVENTS_ENV] = '1'
  // 1-hour prompt cache (setting-gated). Extends cache TTL from the default 5m to 1h so
  // long-lived chat sessions stop paying to recreate the cache between turns.
  if (promptCache1hEnabled()) env['ENABLE_PROMPT_CACHING_1H'] = '1'

  // Context-compaction mode for the PostToolUse hook (it inherits this env). Lossless (the default)
  // skips the lossy head/tail elision; only an explicit opt-out turns elision on. See hook-injector.ts.
  if (compactionEnabled()) env['ORCSTRATOR_COMPACTION_LOSSLESS'] = compactionLossless() ? '1' : '0'

  // Spawn the process - use the resolved absolute path to the native claude binary.
  // Dropping `shell: true` (was only needed for the legacy npm claude.cmd shim);
  // the native .exe spawns directly, which avoids cmd.exe quoting bugs and orphan shells.
  // (File-lock attribution is now per-edit and per-Bash-call - see snapshotPreBash /
  // onBashComplete below - so there's no whole-turn dirty snapshot to take here.)

  // Resolved BEFORE the surface below: a missing binary is a failure, and a failure must
  // never leave a bright "waiting on you" behind on a chat where nothing ran.
  const cmd = requireClaudeBinary()

  // Stop was pressed while this start was being set up (the awaits above): nothing spawns.
  if (isCancelled(chatKey(instanceId), gateToken)) {
    console.log(`[claude-process] start on ${instanceId.slice(0, 8)} cancelled by Stop before it spawned`)
    throw new StartCancelledError()
  }

  // -- SURFACE ----------------------------------------------------------------
  // The single place that decides whether a chat pulls itself into the grid. Every Claude
  // CHAT TURN starts here (the CLI proxy and the skill pass-through in command-registry
  // spawn their own process, but neither is a turn in a chat), so putting the decision
  // anywhere else means the next autonomous path ships invisible, which is exactly how the
  // task-runner gap was found: a routine started a card and its chat ran off-screen.
  //
  // Placed at the last moment before the spawn: past every early return and every throw
  // above, so a send that never becomes a turn never claims "waiting on you". The surface
  // this call writes is remembered so the spawn-failure path below can take back EXACTLY
  // that one, never an older pending surface belonging to some earlier fire. Silence is
  // read off the instance inside surfaceInstance. Per-origin rationale, and the table of
  // every turn-spawning path, live in turn-origins.ts.
  let surfacedAt: number | null = null
  switch (origin) {
    case 'routine':
      surfacedAt = surfaceInstance(instanceId, 'routine', { routineId: opts.routineId })?.surfacedAt ?? null
      break
    case 'wakeup':
      surfacedAt = surfaceInstance(instanceId, 'wakeup')?.surfacedAt ?? null
      break
    case 'task':
      surfacedAt = surfaceInstance(instanceId, 'task')?.surfacedAt ?? null
      break
    case 'agent-edit':
    case 'summary':
      // Started from the UI: the user is looking at the chat they just opened. Started over
      // HTTP by an agent: same class of invisible start as a task, so it surfaces.
      if (opts.startedBy !== 'user') surfacedAt = surfaceInstance(instanceId, 'task')?.surfacedAt ?? null
      break
    case 'user':
    case 'retry':
    case 'keepalive':
    case 'btw':
    case 'command':
      // The user's own turn, or a continuation of one already accounted for. A retry must not
      // write a NEW surfaced_at: that would re-glow a chat that already surfaced.
      break
    default: {
      // The teeth. Add a member to TurnOrigin and this line stops compiling until the new
      // origin has a case above, so the visibility question cannot be dodged by adding a
      // KIND of turn rather than a caller. Without it a new origin falls straight through
      // to silence, which is the exact defect class this change exists to remove.
      const unhandled: never = origin
      throw new Error(`sendMessage: unhandled TurnOrigin ${String(unhandled)}`)
    }
  }

  console.log(`[claude-process] SPAWNING: ${cmd} ${args.join(' ')}`)
  // spawn() can fail two different ways and BOTH have to give the surface back, or a chat
  // where nothing ran keeps a bright "waiting on you" for ever. It throws SYNCHRONOUSLY for
  // a cwd or an image Windows cannot execute (measured: `spawn UNKNOWN` against a non-PE
  // file), and it fails ASYNCHRONOUSLY via the 'error' event below for ENOENT. The first
  // shape is the one that slipped through when only the await was guarded.
  let child: ChildProcess
  // When this turn began: a user's stop after it holds back its automatic retry.
  const turnStartedAt = Date.now()
  try {
    child = spawn(cmd, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (err) {
    if (surfacedAt != null) ackSurface(instanceId, surfacedAt)
    throw err
  }

  // Transition: reserved → spawning (version-checked)
  // Unconditional: this start holds the chat's claim (turn-gate.ts) and any previous process
  // was confirmed dead above, so it owns the row. The old version check only logged
  // "REJECTED" and carried on, and then the running transition below matched nothing, which
  // left the row on the dead process's PID.
  db.prepare(
    `UPDATE instances SET process_state = 'spawning', state = 'running', version = version + 1 WHERE id = ?`
  ).run(instanceId)

  // Wait for 'spawn' event to confirm PID before registering. A rejection here means no
  // process exists (a bad cwd, a removed worktree, ENOENT), so nothing is "waiting on you":
  // take back the surface THIS call wrote, by its exact timestamp, so a fire that landed in
  // the meantime survives. Done here rather than in each caller's catch because the surface
  // is written here, and three of the five surfacing callers have no catch that could do it
  // (task-runner rethrows, agents.ts has none, sessions.ts returns a 500).
  try {
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
  } catch (err) {
    if (surfacedAt != null) ackSurface(instanceId, surfacedAt)
    throw err
  }

  // Register in ProcessRegistry (only after confirmed spawn)
  processRegistry.registerProcess(instanceId, child)
  noteSpawn(gateToken, child)
  deferredFinish.delete(instanceId) // this new turn's own exit finishes the chat from now on

  // Transition: spawning → running + set PID, and WHEN it started: after a restart
  // the PID alone cannot tell this agent apart from a program later given the same number.
  db.prepare(
    `UPDATE instances SET process_state = 'running', state = 'running', process_pid = ?, process_started_at = ?, version = version + 1
     WHERE id = ?`
  ).run(child.pid, Date.now(), instanceId)
  broadcastEvent({ type: 'instance:state', payload: { instanceId, state: 'running' } })

  // A turn is running again, so nothing is waiting on the user any more. Cleared HERE, at
  // the one choke point every resumed turn passes through, rather than in each answer route:
  // answering a question, approving a plan and rejecting a plan all resume through /send, and
  // a route-by-route clear would eventually miss one and strand an instance amber forever.
  clearAwaitingInput(instanceId)

  // Begin live turn tracking (elapsed timer + running output-token counter for the
  // composer footer). Broadcast the start so clients can show the timer immediately.
  const turn = startTurn(instanceId)
  broadcastEvent({ type: 'turn:progress', payload: { instanceId, startedAt: turn.startedAt, outputTokens: 0 } })

  // Stateful stream parser for this process (tracks index→toolId mapping)
  const parseLine = createStreamParser(instanceId)

  // Track session ID from system event. Seed from resumeSessionId (not the raw sessionId) so a
  // heal-forced fresh start doesn't carry the dead id into stdin/DB - the system event delivers
  // the CLI's new id.
  let resolvedSessionId = resumeSessionId || ''
  // The session id this process last wrote to the row, and the last one it sent to the tabs.
  // Both start empty, so the first system event of a process always writes and
  // announces once; the repeats after it (every hook and status event carries the same id)
  // write nothing and ride the normal batch instead of forcing a flush each.
  let persistedSessionId: string | undefined
  let announcedSessionId: string | undefined
  let lastCostUsd: number | undefined
  // What THIS process spent: the sum of its turns' own costs. lastCostUsd is the CLI's
  // running total, which on 2.1.278+ includes the whole session's earlier spend, so it must
  // not be what token_usage, task budgets or the exit event report as this run's cost.
  let processSpendUsd = 0
  let lastInputTokens: number | undefined
  let lastOutputTokens: number | undefined
  let lastCacheCreation: number | undefined
  let lastCacheRead: number | undefined
  let lastResultText: string | undefined
  let sawAssistantText = false
  let lastAssistantMessageId: string | undefined
  // The CLI's `result` event carries no model field; assistant events do
  // (message.model). Tracked here so turn_costs rows get model + computed cost.
  let lastSeenModel: string | undefined
  // True context occupancy. Each `assistant` event carries the usage of THAT single request,
  // so the last one seen is the live prompt size. The `result` event's usage is summed over
  // every request in the turn (an 87-minute turn reported 98M input / 97M cache reads), which
  // is a turn cost, not an occupancy - feeding it to the gauge pinned it at 100%.
  let lastPromptTokens: number | undefined

  // The gauge has to move DURING the turn. Writing it only at `result` meant an
  // hour-long turn displayed an hour-old number, which can read well under half of the
  // real occupancy by the time the turn ends.
  // Throttled and change-gated so a 2000-step turn is not 2000 writes and 2000 frames.
  const CTX_WRITE_INTERVAL_MS = 5000
  let lastCtxWriteAt = 0
  let lastCtxWritten = 0

  /**
   * The ONE invariant this whole path exists to hold: ctx_tokens is a single request's
   * prompt size, never a sum. A value larger than the model's window is therefore not a
   * big session, it is a summed value that leaked in, so refuse it and log rather than
   * store it. Storing a clamped 100% would be worse than storing nothing: it looks
   * deliberate, and tiles have sat at a false 100% for weeks that way.
   */
  function publishContext(prompt: number, model: string | undefined, final = false): void {
    const resolved = model ?? lastSeenModel
    const window = resolveContextWindow(resolved)
    if (prompt > window) {
      console.warn(`[claude-process] refusing implausible ctx_tokens=${prompt} for ${instanceId} (window ${window}, model ${resolved ?? 'unknown'})`)
      return
    }
    const now = Date.now()
    if (!final && (prompt === lastCtxWritten || now - lastCtxWriteAt < CTX_WRITE_INTERVAL_MS)) return
    lastCtxWriteAt = now
    lastCtxWritten = prompt
    try {
      db.prepare('UPDATE instances SET ctx_tokens = ?, ctx_model = COALESCE(?, ctx_model) WHERE id = ?')
        .run(prompt, resolved ?? null, instanceId)
    } catch { /* non-critical */ }
    broadcastEvent({ type: 'instance:updated', payload: { id: instanceId, ctxTokens: prompt } })
  }

  /** Keep the model pinned even when no prompt size was captured: cache-advisor's
   *  keep-alive ping is keyed to ctx_model, and a wrong model warms the wrong cache. */
  function publishModelOnly(model: string | undefined): void {
    const resolved = model ?? lastSeenModel
    if (!resolved) return
    try {
      db.prepare('UPDATE instances SET ctx_model = COALESCE(?, ctx_model) WHERE id = ?').run(resolved, instanceId)
    } catch { /* non-critical */ }
  }

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
    // Results, errors, permission requests and a NEW session id are sent immediately. A system
    // event that only repeats the id already announced is ordinary traffic.
    const newSession = event.type === 'system' && !!event.sessionId && event.sessionId !== announcedSessionId
    if (newSession && event.type === 'system') announcedSessionId = event.sessionId
    if (newSession || event.type === 'result' || event.type === 'error' || event.type === 'permission-request') {
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

  // AskUserQuestion / ExitPlanMode hard-stop. The CLI auto-fails these tools (no real answer
  // channel in stream-json mode) and the model otherwise keeps generating past the question.
  // When the auto-fail result for such a tool_use lands, END the turn so the interactive card
  // is the last thing on screen; the user answers via the UI and we resume through the
  // answer-question route. Deterministic, unlike the system-prompt nudge alone.
  // tool_use id → which card it is, so the hard-stop records WHY the turn ended and not
  // merely that it did. A plain Set lost that, and 'question' vs 'plan' is the difference
  // between "answer me" and "approve my plan" in the UI.
  const pendingAskKill = new Map<string, AwaitingInputKind>()
  let askHardStopDone = false
  function hardStopForQuestion(reason: string, kind: AwaitingInputKind): void {
    if (askHardStopDone) return
    askHardStopDone = true
    console.log(`[claude-process] ${kind} hard-stop for ${instanceId} (${reason})`)
    // Record the block BEFORE the kill. The exit handler that follows sets state='idle',
    // which is exactly what used to make a waiting instance look finished. This row is the
    // only thing that tells the two apart, so it must exist before the process dies.
    //
    // Never allowed to break the kill. `askHardStopDone` is already true by this point, so
    // an exception escaping here (SQLITE_BUSY on a DB every instance writes to) would skip
    // flushBatch AND killProcess and permanently disarm the hard stop for this turn: the
    // model would then stream straight past the question and the card would no longer be
    // the last thing on screen. Losing the amber chip is a cosmetic failure; losing the
    // hard stop is the feature it was built on top of.
    try {
      markAwaitingInput(instanceId, kind)
    } catch (err) {
      console.error(`[claude-process] markAwaitingInput failed for ${instanceId} (killing anyway):`, err)
    }
    flushBatch()
    // Brief delay lets the CLI flush the tool_result to the session JSONL so the resumed
    // turn sees a complete tool_use/tool_result pair.
    setTimeout(() => {
      // Only this turn's own process: if it has already gone and the chat moved on, a kill by
      // chat id here would hit the NEXT turn.
      if (!processRegistry.isCurrent(instanceId, child)) return
      processRegistry.killProcess(instanceId).then(killed => {
        // The kill can fail (the codebase handles a surviving process explicitly elsewhere).
        // If it did, the turn carries on past the question and finishes normally, and there
        // is then nothing to answer: leaving the flag set would strand the chat amber
        // forever, sorted ahead of everything actually running. Roll it back.
        if (!killed) {
          console.warn(`[claude-process] hard-stop kill failed for ${instanceId}, clearing the awaiting flag`)
          clearAwaitingInput(instanceId)
        }
      }).catch(() => {})
    }, 60)
  }

  // Decides when stdin may end. NOT on the first `result`: see stdin-close.ts.
  const stdinCloser = createStdinCloseTracker()

  // Read stdout line by line. Decoded as UTF-8 by the stream: a Buffer chunk
  // turned into a string on its own splits an accented letter or an emoji that straddles two
  // chunks into two replacement characters. The partial line is capped, so a process that
  // never writes a newline cannot grow server memory without limit.
  let stdoutBuffer = ''
  child.stdout?.setEncoding('utf8')
  // Set while the rest of an over-long line is being thrown away, up to its newline: its tail
  // must not be read as a line of its own.
  let discardingLine = false
  child.stdout?.on('data', (raw: string) => {
    try {
      resetTimeout()
      let chunk = raw
      if (discardingLine) {
        const nl = chunk.indexOf('\n')
        if (nl === -1) return
        chunk = chunk.slice(nl + 1)
        discardingLine = false
      }
      const lines = splitLines(stdoutBuffer, chunk)
      stdoutBuffer = lines.pop() || ''
      if (stdoutBuffer.length > MAX_PARTIAL_LINE_CHARS) {
        console.warn(`[claude-process] stdout line over ${MAX_PARTIAL_LINE_CHARS} chars without a newline for ${instanceId.slice(0, 8)}, dropped`)
        stdoutBuffer = ''
        discardingLine = true
      }

      for (const line of lines) {
        // Parse each line ONCE - the same object is handed to parseLine() below,
        // halving JSON.parse work on the hot path (tool-result lines reach ~1 MB).
        let rawParsed: Record<string, unknown> | undefined
        try {
          rawParsed = JSON.parse(line.trim())
        } catch { /* non-JSON line - parseLine falls back to text-delta */ }

        // The turn is over only when the CLI says its queue is drained. Close stdin so it exits.
        stdinCloser.onEvent(rawParsed)
        if (stdinCloser.shouldCloseStdin()) closeStdin()

        // The CLI withdrew a request it was blocked on (the tool call it belonged to was aborted).
        // Nobody can answer it now, so it leaves the queue and every open tab exactly as an
        // answer would. The client no longer drops cards on `result`, so this is the path for it.
        if (rawParsed?.type === 'control_cancel_request' && typeof rawParsed.request_id === 'string') {
          if (resolvePermissionRequest(instanceId, rawParsed.request_id)) {
            broadcastEvent({ type: 'permission:resolved', payload: { instanceId, requestId: rawParsed.request_id } })
          }
          continue
        }

        // Save assistant messages to DB before parsing
        let handledAsAssistant = false
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw = rawParsed as any
          if (raw && raw.type === 'assistant' && raw.message?.content) {
            handledAsAssistant = true
            if (typeof raw.message.model === 'string' && raw.message.model) lastSeenModel = raw.message.model
            // Live round-trip token counter: each assistant event is one model step,
            // carrying that step's output_tokens. Sum across steps → tokens this turn.
            const stepOutput = Number(raw.message?.usage?.output_tokens) || 0
            if (stepOutput > 0) {
              const tp = addTurnOutput(instanceId, stepOutput)
              if (tp) broadcastEvent({ type: 'turn:progress', payload: { instanceId, startedAt: tp.startedAt, outputTokens: tp.outputTokens } })
            }
            // This request's prompt size = uncached + cache_creation + cache_read.
            const stepUsage = raw.message?.usage
            if (stepUsage) {
              const prompt = (Number(stepUsage.input_tokens) || 0)
                + (Number(stepUsage.cache_creation_input_tokens) || 0)
                + (Number(stepUsage.cache_read_input_tokens) || 0)
              // Top-level steps only, for the same reason the cache-read guard below is
              // top-level only: a subagent's prompt is the SUBAGENT's context and says
              // nothing about this session's occupancy.
              if (prompt > 0 && raw.parent_tool_use_id == null) {
                lastPromptTokens = prompt
                publishContext(prompt, typeof raw.message?.model === 'string' ? raw.message.model : undefined)
              }
              // A step that READ the prompt cache is proof the cache was just touched, which
              // restarts its TTL. The client's cache anchor otherwise only advances at turn
              // END, so a long turn counted down against the PREVIOUS turn's timestamp and
              // could show "Expired" while the model was reading that very cache every step.
              //
              // Evidence, never inference: this fires on a reported cache_read, not on "the
              // process is alive". Faking freshness from liveness would make keepWarm and
              // cache-advisor skip a keep-alive turn for a cache that had actually gone cold,
              // costing a full cold re-read.
              // Top-level steps only: a subagent's steps stream on this same channel but read
              // the SUBAGENT's cache, which says nothing about the parent session's.
              if (raw.parent_tool_use_id == null) {
                noteCacheRead(instanceId, Number(stepUsage.cache_read_input_tokens) || 0)
              }
            }
            const msgId = crypto.randomUUID()
            lastAssistantMessageId = msgId
            // Intercept ScheduleWakeup tool_use blocks: claude's stream-json mode has no harness
            // to honor them, so we persist the intent and let wakeup-scheduler fire sendMessage
            // when the timer expires. The agent thinks the tool succeeded; we make it real.
            for (const b of raw.message.content as Array<Record<string, unknown>>) {
              // File-lock safety: a write to a file another instance has uncommitted
              // edits on pauses this run (deterministic, no model involvement).
              if (b.type === 'tool_use' && typeof b.name === 'string' && isWriteTool(b.name)) {
                const fp = extractFilePath(b.name, (b.input as Record<string, unknown>) ?? {})
                if (fp) {
                  // Async: the git re-check runs off the stream handler. By the time it
                  // answers, this process must still be the chat's, or the pause is not ours to do.
                  noteEdit(instanceId, cwd, fp).then(conflict => {
                    if (conflict && processRegistry.isCurrent(instanceId, child)) void pauseOnConflict(instanceId, conflict)
                  }).catch(e => {
                    console.warn('[file-locks] noteEdit failed:', e)
                  })
                }
              }
              // Bash can write files outside the Edit/Write tools. Snapshot dirty state
              // just before it runs so its completion attributes only this command's writes.
              if (b.type === 'tool_use' && b.name === 'Bash' && typeof b.id === 'string') {
                void snapshotPreBash(instanceId, b.id, cwd)
              }
              if (b.type === 'tool_use' && (b.name === 'AskUserQuestion' || b.name === 'ExitPlanMode')) {
                const tid = typeof b.id === 'string' ? b.id : ''
                if (tid) {
                  const kind: AwaitingInputKind = b.name === 'ExitPlanMode' ? 'plan' : 'question'
                  pendingAskKill.set(tid, kind)
                  // Fallback: if the auto-fail tool_result never parses as tool-complete,
                  // still end the turn shortly after the question is asked.
                  setTimeout(() => { if (pendingAskKill.has(tid)) hardStopForQuestion('fallback timer', kind) }, 1500)
                }
              }
              if (b.type === 'tool_use' && b.name === 'ScheduleWakeup') {
                const input = (b.input as Record<string, unknown>) ?? {}
                const delaySeconds = Number(input.delaySeconds)
                const prompt = typeof input.prompt === 'string' ? input.prompt : ''
                const reason = typeof input.reason === 'string' ? input.reason : undefined
                // A turn the user stopped (or the app is killing) schedules nothing: its output can
                // still be read for a moment after the Stop began, and a wake-up made then would start
                // the chat again on its own.
                const stoppedTurn = processRegistry.wasStoppedByApp(child) || processRegistry.stoppedByUserSince(instanceId, turnStartedAt)
                if (stoppedTurn) console.log(`[wakeup] not scheduled: the turn on ${instanceId.slice(0, 8)} that asked for it was stopped`)
                if (!stoppedTurn && Number.isFinite(delaySeconds) && delaySeconds > 0 && prompt) {
                  try {
                    scheduleWakeup({
                      instanceId,
                      delaySeconds,
                      prompt,
                      reason,
                      toolUseId: b.id as string | undefined,
                    })
                  } catch (e) {
                    console.warn(`[claude-process] Failed to schedule wakeup:`, e)
                    // Too many already waiting: say so in the chat, where it can be seen.
                    if (e instanceof WakeupCapError) broadcastSystemNote(instanceId, `⏰ ${e.message}`)
                  }
                }
              }
            }
            const parentToolUseId = typeof raw.parent_tool_use_id === 'string' ? raw.parent_tool_use_id : undefined
            // Stored and broadcast in the chat's shape, with each tool payload capped per field:
            // a Write of a large file used to put the whole file in the row, and
            // every tab and every scroll of history carried it again. The full text stays in the
            // CLI's own transcript.
            const content = compactContentForStorage(raw.message.content.map((b: Record<string, unknown>) => {
              if (b.type === 'text') return { type: 'text', text: b.text }
              if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking }
              if (b.type === 'tool_use') return { type: 'tool-call', toolId: b.id, toolName: b.name, input: JSON.stringify(b.input), ...(parentToolUseId ? { parentToolUseId } : {}) }
              return b
            }) as Array<Record<string, unknown>>) as unknown as MessageContentBlock[]
            if (raw.message.content.some((b: Record<string, unknown>) => b.type === 'text' && typeof b.text === 'string' && (b.text as string).trim())) {
              sawAssistantText = true
            }
            const createdAt = Date.now()
            try {
              db.prepare(`
                INSERT OR IGNORE INTO messages (id, instance_id, role, content, created_at)
                VALUES (?, ?, ?, ?, ?)
              `).run(msgId, instanceId, 'assistant', JSON.stringify(content), createdAt)
            } catch (err) {
              // The reply is still broadcast below, so it shows now, but a reload would lose it.
              // That used to happen with no trace at all.
              reportPersistFailure('assistant-message', err, { instanceId, detail: `message ${msgId.slice(0, 8)}` })
            }

            // Broadcast the saved message so the client can display it immediately
            enqueueEvent({
              type: 'assistant-message',
              instanceId,
              message: { id: msgId, instanceId, role: 'assistant', content, createdAt }
            })
          }
        } catch (err) {
          // Assistant handling failed on something other than the save (a bad shape): the line
          // still falls through to parseLine, but the failure is logged, never swallowed.
          console.error(`[claude-process] assistant event handling failed [${instanceId.slice(0, 8)}]:`, err)
        }

        // Forward raw line to client for terminal stream view
        if (line.trim()) {
          enqueueEvent({ type: 'raw-line', instanceId, line })
        }

        // Skip stream parser for assistant messages - already handled above as complete messages.
        // The parser would re-emit tool-start/tool-input-delta events causing duplicate UI renders.
        if (handledAsAssistant) continue

        const parsed = parseLine(line, rawParsed)
        if (!parsed) continue
        const lineEvents = Array.isArray(parsed) ? parsed : [parsed]

        for (const event of lineEvents) {
          // A request read after exit belongs to a process that can no longer take an answer; tracked
          // now it would outlive the clear on exit and hang a card on an idle chat.
          if (event.type === 'permission-request' && processExited) continue
          // Auto-allow the can_use_tool gate for the interactive card tools, then swallow the
          // event so no Allow/Deny banner ever reaches the client. The user answers the card
          // itself; gating it would just be an extra click in front of the question.
          if (event.type === 'permission-request' && AUTO_ALLOW_PERMISSION_TOOLS.has(event.toolName)) {
            const envelope = {
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: event.requestId,
                response: { behavior: 'allow', updatedInput: event.input ?? {} },
              },
            }
            processRegistry.writeStdin(instanceId, JSON.stringify(envelope) + '\n')
            if (VERBOSE) console.log(`[claude-process] auto-allowed ${event.toolName} permission for ${instanceId.slice(0, 8)}`)
            continue
          }
          // Every other request now waits on a person. Kept server-side as well as sent, so a
          // reloaded tab still shows the banner the CLI is blocked on (pending-permissions.ts).
          if (event.type === 'permission-request') {
            const { type: _type, ...request } = event
            trackPermissionRequest({ ...request, receivedAt: Date.now() })
          }
          // End the turn the instant an AskUserQuestion/ExitPlanMode auto-fail result lands,
          // before the model can stream anything after it.
          if (event.type === 'tool-complete' && pendingAskKill.has(event.toolId)) {
            const kind = pendingAskKill.get(event.toolId) as AwaitingInputKind
            pendingAskKill.delete(event.toolId)
            hardStopForQuestion('auto-fail result', kind)
          }
          // Bash finished - claim whatever it dirtied (no-op for non-Bash tool ids).
          if (event.type === 'tool-complete' && event.toolId) {
            void onBashComplete(event.toolId).catch(() => {})
          }
          if (event.type === 'system' && event.sessionId) {
            resolvedSessionId = event.sessionId
            // Written only when it changes. The CLI repeats its session id on every
            // system event (init, hooks, status), and each one used to rewrite the same value.
            if (event.sessionId !== persistedSessionId) {
              try {
                db.prepare('UPDATE instances SET session_id = ? WHERE id = ?').run(resolvedSessionId, instanceId)
                persistedSessionId = event.sessionId
              } catch (err) {
                // Left unset on failure, so the next system event tries again.
                reportPersistFailure('session-id', err, { instanceId })
              }
            }
          }

          if (event.type === 'compaction') {
            // Context was just summarized - the old occupancy number is meaningless.
            // Zero it out; the next turn's result event records the true post-compact size.
            try { db.prepare('UPDATE instances SET ctx_tokens = 0 WHERE id = ?').run(instanceId) } catch { /* non-critical */ }
          }

          if (event.type === 'result') {
            lastCostUsd = event.costUsd
            lastInputTokens = event.inputTokens
            lastOutputTokens = event.outputTokens
            lastCacheCreation = event.cacheCreationTokens
            lastCacheRead = event.cacheReadTokens
            if (event.resultText) lastResultText = event.resultText
            console.log(`[claude-process] Result for ${instanceId}: in=${lastInputTokens} out=${lastOutputTokens} cli_total=$${lastCostUsd} cache_create=${lastCacheCreation} cache_read=${lastCacheRead}`)

            // --- Per-turn cost tracking ---
            // Recorded first: this process's spend (processSpendUsd) is the sum of the
            // per-turn costs this produces.
            const turnCliTotal = event.costUsd ?? 0
            const turnInput = event.inputTokens ?? 0
            const turnOutput = event.outputTokens ?? 0
            const turnCacheCreation = event.cacheCreationTokens ?? 0
            const turnCacheRead = event.cacheReadTokens ?? 0
            // session_id may legitimately be missing (e.g. system event lost) - still
            // record the row with NULL session but valid instance_id + timestamp.
            const sid = resolvedSessionId || null

            // Get current task ID if any
            let currentTaskId: string | null = null
            try {
              const taskRow = db.prepare('SELECT active_task_id FROM instances WHERE id = ?').get(instanceId) as { active_task_id: string | null } | undefined
              currentTaskId = taskRow?.active_task_id ?? null
            } catch (err) {
              // The cost row is still written, without its card.
              reportPersistFailure('turn-cost-context', err, { instanceId, detail: 'active card' })
            }

            // The CLI's raw running total lands in cli_total_usd, this turn's own share of it
            // in cost_usd, and a locally computed API-equivalent cost in computed_cost_usd.
            // effectiveCost prefers the turn's own CLI share when non-zero.
            let effectiveTurnCost = turnCliTotal
            let cumCost = turnCliTotal
            // A user-typed /compact runs through the normal send pipeline, so tag it and let
            // analytics separate compaction overhead from work. Hoisted out of the call below
            // because the turn-duration write also has to skip compact runs.
            const turnKind: 'turn' | 'compact' = text.trim().startsWith('/compact') ? 'compact' : 'turn'
            // The cache advisor's keep-warm ping runs through this same pipeline and looks
            // like an ordinary turn, so without this it would set last_turn_ms on every idle
            // keep-warm chat roughly hourly ("worked for 2s" on a chat you have not touched),
            // and a ping stalled behind rate-limit retries could set max_turn_ms and become
            // that chat's permanent, unerasable "longest turn".
            const isKeepAlivePing = text.trim() === KEEPALIVE_TEXT
            // The turn's cost row and the message's own cost are ONE write: a crash
            // between them used to leave a turn cost with no message cost, or the reverse.
            // (The `token_usage` UPDATE that sat here is gone: nothing has written a
            // token_usage row for months, so it matched nothing, twice per turn.)
            try {
              let turnSpend = 0
              db.transaction(() => {
                const rec = recordTurnCost({
                  instanceId,
                  folderId,
                  sessionId: sid,
                  messageId: lastAssistantMessageId || null,
                  taskId: currentTaskId,
                  kind: turnKind,
                  inputTokens: turnInput,
                  outputTokens: turnOutput,
                  cacheCreationTokens: turnCacheCreation,
                  cacheReadTokens: turnCacheRead,
                  costUsd: turnCliTotal,
                  durationMs: event.durationMs ?? null,
                  model: event.model ?? lastSeenModel ?? null,
                })
                if (lastAssistantMessageId) {
                  db.prepare('UPDATE messages SET input_tokens = ?, output_tokens = ?, cost_usd = ? WHERE id = ?')
                    .run(turnInput, turnOutput, rec.effectiveCost, lastAssistantMessageId)
                }
                effectiveTurnCost = rec.effectiveCost
                cumCost = rec.cumCost
                turnSpend = rec.turnCost
              })()
              processSpendUsd += turnSpend
            } catch (err) {
              // Logged with context and shown to the user: a lost cost row makes the
              // usage figures quietly low, which nobody can spot afterwards.
              reportPersistFailure('turn-cost', err, { instanceId, detail: `session ${sid?.slice(0, 8) ?? 'none'}` })
            }

            // Final word on context occupancy for this turn. It must be the LAST request's
            // prompt size and nothing else.
            //
            // There used to be a `?? event.inputTokens` fallback here. That value is summed
            // across every request in the turn, so it is a turn cost, not an occupancy, and
            // it is how a figure larger than the 1M window could end up stored: every
            // overstated reading matched exactly that sum, to the token. Missing is
            // now missing: if no per-step prompt was captured, the previous value stands.
            if (lastPromptTokens != null) publishContext(lastPromptTokens, event.model ?? lastSeenModel, true)
            else publishModelOnly(event.model ?? lastSeenModel)

            // Turn duration cache on the instance: last_turn_ms drives the "worked for"
            // footnote on the chat's last message, max_turn_ms drives the longest-turn record.
            //
            // max_turn_ms is a MONOTONIC MAXIMUM, never an overwrite. Assigning the current
            // turn to both columns in one statement looks equivalent and silently redefines
            // the record as "duration of the most recent turn", which only surfaces when a
            // short turn follows a long one. /compact is excluded because 171 compact rows
            // already carry a duration and would otherwise compete for the record.
            const turnDurationMs = Number(event.durationMs) || 0
            if (turnKind === 'turn' && !isKeepAlivePing && turnDurationMs > 0) {
              try {
                db.prepare(
                  'UPDATE instances SET last_turn_ms = ?, max_turn_ms = MAX(COALESCE(max_turn_ms, 0), ?) WHERE id = ?'
                ).run(turnDurationMs, turnDurationMs, instanceId)
                // Push it, do not wait for the next /api/state. That endpoint is only hit on
                // mount and on WS reconnect, so without this broadcast the client keeps the
                // PREVIOUS turn's duration while the footnote moves to the new message: a 9s
                // turn would render the last turn's "worked for 12m 34s". Stale is worse than
                // absent here, because it looks authoritative.
                const fresh = db.prepare('SELECT last_turn_ms, max_turn_ms FROM instances WHERE id = ?')
                  .get(instanceId) as { last_turn_ms: number | null; max_turn_ms: number | null } | undefined
                broadcastEvent({
                  type: 'instance:updated',
                  payload: {
                    id: instanceId,
                    lastTurnMs: fresh?.last_turn_ms ?? turnDurationMs,
                    maxTurnMs: fresh?.max_turn_ms ?? turnDurationMs,
                    // WHICH message this duration belongs to. Without it the client can only
                    // guess "the last assistant message", which is wrong three ways: a turn
                    // that ends with no result event (AskUserQuestion, plan mode, a user
                    // stop) leaves its message to inherit the previous turn's number, a
                    // client-side slash-command echo is also role:assistant and steals the
                    // footnote, and mid-stream the running turn's first text block becomes
                    // "last" and shows the previous turn's duration. Not persisted: on
                    // reload the client falls back to last-assistant, which is right in the
                    // ordinary case.
                    lastTurnMessageId: lastAssistantMessageId || null,
                  },
                })
              } catch (err) {
                console.error(`[claude-process] Failed to update turn duration for ${instanceId}:`, err)
              }
            }

            // Attach delta fields to the event for real-time client display
            event.deltaCostUsd = effectiveTurnCost
            event.deltaInputTokens = turnInput
            event.deltaOutputTokens = turnOutput
            event.deltaCacheCreationTokens = turnCacheCreation
            event.deltaCacheReadTokens = turnCacheRead
            event.sessionTotalCostUsd = cumCost
            event.turnMessageId = lastAssistantMessageId
            // stdin is NOT closed here. A result can end a turn that ran ahead of the user's own
            // (a background task reporting in on --resume), and closing now would leave the real
            // turn unable to receive a permission answer. stdinCloser, above, decides.
          }

          enqueueEvent(event)
        }
      }
    } catch (err) {
      console.error(`[claude-process] stdout handler error [${instanceId.slice(0, 8)}]:`, err)
    }
  })

  // Stderr - forward line-by-line as raw-line events.
  // raw-line goes ONLY to opt-in terminal subscribers, so anything the CLI reports here is
  // invisible in the chat. Keep the last few human-readable lines so a process that dies
  // before emitting a result event can still explain itself (see the exit handler).
  let stderrBuffer = ''
  const stderrTail: string[] = []
  const STDERR_TAIL_MAX = 20
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    try {
      const lines = splitLines(stderrBuffer, chunk)
      stderrBuffer = lines.pop() || ''
      if (stderrBuffer.length > MAX_PARTIAL_LINE_CHARS) stderrBuffer = ''
      for (const line of lines) {
        if (line.trim()) {
          // Skip stream-json blobs the CLI mirrors to stderr (init frames etc.) - they are
          // noise in a user-facing error and can be megabytes. That skip now comes
          // BEFORE the log line, and what is logged is capped and has keys and passwords
          // removed, because the server log is a plain file on disk.
          if (!line.trimStart().startsWith('{')) {
            const logged = stderrLogLine(line)
            console.error(`[claude-process] stderr [${instanceId.slice(0, 8)}]:`, logged)
            stderrTail.push(logged)
            if (stderrTail.length > STDERR_TAIL_MAX) stderrTail.shift()
          }
          enqueueEvent({ type: 'raw-line', instanceId, line, isStderr: true })
        }
      }
    } catch (err) {
      console.error(`[claude-process] stderr handler error [${instanceId.slice(0, 8)}]:`, err)
    }
  })

  // Write user message to stdin as NDJSON - keep stdin OPEN for interactive prompts
  // (permissions, AskUser, etc.). Closed when the CLI reports idle after a result (stdin-close.ts).
  // stream-json format: { type: "user", message: { role: "user", content: "..." }, session_id, parent_tool_use_id }
  const messageContent: unknown[] = []
  // Sibling-awareness note rides as its own block at the head of the user message -
  // after the cached prefix - so its per-turn text never invalidates the prompt cache
  // (see the CACHE-CRITICAL comment where it is built).
  if (updateNote) messageContent.push({ type: 'text', text: updateNote })
  // Only include text block if non-empty - API rejects { type: 'text', text: '' }
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
  if (VERBOSE) console.log(`[claude-process] STDIN → ${instanceId}: ${stdinPayload.length} chars (text: ${text.slice(0, 100)}...)`)
  // Guard against unhandled 'error' on stdin (e.g. process dies before write completes)
  let stdinEnded = false
  child.stdin?.on('error', (err) => {
    console.warn(`[claude-process] stdin write error [${instanceId.slice(0, 8)}]:`, err.message)
  })
  child.stdin?.write(stdinPayload + '\n')
  // DO NOT call child.stdin.end() here - stdin stays open so the process can receive
  // interactive input (permission responses, AskUser answers) via processRegistry.writeStdin().
  // stdin is closed once stdinCloser (stdin-close.ts) says the CLI is idle; see closeStdin below.

  // Close stdin to signal the CLI that no more input is coming → triggers clean exit
  function closeStdin() {
    if (stdinEnded) return
    stdinEnded = true
    try { child.stdin?.end() } catch { /* already closed */ }
  }

  // Activity-based timeout: resets on every stdout chunk so long-running but active processes aren't killed
  let activityTimeout: ReturnType<typeof setTimeout> | null = null
  // Set on exit. stdout can still deliver a chunk after 'exit', and a timer armed from it would
  // outlive this process and act on whatever process the chat runs next.
  let processExited = false
  function resetTimeout() {
    if (activityTimeout) clearTimeout(activityTimeout)
    if (processExited) return
    activityTimeout = setTimeout(() => {
      if (processExited) return
      // A CLI blocked on a permission request writes nothing until it is answered, so silence
      // there is a person who has not clicked yet, not a hung process. Killing it threw the
      // prompt away: the card vanished and the command never ran, however long the answer
      // took. Keep waiting, up to PERMISSION_WAIT_CEILING_MS: a forgotten card holds the
      // process, and so the dev.lock every server restart waits on.
      const waitingSince = oldestPendingPermissionAt(instanceId)
      if (waitingSince !== null && Date.now() - waitingSince < PERMISSION_WAIT_CEILING_MS) {
        console.log(`[claude-process] ${instanceId.slice(0, 8)} silent ${PROCESS_TIMEOUT_MS / 60_000}min but waiting on a permission answer, not killing`)
        resetTimeout()
        return
      }
      if (waitingSince !== null) {
        console.warn(`[claude-process] ${instanceId} waited ${Math.round(PERMISSION_WAIT_CEILING_MS / 60_000)}min on an unanswered permission request, killing process`)
      }
      console.warn(`[claude-process] Timeout (${PROCESS_TIMEOUT_MS / 60_000}min idle) for instance ${instanceId}, killing process`)
      // A kill that failed leaves the process tracked and running, and a CLI blocked on a card writes
      // nothing that would re-arm this timer, so try again next period rather than never.
      processRegistry.killProcess(instanceId).then(killed => {
        if (!killed) resetTimeout()
      }).catch(err => {
        console.error(`[claude-process] Kill after timeout failed for ${instanceId}:`, err)
        resetTimeout()
      })
    }, PROCESS_TIMEOUT_MS)
    processRegistry.setTimeoutTimer(instanceId, activityTimeout)
  }
  resetTimeout()

  // Idempotent cleanup dedup - prevents double cleanup if killProcess() already ran
  const cleanedUp = new Set<string>()

  // Handle exit - ALWAYS clean up DB state and record tokens, even if killed externally
  child.on('exit', (code) => {
    processExited = true
    if (activityTimeout) clearTimeout(activityTimeout)
    console.log(`[claude-process] EXIT: instance=${instanceId} PID=${child.pid} code=${code}`)
    if (cleanedUp.has(instanceId)) {
      if (VERBOSE) console.log(`[claude-process] EXIT DEDUP: instance ${instanceId} already cleaned up`)
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
            // This result writes no turn_costs row, but its share still counts as this
            // process's spend. Same subtraction as a recorded turn, against the last row.
            const cliTotal = event.costUsd ?? 0
            processSpendUsd += perTurnCost({
              cliTotal,
              prevCliTotal: previousCliTotal(resolvedSessionId || null),
              computed: null,
              createdAt: Date.now(),
            })
            console.log(`[claude-process] Result (flush) for ${instanceId}: in=${lastInputTokens} out=${lastOutputTokens} cli_total=$${lastCostUsd} process_spend=$${processSpendUsd.toFixed(4)}`)
            // Persist context occupancy (same rule as the inline result handler: a single
            // request's prompt size, never the turn-summed input, never a zero on absence).
            if (lastPromptTokens != null) publishContext(lastPromptTokens, event.model ?? lastSeenModel, true)
            else publishModelOnly(event.model ?? lastSeenModel)
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

    // Did a newer turn take this chat over while this process was dying? Its exit then must
    // not touch the chat's state: unregistering, marking idle or clearing its cards would act
    // on the NEW turn. Its own tokens and messages are still recorded below.
    const superseded = (processRegistry.isTracked(instanceId) && !processRegistry.isCurrent(instanceId, child))
      || isClaimed(chatKey(instanceId))

    // Unregister from ProcessRegistry (no-op if already removed by killProcess, or if a newer
    // process is the one registered now)
    processRegistry.unregisterProcess(instanceId, child)

    // Token summary for the log. (Its `token_usage` UPDATE is gone: no row has been
    // inserted there for months, so it matched nothing. turn_costs is the record.)
    if (lastInputTokens || lastOutputTokens) {
      const cacheRatio = lastInputTokens
        ? Math.round(((lastCacheRead || 0) / lastInputTokens) * 100)
        : 0
      console.log(`[claude-process] Token summary ${instanceId}: cost=$${processSpendUsd.toFixed(4)} (cli_total=$${(lastCostUsd || 0).toFixed(4)}) cache_hit=${cacheRatio}% (read=${lastCacheRead || 0} create=${lastCacheCreation || 0})`)
    } else {
      console.warn(`[claude-process] No token data captured for ${instanceId} - result event may not have arrived`)
    }

    // A non-zero exit that produced NO assistant text and NO result event used to vanish
    // completely: nothing was written to `messages`, and the CLI's explanation went to
    // stderr, which only reaches opt-in terminal subscribers. The chat simply stopped
    // replying, with the user's message sitting there unanswered and no error anywhere
    // (a mis-cased worktree path, for example, makes every --resume abort with exit 1).
    // Always leave a trace.
    // `!askHardStopDone` matters: a hard stop is an INTENTIONAL kill, so it always exits
    // non-zero with no result event, and a question whose turn emitted no text block would
    // otherwise trigger this warning. The user then gets steered to that chat by its amber
    // chip and reads "this message got no reply" directly above a live, answerable question
    // card. The turn did reply, with a question.
    // Nor after a Stop: a process the app killed exits non-zero with no result by definition, and
    // "exited without starting a turn" read as a failure right after the user pressed Stop.
    if (!sawAssistantText && !lastResultText && code !== 0 && !askHardStopDone && !processRegistry.wasStoppedByApp(child)) {
      const detail = stderrTail.length
        ? stderrTail.join('\n')
        : `No output was produced before the process exited.`
      broadcastSystemNote(
        instanceId,
        `⚠ The Claude CLI exited with code ${code} without starting a turn, so this message got no reply. Your message is still here - fix the cause below and send again.\n\n${detail}`
      )
    }

    // Save synthetic assistant message when CLI produced no text (e.g. /compact, slash commands)
    if (!sawAssistantText && lastResultText) {
      const syntheticId = crypto.randomUUID()
      const syntheticContent = JSON.stringify([{ type: 'text', text: lastResultText }])
      // Guarded: a throw here used to abort the rest of this exit handler, which
      // is what returns the chat to idle.
      try {
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, instance_id, role, content, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(syntheticId, instanceId, 'assistant', syntheticContent, Date.now())
      } catch (err) {
        reportPersistFailure('final-message', err, { instanceId })
      }
    }

    // Broadcast exit event
    const exitEvent: ClaudeProcessExitEvent = {
      instanceId,
      sessionId: resolvedSessionId || undefined,
      exitCode: code,
      // This process's spend, not the CLI's session running total (see processSpendUsd).
      costUsd: lastCostUsd != null ? processSpendUsd : undefined,
      inputTokens: lastInputTokens,
      outputTokens: lastOutputTokens
    }
    broadcastEvent({ type: 'claude:process-exit', payload: exitEvent })

    // Transition to idle
    const tokens: ProcessExitTokens | undefined = (lastInputTokens || lastOutputTokens)
      ? { inputTokens: lastInputTokens || 0, outputTokens: lastOutputTokens || 0, costUsd: processSpendUsd, cacheReadTokens: lastCacheRead, cacheCreationTokens: lastCacheCreation }
      : undefined
    pendingAskKill.clear()
    // Everything a finished turn does to the chat: idle, cards, locks, subscribers, /btw.
    const finishTurn = (): void => {
      endTurn(instanceId) // stop the live elapsed/token tracking for this turn
      // The process is gone, so nothing can answer a request it was blocked on, and a one-time
      // question it was spawned with and never raised must not wait for some later command.
      clearPermissionRequests(instanceId)
      disarmAskOnce(instanceId)
      // Drop the cache-touch throttle so the next turn's first cache read pings immediately
      // instead of being swallowed by the previous turn's window.
      lastCacheTouchAt.delete(instanceId)
      // Disarm any in-flight 1500ms fallback timer. It targets the INSTANCE, not this PID, so
      // a timer left armed past exit could re-mark a chat amber after the next turn already
      // cleared it, and then kill that fresh turn 60ms later.
      pendingAskKill.clear()
      db.prepare(
        `UPDATE instances SET process_state = 'idle', state = 'idle', process_pid = NULL, version = version + 1 WHERE id = ?`
      ).run(instanceId)
      broadcastEvent({ type: 'instance:state', payload: { instanceId, state: 'idle' } })

      // File locks: capture Bash-side writes, release committed files (async, non-blocking).
      // Once locks settle, push the fresh per-instance uncommitted count so the sidebar
      // ⚠ badge reflects this turn's edits without any extra git polling.
      void fileLocksTurnEnd(instanceId, cwd)
        .catch(() => {})
        .then(() => {
          try {
            broadcastEvent({ type: 'instance:updated', payload: { id: instanceId, dirtyCount: getInstanceDirtyCount(instanceId) } })
          } catch { /* non-critical */ }
        })

      // Notify turn-complete subscribers (routine-scheduler finalizes run rows here)
      notifyTurnComplete(instanceId, tokens, code)

      // Auto-retry transient server errors (rate limit / overload) on normal chat instances.
      // Runs after the idle transition so the rescheduled "Try Again" turn can spawn cleanly.
      try {
        evaluateAutoRetry({ instanceId, flags, agentPrompt, resultText: lastResultText, sawAssistantText, turnStartedAt })
      } catch (err) {
        console.error(`[auto-retry] evaluate failed for ${instanceId}:`, err)
      }

      // Best-effort session sanitization. Skipped when the chat is already running again: the new
      // turn sanitized the file itself before it resumed it, and rewriting it now would race the
      // CLI appending to it. The two passes also share a per-file lock in the sanitizer.
      if (resolvedSessionId && cwd) {
        setTimeout(() => {
          if (processRegistry.isTracked(instanceId) || isClaimed(chatKey(instanceId))) return
          sanitizeSession(cwd, resolvedSessionId).catch(() => {})
        }, 0)
      }

      // /btw delivery: run any note the user queued while this turn was active as a
      // fresh follow-up turn, reusing this turn's flags (model/effort/permission) for
      // continuity. Deferred briefly so the just-exited process is fully torn down
      // before we respawn; if the user already kicked off a new turn, re-queue so that
      // turn's exit flushes it instead of clobbering it.
      scheduleBtwFlush(instanceId, cwd, resolvedSessionId || undefined, flags)
    }
    if (superseded) {
      // Replaced by a start that has not registered its process yet. If that start never gets
      // there (Stop cancelled it, or it failed), nothing else would ever finish this turn: its
      // card hand-off, its live timer and its locks would be left behind. It runs this instead.
      if (!processRegistry.isTracked(instanceId)) deferFinish(instanceId, finishTurn)
      console.log(`[claude-process] EXIT of a replaced process for ${instanceId.slice(0, 8)} (PID ${child.pid}): the newer turn keeps the chat's state`)
      return
    }
    finishTurn()

  })

  // Generate a session ID if we don't have one yet (will be updated by system event)
  if (!resolvedSessionId) {
    resolvedSessionId = crypto.randomUUID()
  }

  return { sessionId: resolvedSessionId }
}

// Re-export registry methods for backwards compatibility in routes
export { processRegistry } from './process-registry.js'

/**
 * Reply to a tool_use the agent emitted (AskUserQuestion, ExitPlanMode) by writing a
 * stream-json `user` message containing a `tool_result` block to the running CLI's stdin.
 *
 * Wire format (one JSON object per line, terminated with `\n`):
 *   {"type":"user","message":{"role":"user","content":[{"type":"tool_result",
 *     "tool_use_id":"<id>","content":"<text>","is_error":<bool>}]}}
 */
export function respondToToolUse(opts: {
  instanceId: string
  toolUseId: string
  content: string
  isError: boolean
}): { ok: boolean; reason?: string } {
  const { instanceId, toolUseId, content, isError } = opts
  if (!processRegistry.isTracked(instanceId)) {
    return { ok: false, reason: 'process-not-running' }
  }
  const payload = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
  }
  const line = JSON.stringify(payload) + '\n'
  const ok = processRegistry.writeStdin(instanceId, line)
  return ok ? { ok: true } : { ok: false, reason: 'stdin-write-failed' }
}

// --- /btw "by the way" follow-up queue --------------------------------------
// A steering note the user sends WHILE a turn is running is parked here and auto-
// dispatched as a fresh --resume follow-up turn the moment the current turn ends
// (see the exit handler in sendMessage). This is the reliable, server-modeled path:
// every note runs as a normal turn, so it can't be silently dropped or double-run.
//
// (Mid-turn absorption - writing the note onto the live stdin so the CLI folds it
// into the in-flight turn - was verified to work ONLY at a tool boundary on the
// installed CLI, and a text-only turn would run it as an unsolicited second turn
// inside the same process, which the server's one-turn-per-process lifecycle does
// not model. So that "fast path" is intentionally deferred to a later iteration.)
const pendingBtwNotes = new Map<string, string[]>()

/**
 * Queue a note for the follow-up turn. Returns false when the identical note is already waiting.
 *
 * Two refusals of the same call in one turn each sent the same "Permission has now been granted
 * for: ..." line, and the flush joins queued notes, so the follow-up turn opened with
 * the same instruction twice. A note already in the queue says nothing new the second time.
 */
export function queueBtwNote(instanceId: string, note: string): boolean {
  const arr = pendingBtwNotes.get(instanceId) ?? []
  if (arr.includes(note)) return false
  arr.push(note)
  pendingBtwNotes.set(instanceId, arr)
  return true
}

/**
 * Send the chat's queued /btw notes as their own turn, once nothing else holds the chat.
 * A turn running or starting will flush them when IT ends, so they wait for that; a /compact
 * has no exit hook, so the flush retries until the compact is done. A send that fails puts
 * the notes back rather than dropping them (they are already visible in the chat).
 */
export function scheduleBtwFlush(instanceId: string, cwd: string, sessionId: string | undefined, flags: string[], delayMs = 250): void {
  if (!pendingBtwNotes.has(instanceId)) return
  setTimeout(() => {
    // The user pressed Stop: the notes stay queued (and visible in the chat) until they start
    // the chat again. Stopping must not be followed by a turn nobody asked for.
    if (processRegistry.wasStoppedByUser(instanceId)) return
    // An agent adopted after a restart is still working: its watcher flushes when it exits.
    if (processRegistry.isTracked(instanceId) || processRegistry.isAdopted(instanceId) || claimKind(chatKey(instanceId)) === 'turn') return
    if (claimKind(chatKey(instanceId)) === 'compact') { scheduleBtwFlush(instanceId, cwd, sessionId, flags, 2000); return }
    const notes = takePendingBtwNotes(instanceId)
    if (!notes.length) return
    sendMessage({ instanceId, text: notes.join('\n\n'), cwd, sessionId, flags, origin: 'btw' })
      .catch(err => {
        console.error(`[btw] follow-up send failed for ${instanceId}, notes kept for the next turn:`, (err as Error).message)
        // Back at the front, in their original order, ahead of anything queued meanwhile.
        pendingBtwNotes.set(instanceId, [...notes, ...(pendingBtwNotes.get(instanceId) ?? []).filter(n => !notes.includes(n))])
      })
  }, delayMs)
}

/** True when a /btw follow-up is queued for this chat, so it is about to be used again. */
export function hasPendingBtwNotes(instanceId: string): boolean {
  return (pendingBtwNotes.get(instanceId)?.length ?? 0) > 0
}

export function takePendingBtwNotes(instanceId: string): string[] {
  const arr = pendingBtwNotes.get(instanceId) ?? []
  pendingBtwNotes.delete(instanceId)
  return arr
}
