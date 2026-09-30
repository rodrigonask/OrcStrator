// Every event the server broadcasts over the WebSocket, with its payload.
//
// The boundary used to be `{ type: string; payload: unknown }` on the server and `(payload: any)`
// on the client, so an event renamed on one side, or a payload field renamed, was only found at
// runtime, as a feature that silently stopped updating. Both sides now name events through this
// map: an unknown event name is a compile error on either side, and the payloads below are the
// shapes the client actually reads.
//
// Where a payload is a raw database row or a loose bag the client only partly reads, it is typed
// as such (Record<string, unknown>) on purpose, rather than claiming a shape nobody enforces.

import type {
  AgentConfig, AppSettings, ClaudeProcessExitEvent, ClaudeStreamEvent, ChatMessage, FolderConfig,
  InstanceConfig, PipelineColumn, TaskRun, UsageData,
} from './types.js'

export interface WsEventMap {
  // Streaming output and process lifecycle
  'claude:output-batch': { instanceId: string; events: ClaudeStreamEvent[] }
  'claude:process-exit': ClaudeProcessExitEvent
  'turn:progress': { instanceId: string; startedAt: number; outputTokens: number }
  'cache:touch': { instanceId: string; at: number; cacheReadTokens?: number }
  'message:added': { instanceId: string; message: ChatMessage }
  'message:created': { instanceId: string; messageId: string }
  'history:cleared': { instanceId: string }
  'permission:resolved': { instanceId: string; requestId: string }
  'conflict:paused': { instanceId: string; path: string; holderName: string; holderInstanceId?: string }
  'conflict:ignore-updated': { ignoreUntil: number | null }
  // Chats
  'instance:created': InstanceConfig
  'instance:updated': Record<string, unknown>
  'instance:deleted': { id: string }
  'instance:state': { instanceId: string; state: InstanceConfig['state'] }
  'instance:surfaced': { instanceId: string; source: InstanceConfig['surfacedSource']; surfacedAt: number; instance?: InstanceConfig }
  'instance:awaiting-input': { instanceId: string; awaitingInput: 'question' | 'plan' | null; awaitingInputAt: number | null }
  'instance:overdrive': { instanceId: string; overdriveLevel?: number; overdriveTasks: number; overdriveStartedAt?: number; lastTaskAt?: number; savings?: unknown }
  'instances:reordered': { ids: string[] }
  'compaction:suggested': { instanceId: string; instanceName: string; ctxTokens: number; reason: 'cold' | 'quota'; minutesToCold?: number; usagePct?: number }
  'session:summary': { instanceId: string; instanceName?: string; taskId: string | null; taskTitle?: string | null; summary: string | null; ok: boolean; loggedAsNewTask: boolean }
  // Projects, cards, wake-ups
  'folder:created': FolderConfig
  'folder:updated': FolderConfig | Record<string, unknown>
  'folder:deleted': { id: string }
  'folders:reordered': { ids: string[] }
  'pipeline:updated': { projectId?: string; taskId: string; action: string; newColumn?: PipelineColumn; fromColumn?: PipelineColumn; [k: string]: unknown }
  'task:run-started': TaskRun
  'task:run-finished': TaskRun
  'wakeup:scheduled': { id: string; instanceId: string; fireAt: number; delaySeconds: number; prompt: string; reason: string | null; status: 'pending' | 'fired' | 'cancelled'; createdAt: number }
  'wakeup:cancelled': { instanceId: string; wakeupId: string }
  'wakeup:fired': { instanceId: string; wakeupId: string }
  // Settings, usage, agents, server health
  'settings:updated': Partial<AppSettings> | Record<string, unknown>
  'usage:plan-updated': UsageData | null
  'usage:alert': { bucket: string; pct: number; threshold: number }
  'agent:created': AgentConfig | Record<string, unknown>
  'agent:updated': AgentConfig | Record<string, unknown>
  'agent:deleted': { id: string }
  'server:error': { site: string; instanceId: string | null; message: string; detail: string; at: number }
}

export type WsEventName = keyof WsEventMap

/** Events the client's own socket wrapper raises; never sent by the server. */
export interface WsClientEventMap {
  connection: { connected: boolean; reconnected?: boolean }
  reconnected: Record<string, never>
}

export type WsBroadcast<K extends WsEventName = WsEventName> = { type: K; payload: WsEventMap[K] }
