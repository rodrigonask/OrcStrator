import { createContext, useContext } from 'react'
import type { ChatMessage } from '@shared/types'

export interface StreamingToolCall {
  toolId: string
  toolName: string
  input: string
  output?: string
  isError?: boolean
  isRunning: boolean
}

export interface MessagesContextValue {
  messages: Record<string, ChatMessage[]>
  hasMore: Record<string, boolean>
  streamingContent: Record<string, string>
  streamingToolCalls: Record<string, StreamingToolCall[]>
  unreadCounts: Record<string, number>
  rawOutput: Record<string, Array<{ line: string; isStderr?: boolean }>>
}

const defaultValue: MessagesContextValue = {
  messages: {},
  hasMore: {},
  streamingContent: {},
  streamingToolCalls: {},
  unreadCounts: {},
  rawOutput: {},
}

export const MessagesContext = createContext<MessagesContextValue>(defaultValue)

export function useMessages(): MessagesContextValue {
  return useContext(MessagesContext)
}
