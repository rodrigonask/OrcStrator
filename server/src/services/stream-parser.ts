import type { ClaudeStreamEvent } from '@nasklaude/shared'

export type ParseResult = ClaudeStreamEvent | ClaudeStreamEvent[] | null

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

export function createStreamParser(instanceId: string): (line: string) => ParseResult {
  // Maps content block index → toolId so input_json_delta events can be correlated
  const indexToToolId = new Map<number, string>()

  return function parseLine(line: string): ParseResult {
    const trimmed = line.trim()
    if (!trimmed) return null

    let data: Record<string, unknown>
    try {
      data = JSON.parse(trimmed)
    } catch {
      return { type: 'text-delta', instanceId, text: trimmed + '\n' }
    }

    const eventType = data.type as string | undefined

    if (eventType === 'system') {
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

      const events: ClaudeStreamEvent[] = []
      for (const block of contentBlocks) {
        if (block.type === 'tool_result') {
          events.push({
            type: 'tool-complete',
            instanceId,
            toolId: block.tool_use_id as string,
            output: flattenToolContent(block.content),
            isError: (block.is_error as boolean | undefined) ?? false
          })
        }
      }
      return events.length > 0 ? (events.length === 1 ? events[0] : events) : null
    }

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

    if (eventType === 'error') {
      const errorObj = data.error as Record<string, unknown> | undefined
      return {
        type: 'error',
        instanceId,
        message: (errorObj?.message as string) ?? (data.message as string) ?? 'Unknown error'
      }
    }

    return null
  }
}
