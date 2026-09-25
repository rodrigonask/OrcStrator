import type { ClaudeStreamEvent, PermissionRequestMeta } from '@orcstrator/shared'
import { formatRule, isPermissionUpdate } from '@orcstrator/shared'

export type ParseResult = ClaudeStreamEvent | ClaudeStreamEvent[] | null

const ANSI = /\[[0-9;]*[A-Za-z]/g

/** `matched_ask_rule` arrives as an object, `{ source, tool_name }`, not a rule string. */
function readMatchedRule(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const tool = typeof v.tool_name === 'string' ? v.tool_name : typeof v.toolName === 'string' ? v.toolName : null
  if (!tool) return undefined
  const content = typeof v.rule_content === 'string' ? v.rule_content : typeof v.ruleContent === 'string' ? v.ruleContent : null
  return formatRule(tool, content)
}

/**
 * Why a can_use_tool request is asking, camelCased. Every one of these used to be dropped here, and
 * they decide whether the banner can honestly offer "Allow always".
 *
 * Shapes as measured against CLI 2.1.272 (verified against the real CLI):
 *  - a request raised by an ask rule carries only `decision_reason_type: "rule"`, no rule text
 *  - an Edit under `.claude/` carried `decision_reason_type: "safetyCheck"`,
 *    `classifier_approvable: true`, a plain-English `decision_reason`, and `matched_ask_rule` as an
 *    OBJECT, `{ source: "flagSettings", tool_name: "Edit" }`
 *  - default-mode requests carry `permission_suggestions` (addRules, addDirectories, setMode) and
 *    `blocked_path`
 * `suppress_always_allow_rule` did not appear in any probe; it is read in case a CLI sends it.
 */
function permissionRequestMeta(req: Record<string, unknown>): PermissionRequestMeta {
  const meta: PermissionRequestMeta = {}
  if (Array.isArray(req.permission_suggestions)) {
    const updates = req.permission_suggestions.filter(isPermissionUpdate)
    if (updates.length > 0) meta.permissionSuggestions = updates
  }
  if (typeof req.blocked_path === 'string') meta.blockedPath = req.blocked_path
  if (typeof req.decision_reason === 'string') meta.decisionReason = req.decision_reason.replace(ANSI, '')
  if (typeof req.decision_reason_type === 'string') meta.decisionReasonType = req.decision_reason_type
  if (typeof req.classifier_approvable === 'boolean') meta.classifierApprovable = req.classifier_approvable
  if (typeof req.suppress_always_allow_rule === 'boolean') meta.suppressAlwaysAllowRule = req.suppress_always_allow_rule
  const matched = readMatchedRule(req.matched_ask_rule)
  if (matched) meta.matchedAskRule = matched
  return meta
}

function flattenToolContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
      .map(b => (b.type === 'text' ? (b.text as string) : ''))
      .join('')
  }
  return ''
}

export function createStreamParser(instanceId: string): (line: string, preParsed?: Record<string, unknown>) => ParseResult {
  // Maps content block index → toolId so input_json_delta events can be correlated
  const indexToToolId = new Map<number, string>()

  return function parseLine(line: string, preParsed?: Record<string, unknown>): ParseResult {
    const trimmed = line.trim()
    if (!trimmed) return null

    // The stdout handler in claude-process.ts already JSON.parses every line once
    // (for assistant handling); it hands the object in so the hot path — tool-result
    // lines run to ~1 MB — isn't parsed twice.
    let data: Record<string, unknown>
    if (preParsed !== undefined) {
      data = preParsed
    } else {
      try {
        data = JSON.parse(trimmed)
      } catch {
        return { type: 'text-delta', instanceId, text: trimmed + '\n' }
      }
    }

    const eventType = data.type as string | undefined

    if (eventType === 'system') {
      // Compaction detection — be defensive about field shape. Claude Code emits
      // a system event when it auto-compacts (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
      // threshold) or when the user runs /compact. The exact field name varies
      // by CLI version, so match on a union of plausible shapes.
      const subtype = (data.subtype as string | undefined) ?? ''
      const name = (data.name as string | undefined) ?? ''
      const level = (data.level as string | undefined) ?? ''
      const compactionType = (data.compactionType as string | undefined) ?? ''

      // LIVE-VERIFIED shape (CLI 2.1.170): /compact emits
      //   {type:"system", subtype:"status", status:"compacting"}            — start
      //   {type:"system", subtype:"status", status:null, compact_result:"success"|"failed", compact_error?} — end
      if (subtype === 'status' && 'compact_result' in data) {
        if (data.compact_result === 'success') {
          return { type: 'compaction', instanceId, trigger: 'manual', summary: undefined }
        }
        const err = (data.compact_error as string | undefined) ?? 'compact failed'
        return { type: 'text-delta', instanceId, text: `\n[Compact failed: ${err}]\n` }
      }
      if (subtype === 'status' && data.status === 'compacting') {
        return null // transient progress marker; the result event carries the outcome
      }

      const looksLikeCompaction =
        subtype.toLowerCase().includes('compact') ||
        name.toLowerCase().includes('compact') ||
        level === 'compaction' ||
        compactionType.length > 0
      if (looksLikeCompaction) {
        // Best-effort trigger inference: explicit field wins, else 'unknown'.
        // The auto-compact case (threshold-driven) is the most common in our
        // setup since we force CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80.
        let trigger: 'auto' | 'manual' | 'unknown' = 'unknown'
        const triggerHint = (
          (data.trigger as string | undefined) ??
          (data.cause as string | undefined) ??
          compactionType ??
          subtype ??
          name
        ).toLowerCase()
        if (triggerHint.includes('auto')) trigger = 'auto'
        else if (triggerHint.includes('manual') || triggerHint.includes('user') || triggerHint.includes('/compact')) trigger = 'manual'
        const summary =
          (typeof data.summary === 'string' ? data.summary : undefined) ??
          (typeof data.text === 'string' ? data.text : undefined) ??
          (typeof data.message === 'string' ? data.message : undefined)
        return { type: 'compaction', instanceId, trigger, summary }
      }
      return {
        type: 'system',
        instanceId,
        sessionId: data.session_id as string | undefined
      }
    }

    if (eventType === 'content_block_start') {
      const contentBlock = data.content_block as Record<string, unknown> | undefined
      if (contentBlock?.type === 'tool_use') {
        const toolId = contentBlock.id as string
        const index = data.index as number
        indexToToolId.set(index, toolId)
        return {
          type: 'tool-start',
          instanceId,
          toolId,
          toolName: contentBlock.name as string
        }
      }
      return null
    }

    if (eventType === 'content_block_delta') {
      const delta = data.delta as Record<string, unknown> | undefined
      if (!delta) return null

      if (delta.type === 'text_delta') {
        return { type: 'text-delta', instanceId, text: delta.text as string }
      }

      if (delta.type === 'input_json_delta') {
        const index = data.index as number
        const toolId = indexToToolId.get(index) ?? ''
        return {
          type: 'tool-input-delta',
          instanceId,
          toolId,
          input: (delta.partial_json as string) ?? ''
        }
      }

      return null
    }

    // user event — contains tool_result blocks when tools complete
    if (eventType === 'user') {
      const message = data.message as Record<string, unknown> | undefined
      const contentBlocks = message?.content as Array<Record<string, unknown>> | undefined
      if (!contentBlocks) return null

      // Subagent visibility: when the Task tool spawns a sidechain agent, all of its
      // emitted events carry `parent_tool_use_id` pointing at the parent Task tool_use.
      // Surface it so the client can render these events nested under the parent.
      const parentToolUseId = (data.parent_tool_use_id as string | undefined) ?? undefined

      const events: ClaudeStreamEvent[] = []
      for (const block of contentBlocks) {
        if (block.type === 'tool_result') {
          events.push({
            type: 'tool-complete',
            instanceId,
            toolId: block.tool_use_id as string,
            output: flattenToolContent(block.content),
            isError: (block.is_error as boolean | undefined) ?? false,
            ...(parentToolUseId ? { parentToolUseId } : {})
          })
        }
      }
      return events.length > 0 ? (events.length === 1 ? events[0] : events) : null
    }

    if (eventType === 'result') {
      indexToToolId.clear()
      const usage = data.usage as Record<string, unknown> | undefined
      // Total input = uncached + cache_creation + cache_read
      const rawInput = (usage?.input_tokens as number) ?? 0
      const cacheCreation = (usage?.cache_creation_input_tokens as number) ?? 0
      const cacheRead = (usage?.cache_read_input_tokens as number) ?? 0
      const totalInput = rawInput + cacheCreation + cacheRead
      const resultText = typeof data.result === 'string' ? data.result : undefined
      return {
        type: 'result',
        instanceId,
        sessionId: data.session_id as string | undefined,
        costUsd: (data.total_cost_usd ?? data.cost_usd) as number | undefined,
        inputTokens: totalInput || (data.input_tokens as number | undefined),
        outputTokens: (usage?.output_tokens ?? data.output_tokens) as number | undefined,
        durationMs: data.duration_ms as number | undefined,
        cacheCreationTokens: cacheCreation || undefined,
        cacheReadTokens: cacheRead || undefined,
        resultText,
        model: data.model as string | undefined,
      }
    }

    // 'assistant' events contain the full message including tool_use blocks.
    // content_block_start/delta events are NOT emitted by claude CLI stream-json format,
    // so we extract tool calls from assistant events to populate the ActivityBubble.
    if (eventType === 'assistant') {
      const message = data.message as Record<string, unknown> | undefined
      const contentBlocks = message?.content as Array<Record<string, unknown>> | undefined
      if (!contentBlocks) return null

      // Subagent visibility — same pattern as the `user` branch above.
      const parentToolUseId = (data.parent_tool_use_id as string | undefined) ?? undefined
      const parentAttr = parentToolUseId ? { parentToolUseId } : {}

      const events: ClaudeStreamEvent[] = []
      for (const block of contentBlocks) {
        if (block.type === 'text' && typeof block.text === 'string' && (block.text as string).trim()) {
          events.push({ type: 'text-delta', instanceId, text: block.text as string, ...parentAttr })
        }
        if (block.type === 'tool_use') {
          const toolId = block.id as string
          const toolName = block.name as string
          events.push({ type: 'tool-start', instanceId, toolId, toolName, ...parentAttr })
          if (block.input) {
            events.push({ type: 'tool-input-delta', instanceId, toolId, input: JSON.stringify(block.input), ...parentAttr })
          }
          // First-class events for the interactive tools the chat UI handles directly:
          // AskUserQuestion → ask-user card; ExitPlanMode → plan-presented card.
          // These ride alongside tool-start/tool-input-delta so the existing ToolCallBlock
          // still renders, but give the client a parsed, typed payload to bind UI to without
          // re-parsing the streaming JSON.
          if (toolName === 'AskUserQuestion') {
            const input = (block.input as Record<string, unknown>) ?? {}
            const questions = Array.isArray(input.questions) ? input.questions as unknown[] : []
            events.push({
              type: 'ask-user',
              instanceId,
              toolId,
              questions: questions as Array<{ question: string; header: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> }>,
              ...parentAttr,
            })
          } else if (toolName === 'ExitPlanMode') {
            const input = (block.input as Record<string, unknown>) ?? {}
            const plan = typeof input.plan === 'string' ? input.plan : undefined
            const allowedPrompts = Array.isArray(input.allowedPrompts)
              ? (input.allowedPrompts as Array<Record<string, unknown>>)
                  .filter(p => typeof p.tool === 'string' && typeof p.prompt === 'string')
                  .map(p => ({ tool: p.tool as string, prompt: p.prompt as string }))
              : undefined
            events.push({
              type: 'plan-presented',
              instanceId,
              toolId,
              ...(plan ? { plan } : {}),
              ...(allowedPrompts ? { allowedPrompts } : {}),
              ...parentAttr,
            })
          }
        }
      }
      return events.length > 0 ? (events.length === 1 ? events[0] : events) : null
    }

    if (eventType === 'error') {
      const errorObj = data.error as Record<string, unknown> | undefined
      return {
        type: 'error',
        instanceId,
        message: (errorObj?.message as string) ?? (data.message as string) ?? 'Unknown error'
      }
    }

    // Tool-permission request over the control protocol (--permission-prompt-tool stdio).
    // VERIFIED (CLI 2.1.181): { type:'control_request', request_id, request:{ subtype:'can_use_tool', tool_name, input, ... } }
    // request_id is TOP-LEVEL; the tool input field is `input` (not `tool_input`).
    if (eventType === 'control_request') {
      const req = data.request as Record<string, unknown> | undefined
      if (req?.subtype === 'can_use_tool') {
        if (process.env.ORCSTRATOR_VERBOSE) {
          console.log(`[permission-request] instance=${instanceId.slice(0, 8)} tool=${req.tool_name} req_id=${data.request_id}`)
        }
        return {
          type: 'permission-request',
          instanceId,
          requestId: data.request_id as string,
          toolName: (req.tool_name as string) ?? 'unknown',
          displayName: req.display_name as string | undefined,
          toolUseId: req.tool_use_id as string | undefined,
          description: req.description as string | undefined,
          input: (req.input as Record<string, unknown>) ?? {},
          ...permissionRequestMeta(req),
        }
      }
      // Other control_request subtypes are host→CLI; not expected inbound. Ignore so they
      // don't surface as a confusing generic cli-prompt.
      return null
    }

    if (!eventType) return null

    // Only genuinely INTERACTIVE events — ones where the CLI is blocked waiting on
    // stdin — may raise the attention banner.
    //
    // ALLOWLIST on purpose. This used to be a denylist (`!SILENT_EVENTS.has(eventType)`),
    // so every event type we hadn't enumerated popped a bogus "Claude CLI needs your
    // attention (<type>)" banner mid-run and flagged the instance as needing input.
    // `tool_progress` fires continuously while a tool runs, so any long turn spammed it.
    //
    // Matched by pattern rather than exact literals: a MISSED login prompt leaves the
    // instance silently stuck, so err toward surfacing anything auth/permission-shaped
    // (oauth_required, api_key_invalid, …). Everything else is informational — the CLI
    // either auto-handles it or it's telemetry.
    const INTERACTIVE_EVENT_RE =
      /(^|_)(login|logout|auth|oauth|api_key|apikey|credential|credentials|permission|approval|consent)(_|$)/i

    const eventSubtype = typeof data.subtype === 'string' ? data.subtype : ''
    const isInteractive =
      INTERACTIVE_EVENT_RE.test(eventType) || INTERACTIVE_EVENT_RE.test(eventSubtype)

    // Log everything that reaches here, surfaced or not — that's how new event shapes
    // get discovered and mapped to proper UI handlers.
    if (process.env.ORCSTRATOR_VERBOSE) {
      let dump: string
      try {
        dump = JSON.stringify(data).slice(0, 800)
      } catch {
        dump = '<unserializable>'
      }
      const tag = isInteractive ? 'cli-prompt' : 'cli-event-ignored'
      console.log(`[${tag}] instance=${instanceId.slice(0, 8)} eventType=${eventType} data=${dump}`)
    }

    if (!isInteractive) return null

    return {
      type: 'cli-prompt',
      instanceId,
      eventType,
      data: data as Record<string, unknown>
    }
  }
}
