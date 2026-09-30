import { createContext } from 'react'
import { createStore, useStoreSelector, useStoreState, type Store } from './store'
import type { ChatMessage, PermissionRequestData } from '@shared/types'

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
  /** Chats the user paged back through with "Load older"; their history is not capped. */
  pagedBack: Record<string, boolean>
  streamingContent: Record<string, string>
  streamingToolCalls: Record<string, StreamingToolCall[]>
  /** toolId -> result, per instance. Outlives the streaming buffers; see AppContext. */
  toolResults: Record<string, Record<string, { output: string; isError?: boolean }>>
  unreadCounts: Record<string, number>
  rawOutput: Record<string, Array<{ line: string; isStderr?: boolean }>>
  cliPrompts: Record<string, CliPromptData>
  /** Pending can_use_tool requests per chat, oldest first. A queue, not a slot: see AppContext. */
  permissionRequests: Record<string, PermissionRequestData[]>
  pendingCommand: Record<string, string>
  pendingWakeups: Record<string, ScheduledWakeup[]>
}

const defaultValue: MessagesContextValue = {
  messages: {},
  hasMore: {},
  pagedBack: {},
  streamingContent: {},
  streamingToolCalls: {},
  toolResults: {},
  unreadCounts: {},
  rawOutput: {},
  cliPrompts: {},
  permissionRequests: {},
  pendingCommand: {},
  pendingWakeups: {},
}

/**
 * The context value is a store whose identity never changes (see ./store.ts). Anything
 * rendered per chat (a Grid tile, a sidebar row, a message list) reads its own chat's entries
 * through useMessagesSelector, so another chat streaming does not re-render it.
 */
export type MessagesStore = Store<MessagesContextValue>

export function createMessagesStore(initial: MessagesContextValue = defaultValue): MessagesStore {
  return createStore(initial)
}

export const MessagesContext = createContext<MessagesStore>(createMessagesStore())

export function useMessagesSelector<T>(selector: (s: MessagesContextValue) => T, equal?: (a: T, b: T) => boolean): T {
  return useStoreSelector(MessagesContext, selector, equal)
}

/**
 * The WHOLE messages state: re-renders on every change of any chat. Only for components that
 * exist once and genuinely need several chats at once. Nothing rendered per chat may use it.
 */
export function useMessages(): MessagesContextValue {
  return useStoreState(MessagesContext)
}
