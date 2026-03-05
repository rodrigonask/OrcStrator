import type { ClaudeStreamEvent } from '@nasklaude/shared'

export function parseStreamLine(line: string, instanceId: string): ClaudeStreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  // Try parsing as JSON
  let data: Record<string, unknown>
  try {
    data = JSON.parse(trimmed)
  } catch {
    // Non-JSON line = plain text output from Claude CLI
    return { type: 'text-delta', instanceId, text: trimmed + '\n' }
  }

  const eventType = data.type as string | undefined

  // system event — contains session info
  if (eventType === 'system') {
    return {
      type: 'system',
      instanceId,
      sessionId: data.session_id as string | undefined
    }
  }

  // content_block_start with tool_use
  if (eventType === 'content_block_start') {
    const contentBlock = data.content_block as Record<string, unknown> | undefined
    if (contentBlock?.type === 'tool_use') {
      return {
        type: 'tool-start',
        instanceId,
        toolId: contentBlock.id as string,
        toolName: contentBlock.name as string
      }
    }
    return null
  }

  // content_block_delta
  if (eventType === 'content_block_delta') {
    const delta = data.delta as Record<string, unknown> | undefined
    if (!delta) return null

    // text_delta
    if (delta.type === 'text_delta') {
      return {
        type: 'text-delta',
        instanceId,
        text: delta.text as string
      }
    }

    // input_json_delta (for tool input streaming)
    if (delta.type === 'input_json_delta') {
      return {
        type: 'tool-input-delta',
        instanceId,
        toolId: (data.index as string) ?? '',
        input: delta.partial_json as string ?? ''
      }
    }

    return null
  }

  // result event — final usage/cost
  if (eventType === 'result') {
    return {
      type: 'result',
      instanceId,
      sessionId: data.session_id as string | undefined,
      costUsd: data.cost_usd as number | undefined,
      inputTokens: data.input_tokens as number | undefined,
      outputTokens: data.output_tokens as number | undefined,
      durationMs: data.duration_ms as number | undefined
    }
  }

  // assistant message — full response (non-streaming mode or final message)
  if (eventType === 'assistant') {
    const message = data.message as Record<string, unknown> | undefined
    if (message) {
      const contentBlocks = message.content as Array<Record<string, unknown>> | undefined
      if (contentBlocks) {
        const textParts = contentBlocks
          .filter(b => b.type === 'text')
          .map(b => b.text as string)
          .join('')
        if (textParts) {
          return { type: 'text-delta', instanceId, text: textParts }
        }
      }
    }
    return null
  }

  // error event
  if (eventType === 'error') {
    const errorObj = data.error as Record<string, unknown> | undefined
    return {
      type: 'error',
      instanceId,
      message: (errorObj?.message as string) ?? (data.message as string) ?? 'Unknown error'
    }
  }

  // Unrecognized JSON — ignore
  return null
}
