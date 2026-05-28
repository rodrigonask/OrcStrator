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

export interface CliPromptData {
  instanceId: string
  eventType: string
  data: Record<string, unknown>
  receivedAt: number
}

export interface ScheduledWakeup {
  id: string
  instanceId: string
  fireAt: number
  delaySeconds: number
  prompt: string
  reason: string | null
  status: 'pending' | 'fired' | 'cancelled'
  createdAt: number
}

export interface MessagesContextValue {
  messages: Record<string, ChatMessage[]>
  hasMore: Record<string, boolean>
  streamingContent: Record<string, string>
  streamingToolCalls: Record<string, StreamingToolCall[]>
  unreadCounts: Record<string, number>
  rawOutput: Record<string, Array<{ line: string; isStderr?: boolean }>>
  cliPrompts: Record<string, CliPromptData>
  pendingCommand: Record<string, string>
  pendingWakeups: Record<string, ScheduledWakeup[]>
}

const defaultValue: MessagesContextValue = {
  messages: {},
  hasMore: {},
  streamingContent: {},
  streamingToolCalls: {},
  unreadCounts: {},
  rawOutput: {},
  cliPrompts: {},
  pendingCommand: {},
  pendingWakeups: {},
}

export const MessagesContext = createContext<MessagesContextValue>(defaultValue)

export function useMessages(): MessagesContextValue {
  return useContext(MessagesContext)
}
