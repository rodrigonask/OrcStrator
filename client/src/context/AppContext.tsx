import React, { useReducer, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '../api'
import type {
  FolderConfig,
  InstanceConfig,
  AppSettings,
  ChatMessage,
  UsageData,
  ClaudeStreamEvent,
  ClaudeProcessExitEvent,
  VerbosityLevel,
  SessionCostState,
  PermissionRequestData,
} from '@shared/types'
import { vfxBus } from '../systems/vfx-bus'
import { notifyChatEvent } from '../utils/notifications'
import { soundEngine } from '../systems/sound-engine'
import { enqueueSurface, dropSurface, setSurfaceGate, pendingSurfaceIds } from '../systems/surface-queue'
import { InstancesContext } from './InstancesContext'
import { MessagesContext } from './MessagesContext'
import type { CliPromptData, ScheduledWakeup } from './MessagesContext'
import { UIContext } from './UIContext'
import type { ViewName, GridNotice, SecurityNotice, SessionLogResult } from './UIContext'
import { AppDispatchContext } from './AppDispatchContext'
import { useInstances } from './InstancesContext'
import { useMessages } from './MessagesContext'
import { useUI } from './UIContext'
import { useAppDispatch } from './AppDispatchContext'

/**
 * Backstop for the attention banner. The server's stream-parser is the primary gate
 * (see server/src/services/stream-parser.ts — it only emits `cli-prompt` for
 * auth/permission-shaped events), but the client shouldn't blindly trust ANY event
 * type to be worth interrupting the user for: a stale or older server build streams
 * whatever it likes, and raising this banner is expensive — it blocks the composer,
 * steals focus, flags the tile as input-needed, and fires a desktop notification.
 *
 * Deliberately duplicated rather than shared: this is a defensive narrowing, not the
 * source of truth, and it must keep working when the server disagrees.
 */
const INTERACTIVE_PROMPT_RE =
  /(^|_)(login|logout|auth|oauth|api_key|apikey|credential|credentials|permission|approval|consent)(_|$)/i

function isInteractivePrompt(eventType: string, data: Record<string, unknown>): boolean {
  const subtype = typeof data?.subtype === 'string' ? data.subtype : ''
  return INTERACTIVE_PROMPT_RE.test(eventType) || INTERACTIVE_PROMPT_RE.test(subtype)
}

// === State Slice Interfaces ===

interface InstancesSlice {
  folders: FolderConfig[]
  instances: InstanceConfig[]
  settings: AppSettings
}

interface MessagesSlice {
  messages: Record<string, ChatMessage[]>
  messageOrder: string[]
  hasMore: Record<string, boolean>
  streamingContent: Record<string, string>
  streamingToolCalls: Record<string, StreamingToolCall[]>
  /**
   * toolId -> what the call returned, kept per instance for the life of the tab.
   *
   * A tool result arrives once, on `tool-complete`, and until now it landed ONLY in
   * `streamingToolCalls`, which `CLEAR_STREAMING` wipes the instant the next assistant
   * message arrives. Nothing persists a `tool-result` block either, so `MessageList` built
   * its result map from message content and got an empty one every time. Every finished tool
   * call in the transcript therefore rendered with `output === undefined`, which is why
   * `PermissionDenialNote` had never appeared for anyone: `isDenial` needs `isError`, and
   * `isError` was never there to read (found by watching a real refusal in the app).
   *
   * Kept out of the DB deliberately. Tool output reaches ~1 MB a line, so persisting it would
   * be a storage decision, not a rendering one. This is memory for the open tab: results
   * survive the turn they came from, and a reload starts clean, which is what history already
   * did.
   */
  toolResults: Record<string, Record<string, { output: string; isError?: boolean }>>
  unreadCounts: Record<string, number>
  rawOutput: Record<string, Array<{ line: string; isStderr?: boolean }>>
  cliPrompts: Record<string, CliPromptData>
  /**
   * Pending can_use_tool requests per chat, oldest first.
   *
   * A queue, not one slot per chat. A single slot is overwritten by the second of two
   * concurrent requests (parallel tool calls, a subagent asking alongside its parent), so the first
   * is never answered and the turn hangs with a banner for the wrong call. A slot also has to be
   * cleared when the turn ends or the process dies, or a banner can outlive the process it was
   * for. Now: appended on arrival, removed by its own requestId when answered here or in another
   * tab, emptied when the turn ends or the process exits, and seeded from /state on load.
   */
  permissionRequests: Record<string, PermissionRequestData[]>
  pendingCommand: Record<string, string>
  pendingWakeups: Record<string, ScheduledWakeup[]>
}

interface UISlice {
  selectedInstanceId: string | null
  gridInstanceIds: string[]
  gridFocusOrder: string[]
  gridFocusedId: string | null
  gridMaximizedId: string | null
  gridNotice: GridNotice | null
  securityNotice: SecurityNotice | null
  /** Instances bumped out of a full grid (not manually closed) — the "Recent" list */
  gridEvicted: string[]
  sidebarCollapsed: boolean
  showFolderBrowser: boolean
  editingFolderId: string | null
  view: ViewName
  activePipelineId: string | null
  /** Task the pipeline board should open once that project's tasks have loaded. */
  pendingTaskFocusId: string | null
  connected: boolean
  serverRestarted: boolean
  serverBootTime: number | null
  usage: UsageData | null
  terminalPanelOpen: boolean
  showSettings: boolean
  verbosityOverrides: Record<string, VerbosityLevel>
  sessionCosts: Record<string, SessionCostState>
  historyErrors: Record<string, string>
}

export interface StreamingToolCall {
  toolId: string
  toolName: string
  input: string
  output?: string
  isError?: boolean
  isRunning: boolean
  parentToolUseId?: string
}

// === Combined State (for backward-compat useApp) ===

type State = InstancesSlice & MessagesSlice & UISlice

// === Actions ===

export type Action =
  | { type: 'SET_STATE'; payload: { folders: FolderConfig[]; instances: InstanceConfig[]; settings: AppSettings } }
  | { type: 'ADD_FOLDER'; payload: FolderConfig }
  | { type: 'REMOVE_FOLDER'; payload?: string; folderId?: string }
  | { type: 'UPDATE_FOLDER'; payload: { id: string; updates: Partial<FolderConfig> } }
  | { type: 'REORDER_FOLDERS'; payload: string[] }
  | { type: 'ADD_INSTANCE'; payload: InstanceConfig }
  | { type: 'REMOVE_INSTANCE'; payload: string }
  | { type: 'UPDATE_INSTANCE'; payload: { id: string; updates: Partial<InstanceConfig> } }
  | { type: 'REORDER_INSTANCES'; payload: { folderId: string; ids: string[] } }
  | { type: 'SELECT_INSTANCE'; payload: string | null }
  | { type: 'GRID_ADD'; payload: { id: string; maxTiles: number } }
  | { type: 'GRID_ADD_BACKGROUND'; payload: { id: string; maxTiles: number } }
  | { type: 'GRID_REORDER'; payload: { dragId: string; targetId: string } }
  | { type: 'GRID_REMOVE'; payload: string }
  | { type: 'GRID_TOUCH'; payload: string }
  | { type: 'GRID_MAXIMIZE'; payload: string | null }
  | { type: 'CLEAR_GRID_NOTICE' }
  | { type: 'SET_SECURITY_NOTICE'; payload: SecurityNotice }
  // `log: null` = the summary came back with nowhere to file it. Nothing to announce, but
  // it still resolves the notice that was waiting on it.
  | { type: 'SET_SESSION_LOG'; payload: { instanceId: string; name?: string; log: SessionLogResult | null } }
  | { type: 'CLEAR_SECURITY_NOTICE' }
  | { type: 'SET_MESSAGES'; payload: { instanceId: string; messages: ChatMessage[]; hasMore?: boolean } }
  | { type: 'PREPEND_MESSAGES'; payload: { instanceId: string; messages: ChatMessage[]; hasMore: boolean } }
  | { type: 'ADD_MESSAGE'; payload: ChatMessage }
  | { type: 'APPEND_STREAMING'; payload: { instanceId: string; text: string } }
  | { type: 'CLEAR_STREAMING'; payload: string }
  | { type: 'TOOL_START'; payload: { instanceId: string; toolId: string; toolName: string; parentToolUseId?: string } }
  | { type: 'TOOL_INPUT_DELTA'; payload: { instanceId: string; toolId: string; input: string; parentToolUseId?: string } }
  | { type: 'TOOL_COMPLETE'; payload: { instanceId: string; toolId: string; output: string; isError?: boolean; parentToolUseId?: string } }
  | { type: 'SET_MESSAGE_TOKENS'; payload: { instanceId: string; messageId: string; inputTokens?: number; outputTokens?: number; costUsd?: number } }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_VIEW'; payload: ViewName }
  | { type: 'SET_ACTIVE_PIPELINE'; payload: string | null }
  | { type: 'CLEAR_UNREAD'; payload: string }
  | { type: 'INCREMENT_UNREAD'; payload: string }
  | { type: 'SET_CONNECTED'; payload: boolean }
  | { type: 'SET_SERVER_BOOT_TIME'; payload: number }
  | { type: 'DISMISS_SERVER_RESTART' }
  | { type: 'SET_USAGE'; payload: UsageData | null }
  | { type: 'UPDATE_SETTINGS'; payload: Partial<AppSettings> }
  | { type: 'CLEAR_MESSAGES'; payload: string }
  | { type: 'TOGGLE_FOLDER'; folderId: string }
  | { type: 'OPEN_FOLDER_BROWSER' }
  | { type: 'CLOSE_FOLDER_BROWSER' }
  | { type: 'OPEN_PROJECT_EDIT'; folderId: string }
  | { type: 'CLOSE_PROJECT_EDIT' }
  | { type: 'SET_PIPELINE_PROJECT'; projectId: string | null }
  | { type: 'SET_PENDING_TASK_FOCUS'; taskId: string | null }
  | { type: 'TOGGLE_TERMINAL' }
  | { type: 'SET_TERMINAL_OPEN'; payload: boolean }
  | { type: 'OPEN_SETTINGS' }
  | { type: 'CLOSE_SETTINGS' }
  | { type: 'APPEND_RAW_LINE'; payload: { instanceId: string; line: string; isStderr?: boolean } }
  | { type: 'SET_CLI_PROMPT'; payload: CliPromptData }
  | { type: 'CLEAR_CLI_PROMPT'; payload: string }
  | { type: 'ADD_PERMISSION'; payload: PermissionRequestData }
  | { type: 'RESOLVE_PERMISSION'; payload: { instanceId: string; requestId: string } }
  | { type: 'CLEAR_PERMISSIONS'; payload: string }
  | { type: 'SEED_PERMISSIONS'; payload: Record<string, PermissionRequestData[]> }
  | { type: 'SET_PENDING_COMMAND'; payload: { instanceId: string; command: string } }
  | { type: 'CLEAR_PENDING_COMMAND'; payload: string }
  | { type: 'SET_INSTANCE_WAKEUPS'; payload: { instanceId: string; wakeups: ScheduledWakeup[] } }
  | { type: 'ADD_WAKEUP'; payload: ScheduledWakeup }
  | { type: 'REMOVE_WAKEUP'; payload: { instanceId: string; wakeupId: string } }
  | { type: 'SET_INSTANCE_VERBOSITY'; payload: { instanceId: string; level: VerbosityLevel | null } }
  | { type: 'SET_SESSION_COST'; payload: { instanceId: string; cost: SessionCostState } }
  | { type: 'TOUCH_SESSION_CACHE'; payload: { instanceId: string; at: number } }
  | { type: 'ACCUMULATE_TURN_COST'; payload: { instanceId: string; deltaCost: number; deltaInput: number; deltaOutput: number; deltaCacheRead: number; deltaCacheCreation: number } }
  | { type: 'RESET_SESSION_COST'; payload: string }
  | { type: 'SET_HISTORY_ERROR'; payload: { instanceId: string; error: string | null } }

// === Initial State ===

const initialInstances: InstancesSlice = {
  folders: [],
  instances: [],
  settings: {
    globalFlags: [],
    idleTimeoutSeconds: 60,
    notifications: true,
    startWithOS: false,
    rootFolder: '',
    usagePollMinutes: 1,
    theme: 'system',
    port: 3334,
  },
}

const initialMessages: MessagesSlice = {
  messages: {},
  messageOrder: [],
  hasMore: {},
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

const GRID_MAX_TILES = 12
const GRID_STORAGE_KEY = 'orcstrator.gridTiles'
const MAX_EVICTED_RECENT = 10

function loadStoredGrid(): { ids: string[]; maximizedId: string | null; evicted: string[] } {
  try {
    const v = JSON.parse(localStorage.getItem(GRID_STORAGE_KEY) || '[]')
    // Legacy format: bare array of ids
    if (Array.isArray(v)) {
      return { ids: v.filter((x): x is string => typeof x === 'string').slice(0, GRID_MAX_TILES), maximizedId: null, evicted: [] }
    }
    if (v && typeof v === 'object' && Array.isArray(v.ids)) {
      const ids = (v.ids as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, GRID_MAX_TILES)
      const maximizedId = typeof v.maximizedId === 'string' && ids.includes(v.maximizedId) ? v.maximizedId : null
      const evicted = Array.isArray(v.evicted)
        ? (v.evicted as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, MAX_EVICTED_RECENT)
        : []
      return { ids, maximizedId, evicted }
    }
    return { ids: [], maximizedId: null, evicted: [] }
  } catch {
    return { ids: [], maximizedId: null, evicted: [] }
  }
}

const storedGrid = loadStoredGrid()
const storedGridIds = storedGrid.ids

const initialUI: UISlice = {
  selectedInstanceId: null,
  gridInstanceIds: storedGridIds,
  gridFocusOrder: storedGridIds,
  gridFocusedId: null,
  gridMaximizedId: storedGrid.maximizedId,
  gridNotice: null,
  securityNotice: null,
  gridEvicted: storedGrid.evicted,
  sidebarCollapsed: false,
  showFolderBrowser: false,
  editingFolderId: null,
  view: 'grid',
  activePipelineId: null,
  pendingTaskFocusId: null,
  connected: false,
  serverRestarted: false,
  serverBootTime: null,
  usage: null,
  terminalPanelOpen: false,
  showSettings: false,
  verbosityOverrides: {},
  sessionCosts: {},
  historyErrors: {},
}

// === Reducers ===

function instancesReducer(state: InstancesSlice, action: Action): InstancesSlice {
  switch (action.type) {
    case 'SET_STATE':
      return { ...state, folders: action.payload.folders, instances: action.payload.instances, settings: action.payload.settings }
    case 'ADD_FOLDER':
      return { ...state, folders: [...state.folders, action.payload] }
    case 'REMOVE_FOLDER': {
      const fid = action.payload || action.folderId || ''
      return {
        ...state,
        folders: state.folders.filter(f => f.id !== fid),
        instances: state.instances.filter(i => i.folderId !== fid),
      }
    }
    case 'UPDATE_FOLDER':
      return { ...state, folders: state.folders.map(f => f.id === action.payload.id ? { ...f, ...action.payload.updates } : f) }
    case 'REORDER_FOLDERS': {
      const orderMap = new Map(action.payload.map((id, i) => [id, i]))
      return {
        ...state,
        folders: state.folders.map(f => orderMap.has(f.id) ? { ...f, sortOrder: orderMap.get(f.id)! } : f),
      }
    }
    case 'REORDER_INSTANCES': {
      const { folderId, ids } = action.payload
      const others = state.instances.filter(i => i.folderId !== folderId)
      const reordered = ids
        .map((id, index) => { const i = state.instances.find(i => i.id === id); return i ? { ...i, sortOrder: index } : null })
        .filter((i): i is InstanceConfig => i !== null)
      return { ...state, instances: [...others, ...reordered] }
    }
    case 'ADD_INSTANCE':
      // Idempotent. Whoever created the chat already added it optimistically, and the
      // server's instance:created broadcast then arrives saying the same thing. Two
      // copies of one chat in the sidebar is a worse bug than a dropped event.
      if (state.instances.some(i => i.id === action.payload.id)) return state
      return { ...state, instances: [...state.instances, action.payload] }
    case 'REMOVE_INSTANCE':
      return { ...state, instances: state.instances.filter(i => i.id !== action.payload) }
    case 'UPDATE_INSTANCE':
      return { ...state, instances: state.instances.map(i => i.id === action.payload.id ? { ...i, ...action.payload.updates } : i) }
    case 'TOGGLE_FOLDER':
      return { ...state, folders: state.folders.map(f => f.id === action.folderId ? { ...f, expanded: !f.expanded } : f) }
    case 'UPDATE_SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.payload } }
    default:
      return state
  }
}

function messagesReducer(state: MessagesSlice, action: Action): MessagesSlice {
  switch (action.type) {
    case 'SET_MESSAGES': {
      const MAX_CACHED_INSTANCES = 10
      const { instanceId: smId, messages: smMsgs, hasMore: smHasMore } = action.payload
      // Protected ids: the selected instance + every grid tile. These are visible
      // (or one click away) and must never lose their message cache.
      const protectIds: string[] = (action as any)._protectIds ?? []
      const order = state.messageOrder.filter(id => id !== smId)
      const newOrder = [...order, smId]
      let newMessages = { ...state.messages, [smId]: smMsgs }
      let finalOrder = newOrder
      let newHasMore = smHasMore !== undefined ? { ...state.hasMore, [smId]: smHasMore } : { ...state.hasMore }
      if (newOrder.length > MAX_CACHED_INSTANCES) {
        // Evict the oldest non-protected, non-incoming instance. If everything is
        // protected (selected + 8 grid tiles + incoming), allow exceeding the cap.
        const evict = newOrder.find(id => id !== smId && !protectIds.includes(id))
        if (evict) {
          const { [evict]: _ev, ...rest } = newMessages
          const { [evict]: _hm, ...restHM } = newHasMore
          newMessages = rest
          newHasMore = restHM
          finalOrder = newOrder.filter(id => id !== evict)
        }
      }
      return { ...state, messages: newMessages, messageOrder: finalOrder, hasMore: newHasMore }
    }
    case 'PREPEND_MESSAGES': {
      const { instanceId: pmId, messages: pmMsgs, hasMore: pmHasMore } = action.payload
      const existing = state.messages[pmId] || []
      return { ...state, messages: { ...state.messages, [pmId]: [...pmMsgs, ...existing] }, hasMore: { ...state.hasMore, [pmId]: pmHasMore } }
    }
    case 'ADD_MESSAGE': {
      const instId = action.payload.instanceId
      const existing = state.messages[instId] || []
      if (action.payload.id && existing.some(m => m.id === action.payload.id)) {
        return state
      }
      const updated = [...existing, action.payload]
      const capped = updated.length > 200 ? updated.slice(-200) : updated
      return { ...state, messages: { ...state.messages, [instId]: capped } }
    }
    case 'APPEND_STREAMING': {
      const { instanceId, text } = action.payload
      return { ...state, streamingContent: { ...state.streamingContent, [instanceId]: (state.streamingContent[instanceId] || '') + text } }
    }
    case 'CLEAR_STREAMING': {
      const { [action.payload]: _sc, ...restSC } = state.streamingContent
      const { [action.payload]: _stc, ...restSTC } = state.streamingToolCalls
      return { ...state, streamingContent: restSC, streamingToolCalls: restSTC }
    }
    case 'TOOL_START': {
      const { instanceId, toolId, toolName, parentToolUseId } = action.payload
      const existing = state.streamingToolCalls[instanceId] || []
      return { ...state, streamingToolCalls: { ...state.streamingToolCalls, [instanceId]: [...existing, { toolId, toolName, input: '', isRunning: true, ...(parentToolUseId ? { parentToolUseId } : {}) }] } }
    }
    case 'TOOL_INPUT_DELTA': {
      const { instanceId, toolId, input } = action.payload
      const calls = state.streamingToolCalls[instanceId] || []
      return { ...state, streamingToolCalls: { ...state.streamingToolCalls, [instanceId]: calls.map(c => c.toolId === toolId ? { ...c, input: c.input + input } : c) } }
    }
    case 'TOOL_COMPLETE': {
      const { instanceId, toolId, output, isError } = action.payload
      const calls = state.streamingToolCalls[instanceId] || []
      // Only the head is kept. Nothing downstream reads past the first few hundred
      // characters (the refusal explainer looks at 400), and a 1 MB build log held per
      // tool id for the life of the tab is a memory leak with a nice name.
      const kept = { output: output.length > 4000 ? output.slice(0, 4000) : output, isError }
      const forInstance = { ...(state.toolResults[instanceId] || {}), [toolId]: kept }
      return {
        ...state,
        streamingToolCalls: { ...state.streamingToolCalls, [instanceId]: calls.map(c => c.toolId === toolId ? { ...c, output, isError, isRunning: false } : c) },
        toolResults: { ...state.toolResults, [instanceId]: forInstance },
      }
    }
    case 'SET_MESSAGE_TOKENS': {
      const { instanceId, messageId, ...tokens } = action.payload
      const msgs = (state.messages[instanceId] || []).map(m => m.id === messageId ? { ...m, ...tokens } : m)
      return { ...state, messages: { ...state.messages, [instanceId]: msgs } }
    }
    case 'CLEAR_UNREAD': {
      const { [action.payload]: _, ...rest } = state.unreadCounts
      return { ...state, unreadCounts: rest }
    }
    case 'INCREMENT_UNREAD': {
      const id = action.payload
      return { ...state, unreadCounts: { ...state.unreadCounts, [id]: (state.unreadCounts[id] || 0) + 1 } }
    }
    case 'CLEAR_MESSAGES': {
      const { [action.payload]: _, ...restMessages } = state.messages
      const { [action.payload]: _r, ...restRaw } = state.rawOutput
      return { ...state, messages: restMessages, rawOutput: restRaw }
    }
    case 'APPEND_RAW_LINE': {
      const { instanceId, line, isStderr } = action.payload
      const current = state.rawOutput[instanceId] || []
      const entry = { line, isStderr }
      const next = current.length >= 2000 ? [...current.slice(-1999), entry] : [...current, entry]
      return { ...state, rawOutput: { ...state.rawOutput, [instanceId]: next } }
    }
    case 'SET_CLI_PROMPT': {
      return { ...state, cliPrompts: { ...state.cliPrompts, [action.payload.instanceId]: action.payload } }
    }
    case 'CLEAR_CLI_PROMPT': {
      const { [action.payload]: _, ...rest } = state.cliPrompts
      return { ...state, cliPrompts: rest }
    }
    case 'ADD_PERMISSION': {
      const { instanceId, requestId } = action.payload
      const queue = state.permissionRequests[instanceId] ?? []
      if (queue.some(r => r.requestId === requestId)) return state
      return { ...state, permissionRequests: { ...state.permissionRequests, [instanceId]: [...queue, action.payload] } }
    }
    case 'RESOLVE_PERMISSION': {
      const { instanceId, requestId } = action.payload
      const queue = state.permissionRequests[instanceId]
      if (!queue?.some(r => r.requestId === requestId)) return state
      const remaining = queue.filter(r => r.requestId !== requestId)
      if (remaining.length > 0) {
        return { ...state, permissionRequests: { ...state.permissionRequests, [instanceId]: remaining } }
      }
      const { [instanceId]: _q, ...others } = state.permissionRequests
      return { ...state, permissionRequests: others }
    }
    case 'CLEAR_PERMISSIONS': {
      if (!state.permissionRequests[action.payload]) return state
      const { [action.payload]: _p, ...rest } = state.permissionRequests
      return { ...state, permissionRequests: rest }
    }
    case 'SEED_PERMISSIONS': {
      // The server's list is the truth at load: it holds what each live process is blocked on.
      return { ...state, permissionRequests: action.payload }
    }
    case 'SET_PENDING_COMMAND': {
      const { instanceId, command } = action.payload
      return { ...state, pendingCommand: { ...state.pendingCommand, [instanceId]: command } }
    }
    case 'CLEAR_PENDING_COMMAND': {
      const { [action.payload]: _, ...rest } = state.pendingCommand
      return { ...state, pendingCommand: rest }
    }
    case 'SET_INSTANCE_WAKEUPS': {
      const { instanceId, wakeups } = action.payload
      return { ...state, pendingWakeups: { ...state.pendingWakeups, [instanceId]: wakeups } }
    }
    case 'ADD_WAKEUP': {
      const w = action.payload
      const existing = state.pendingWakeups[w.instanceId] || []
      return {
        ...state,
        pendingWakeups: { ...state.pendingWakeups, [w.instanceId]: [...existing.filter(x => x.id !== w.id), w] },
      }
    }
    case 'REMOVE_WAKEUP': {
      const { instanceId, wakeupId } = action.payload
      const existing = state.pendingWakeups[instanceId] || []
      const filtered = existing.filter(w => w.id !== wakeupId)
      return { ...state, pendingWakeups: { ...state.pendingWakeups, [instanceId]: filtered } }
    }
    default:
      return state
  }
}

function uiReducer(state: UISlice, action: Action): UISlice {
  switch (action.type) {
    case 'SELECT_INSTANCE':
      return { ...state, selectedInstanceId: action.payload }
    case 'GRID_ADD': {
      const { id, maxTiles } = action.payload
      if (state.gridInstanceIds.includes(id)) {
        // Already a tile — just focus it (touch). Also restore the grid if a tile
        // was maximized (a sidebar click always returns to the grid).
        return {
          ...state,
          gridFocusedId: id,
          gridMaximizedId: null,
          gridFocusOrder: [...state.gridFocusOrder.filter(x => x !== id), id],
          gridEvicted: state.gridEvicted.filter(x => x !== id),
        }
      }
      let ids = state.gridInstanceIds
      let order = state.gridFocusOrder.filter(x => ids.includes(x))
      let notice = state.gridNotice
      // Opening an instance clears it from Recent — it's active again
      let evicted = state.gridEvicted.filter(x => x !== id)
      if (ids.length >= Math.min(maxTiles, GRID_MAX_TILES)) {
        // Evict the rightmost tile (last in visual order) to make room. The bumped
        // tile becomes "Recent" so it's easy to get back to.
        const evict = ids[ids.length - 1]
        ids = ids.filter(x => x !== evict)
        order = order.filter(x => x !== evict)
        notice = { evictedId: evict, at: Date.now() }
        evicted = [evict, ...evicted.filter(x => x !== evict)].slice(0, MAX_EVICTED_RECENT)
      }
      return {
        ...state,
        gridInstanceIds: [...ids, id],
        gridFocusOrder: [...order, id],
        gridFocusedId: id,
        gridMaximizedId: null,
        gridNotice: notice,
        gridEvicted: evicted,
      }
    }
    // GRID_ADD without the "take me there" half: the tile is appended, but the focused
    // tile and any maximized tile stay exactly where they were. This is for chats opened
    // by something other than a click (starting a pipeline task), so the run is already
    // waiting in the grid the next time you look at it, and nothing moves under you in
    // the meantime.
    case 'GRID_ADD_BACKGROUND': {
      const { id, maxTiles } = action.payload
      if (state.gridInstanceIds.includes(id)) {
        return { ...state, gridEvicted: state.gridEvicted.filter(x => x !== id) }
      }
      let ids = state.gridInstanceIds
      let order = state.gridFocusOrder.filter(x => ids.includes(x))
      let notice = state.gridNotice
      let evicted = state.gridEvicted.filter(x => x !== id)
      if (ids.length >= Math.min(maxTiles, GRID_MAX_TILES)) {
        // Rightmost goes, as with a click-add, with ONE exception: never the tile the user is in.
        // A click-add appends and focuses, so the rightmost tile is usually the focused one,
        // and this add happens with nobody clicking (a scheduled card fired). Evicting
        // the tile whose composer holds a half-typed draft is focus theft by another
        // name, and a stale maximized id would block the surface queue's gate for the
        // whole session.
        const protectedIds = new Set([state.gridFocusedId, state.gridMaximizedId].filter((x): x is string => !!x))
        const evict = [...ids].reverse().find(x => !protectedIds.has(x)) ?? ids[ids.length - 1]
        ids = ids.filter(x => x !== evict)
        order = order.filter(x => x !== evict)
        notice = { evictedId: evict, at: Date.now() }
        evicted = [evict, ...evicted.filter(x => x !== evict)].slice(0, MAX_EVICTED_RECENT)
      }
      return {
        ...state,
        gridInstanceIds: [...ids, id],
        // Least-recently-focused, because it has never been focused at all.
        gridFocusOrder: [id, ...order],
        gridNotice: notice,
        gridEvicted: evicted,
        // Defensive: never leave a focused or maximized id pointing at a tile that is gone.
        gridFocusedId: state.gridFocusedId && !ids.includes(state.gridFocusedId) ? null : state.gridFocusedId,
        gridMaximizedId: state.gridMaximizedId && !ids.includes(state.gridMaximizedId) ? null : state.gridMaximizedId,
      }
    }
    case 'GRID_REORDER': {
      const { dragId, targetId } = action.payload
      if (dragId === targetId) return state
      const ids = [...state.gridInstanceIds]
      const from = ids.indexOf(dragId)
      const to = ids.indexOf(targetId)
      if (from === -1 || to === -1) return state
      ids.splice(from, 1)
      ids.splice(to, 0, dragId)
      return { ...state, gridInstanceIds: ids }
    }
    case 'GRID_REMOVE': {
      const id = action.payload
      if (!state.gridInstanceIds.includes(id)) return state
      return {
        ...state,
        gridInstanceIds: state.gridInstanceIds.filter(x => x !== id),
        gridFocusOrder: state.gridFocusOrder.filter(x => x !== id),
        gridFocusedId: state.gridFocusedId === id ? null : state.gridFocusedId,
        gridMaximizedId: state.gridMaximizedId === id ? null : state.gridMaximizedId,
        // Manually closing a tile must NOT surface it in Recent
        gridEvicted: state.gridEvicted.filter(x => x !== id),
      }
    }
    case 'GRID_MAXIMIZE': {
      const id = action.payload
      if (id !== null && !state.gridInstanceIds.includes(id)) return state
      return {
        ...state,
        gridMaximizedId: id,
        // Maximizing a tile also focuses it
        ...(id !== null
          ? { gridFocusedId: id, gridFocusOrder: [...state.gridFocusOrder.filter(x => x !== id), id] }
          : {}),
      }
    }
    case 'GRID_TOUCH': {
      const id = action.payload
      if (!state.gridInstanceIds.includes(id)) return state
      return {
        ...state,
        gridFocusedId: id,
        gridFocusOrder: [...state.gridFocusOrder.filter(x => x !== id), id],
      }
    }
    case 'CLEAR_GRID_NOTICE':
      return state.gridNotice ? { ...state, gridNotice: null } : state
    case 'SET_SECURITY_NOTICE': {
      // The summary can beat the scrub's own HTTP response back (different transports,
      // and the server starts the Haiku call the moment the response is on the wire), so
      // a log already attached to THIS instance's notice survives the scrub result
      // landing on top of it. Losing it would resurrect the second banner.
      const current = state.securityNotice
      const keptLog = current && current.id === action.payload.id ? current.log : undefined
      return {
        ...state,
        securityNotice: keptLog && !action.payload.log
          ? { ...action.payload, log: keptLog }
          : action.payload,
      }
    }
    // The background summary reporting back, seconds after the close. It MERGES into the
    // close notice that is already on screen rather than posting a second one: one close
    // is one thing that happened, and two banners in sequence meant dismissing the same
    // event twice (and reading whichever one you caught). The scrub banner waits for this
    // (see `pendingLog`), which is why it no longer needs the hand-over floor timer.
    //
    // Nothing to merge into means the notice was dismissed or timed out, and reopening a
    // banner someone already closed is the exact annoyance this removed. The desktop
    // notification still fires, and the summary is on the board either way.
    case 'SET_SESSION_LOG': {
      const { instanceId, name, log } = action.payload
      const current = state.securityNotice
      if (!current || current.id !== instanceId) return state
      return {
        ...state,
        securityNotice: {
          ...current,
          // Falls back to whatever the notice already had: LogLine reads an empty name as
          // "no title known" and picks its titleless wording.
          name: current.name || name || '',
          pendingLog: false,
          at: Date.now(),
          ...(log ? { log } : {}),
        },
      }
    }
    case 'CLEAR_SECURITY_NOTICE':
      return state.securityNotice ? { ...state, securityNotice: null } : state
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed }
    case 'SET_VIEW':
      return { ...state, view: action.payload }
    case 'SET_ACTIVE_PIPELINE':
      return { ...state, activePipelineId: action.payload }
    case 'SET_CONNECTED':
      return { ...state, connected: action.payload }
    case 'SET_SERVER_BOOT_TIME': {
      const prev = state.serverBootTime
      const restarted = prev !== null && prev !== action.payload
      return { ...state, serverBootTime: action.payload, serverRestarted: restarted || state.serverRestarted }
    }
    case 'DISMISS_SERVER_RESTART':
      return { ...state, serverRestarted: false }
    case 'SET_USAGE':
      return { ...state, usage: action.payload }
    case 'OPEN_FOLDER_BROWSER':
      return { ...state, showFolderBrowser: true }
    case 'CLOSE_FOLDER_BROWSER':
      return { ...state, showFolderBrowser: false }
    case 'OPEN_PROJECT_EDIT':
      return { ...state, editingFolderId: action.folderId }
    case 'CLOSE_PROJECT_EDIT':
      return { ...state, editingFolderId: null }
    case 'SET_PIPELINE_PROJECT':
      return { ...state, activePipelineId: action.projectId }
    case 'SET_PENDING_TASK_FOCUS':
      return { ...state, pendingTaskFocusId: action.taskId }
    case 'TOGGLE_TERMINAL':
      return { ...state, terminalPanelOpen: !state.terminalPanelOpen }
    case 'SET_TERMINAL_OPEN':
      return { ...state, terminalPanelOpen: action.payload }
    case 'OPEN_SETTINGS':
      return { ...state, showSettings: true }
    case 'CLOSE_SETTINGS':
      return { ...state, showSettings: false }
    case 'SET_INSTANCE_VERBOSITY': {
      const { instanceId, level } = action.payload
      if (level === null) {
        const { [instanceId]: _, ...rest } = state.verbosityOverrides
        return { ...state, verbosityOverrides: rest }
      }
      return { ...state, verbosityOverrides: { ...state.verbosityOverrides, [instanceId]: level } }
    }
    case 'SET_SESSION_COST': {
      // Hydration from the server replaces the whole entry, and the server's
      // lastCacheCreatedAt is derived from COMPLETED turns only, so it knows nothing about
      // mid-turn cache:touch. Clicking a chip during a long turn would therefore drag the
      // anchor BACKWARD and flip the chip to expired until the next touch, up to a minute
      // later. The anchor only ever moves forward.
      const { instanceId, cost } = action.payload
      const prevAt = state.sessionCosts[instanceId]?.lastCacheCreatedAt ?? 0
      const merged = (cost.lastCacheCreatedAt ?? 0) >= prevAt
        ? cost
        : { ...cost, lastCacheCreatedAt: prevAt }
      return { ...state, sessionCosts: { ...state.sessionCosts, [instanceId]: merged } }
    }
    case 'ACCUMULATE_TURN_COST': {
      const { instanceId, deltaCost, deltaInput, deltaOutput, deltaCacheRead, deltaCacheCreation } = action.payload
      const prev = state.sessionCosts[instanceId] || { totalCost: 0, totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheCreation: 0, turns: 0, recentCacheRate: 0 }
      const newInput = prev.totalInput + deltaInput
      const newCacheRead = prev.totalCacheRead + deltaCacheRead
      return {
        ...state,
        sessionCosts: {
          ...state.sessionCosts,
          [instanceId]: {
            totalCost: prev.totalCost + deltaCost,
            totalInput: newInput,
            totalOutput: prev.totalOutput + deltaOutput,
            totalCacheRead: newCacheRead,
            totalCacheCreation: prev.totalCacheCreation + deltaCacheCreation,
            turns: prev.turns + 1,
            recentCacheRate: newInput > 0 ? newCacheRead / newInput : 0,
            lastCacheCreatedAt: deltaCacheCreation > 0 ? Date.now() : prev.lastCacheCreatedAt,
          },
        },
      }
    }
    case 'TOUCH_SESSION_CACHE': {
      // The running turn just read the prompt cache, which restarts its TTL. Move the anchor
      // only; the hit RATIO stays as measured by completed turns, because a mid-turn step
      // does not tell us the turn's final input mix. If this instance has no cost entry yet
      // (a first turn, never opened), do NOT invent one: an entry with a fabricated ratio
      // would show a cache chip for a session that has never read cache. The running dot is
      // what keeps a first turn visible.
      const { instanceId, at } = action.payload
      const prev = state.sessionCosts[instanceId]
      if (!prev || (prev.lastCacheCreatedAt ?? 0) >= at) return state
      return {
        ...state,
        sessionCosts: { ...state.sessionCosts, [instanceId]: { ...prev, lastCacheCreatedAt: at } },
      }
    }
    case 'RESET_SESSION_COST': {
      const { [action.payload]: _, ...rest } = state.sessionCosts
      return { ...state, sessionCosts: rest }
    }
    case 'SET_HISTORY_ERROR': {
      const { instanceId, error } = action.payload
      if (error === null) {
        const { [instanceId]: _, ...rest } = state.historyErrors
        return { ...state, historyErrors: rest }
      }
      return { ...state, historyErrors: { ...state.historyErrors, [instanceId]: error } }
    }
    default:
      return state
  }
}

// === Provider ===

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [instState, instDispatch] = useReducer(instancesReducer, initialInstances)
  const [msgState, msgDispatch] = useReducer(messagesReducer, initialMessages)
  const [uiState, uiDispatch] = useReducer(uiReducer, initialUI)

  // Refs for stable cross-slice access inside callbacks/WS handlers
  const instStateRef = useRef(instState)
  instStateRef.current = instState
  const msgStateRef = useRef(msgState)
  msgStateRef.current = msgState
  const uiStateRef = useRef(uiState)
  uiStateRef.current = uiState

  // Combined dispatch: routes each action to the correct sub-reducer(s)
  const dispatch = useCallback((action: Action) => {
    switch (action.type) {
      // Instances slice
      case 'SET_STATE':
      case 'ADD_FOLDER':
      case 'UPDATE_FOLDER':
      case 'REORDER_FOLDERS':
      case 'TOGGLE_FOLDER':
      case 'ADD_INSTANCE':
      case 'UPDATE_INSTANCE':
      case 'REORDER_INSTANCES':
      case 'UPDATE_SETTINGS':
        instDispatch(action)
        break

      // Cross-cutting: REMOVE_FOLDER clears messages for all affected instances
      case 'REMOVE_FOLDER': {
        const fid = action.payload || action.folderId
        instStateRef.current.instances
          .filter(i => i.folderId === fid)
          .forEach(i => msgDispatch({ type: 'CLEAR_MESSAGES', payload: i.id }))
        instDispatch(action)
        break
      }

      // Cross-cutting: REMOVE_INSTANCE clears messages + deselects + removes its grid tile
      case 'REMOVE_INSTANCE':
        msgDispatch({ type: 'CLEAR_MESSAGES', payload: action.payload })
        instDispatch(action)
        if (uiStateRef.current.selectedInstanceId === action.payload) {
          uiDispatch({ type: 'SELECT_INSTANCE', payload: null })
        }
        uiDispatch({ type: 'GRID_REMOVE', payload: action.payload })
        // A glow owed to a chat that no longer exists can never drain (no tile will ever
        // mount), and would keep the Grid nav dot lit until a reload. Nothing is owed.
        dropSurface(action.payload)
        break

      // Messages slice
      case 'SET_MESSAGES': {
        // Attach selected + grid instances so the reducer never evicts a visible chat
        const protectIds = [
          ...(uiStateRef.current.selectedInstanceId ? [uiStateRef.current.selectedInstanceId] : []),
          ...uiStateRef.current.gridInstanceIds,
        ]
        msgDispatch({ ...action, _protectIds: protectIds } as any)
        break
      }
      case 'PREPEND_MESSAGES':
      case 'ADD_MESSAGE':
      case 'APPEND_STREAMING':
      case 'CLEAR_STREAMING':
      case 'TOOL_START':
      case 'TOOL_INPUT_DELTA':
      case 'TOOL_COMPLETE':
      case 'SET_MESSAGE_TOKENS':
      case 'CLEAR_MESSAGES':
      case 'APPEND_RAW_LINE':
      case 'CLEAR_UNREAD':
      case 'SET_CLI_PROMPT':
      case 'CLEAR_CLI_PROMPT':
      case 'ADD_PERMISSION':
      case 'RESOLVE_PERMISSION':
      case 'CLEAR_PERMISSIONS':
      case 'SEED_PERMISSIONS':
      case 'SET_PENDING_COMMAND':
      case 'CLEAR_PENDING_COMMAND':
      case 'SET_INSTANCE_WAKEUPS':
      case 'ADD_WAKEUP':
      case 'REMOVE_WAKEUP':
        msgDispatch(action)
        break

      // Cross-cutting: skip INCREMENT_UNREAD for the currently selected instance
      // and for instances visible as grid tiles while the grid view is active
      case 'INCREMENT_UNREAD': {
        const ui = uiStateRef.current
        // While a tile is maximized, the other tiles are hidden — only the maximized one counts as visible
        const visibleInGrid = ui.view === 'grid' && !ui.showSettings && ui.gridInstanceIds.includes(action.payload) &&
          (!ui.gridMaximizedId || ui.gridMaximizedId === action.payload)
        if (action.payload !== ui.selectedInstanceId && !visibleInGrid) {
          msgDispatch(action)
        }
        break
      }

      // Closing a tile by hand is as good as reading it: whatever glow it was owed is
      // dropped, so the Grid nav dot cannot stay lit for a tile the user just dismissed.
      case 'GRID_REMOVE': {
        dropSurface(action.payload)
        // Dismissing the tile is dismissing the surface: tell the server, or the next reload
        // would bring the tile straight back with a glow the user already waved away.
        const inst = instStateRef.current.instances.find(i => i.id === action.payload)
        if (inst?.surfacedAt != null) {
          instDispatch({ type: 'UPDATE_INSTANCE', payload: { id: inst.id, updates: { surfacedAt: undefined, surfacedSource: undefined } } })
          api.ackSurface(inst.id, inst.surfacedAt).catch(() => {})
        }
        uiDispatch(action)
        break
      }

      // UI slice
      case 'SELECT_INSTANCE':
      case 'GRID_ADD':
      case 'GRID_ADD_BACKGROUND':
      case 'GRID_REORDER':
      case 'GRID_TOUCH':
      case 'GRID_MAXIMIZE':
      case 'CLEAR_GRID_NOTICE':
      case 'SET_SECURITY_NOTICE':
      case 'SET_SESSION_LOG':
      case 'CLEAR_SECURITY_NOTICE':
      case 'TOGGLE_SIDEBAR':
      case 'SET_VIEW':
      case 'SET_ACTIVE_PIPELINE':
      case 'SET_CONNECTED':
      case 'SET_SERVER_BOOT_TIME':
      case 'DISMISS_SERVER_RESTART':
      case 'SET_USAGE':
      case 'OPEN_FOLDER_BROWSER':
      case 'CLOSE_FOLDER_BROWSER':
      case 'OPEN_PROJECT_EDIT':
      case 'CLOSE_PROJECT_EDIT':
      case 'SET_PIPELINE_PROJECT':
      case 'SET_PENDING_TASK_FOCUS':
      case 'TOGGLE_TERMINAL':
      case 'SET_TERMINAL_OPEN':
      case 'OPEN_SETTINGS':
      case 'CLOSE_SETTINGS':
      case 'SET_INSTANCE_VERBOSITY':
      case 'SET_SESSION_COST':
      case 'ACCUMULATE_TURN_COST':
      case 'TOUCH_SESSION_CACHE':
      case 'RESET_SESSION_COST':
      case 'SET_HISTORY_ERROR':
        uiDispatch(action)
        break

      // This router is a whitelist with no fallthrough, so an action that is defined in the
      // union but never listed here is silently DROPPED - it type-checks, it dispatches, and
      // nothing happens. That cost a full debugging round on TOUCH_SESSION_CACHE (the event
      // arrived, the reducer was correct, the action just never reached a reducer). Make the
      // next one loud instead of invisible.
      default:
        if (import.meta.env.DEV) {
          console.warn(`[AppContext] dispatch: no route for action "${(action as { type: string }).type}": it was dropped. Add it to a slice in this switch.`)
        }
        break
    }
  }, []) // sub-dispatchers from useReducer are stable

  // Desktop notification helper: fires only when the window is unfocused
  // or the event's instance isn't the currently selected chat.
  // Gated by settings.notifications; throttled per-instance in notifyChatEvent.
  const maybeNotify = useCallback((instanceId: string, makeBody: (name: string) => string) => {
    if (!instStateRef.current.settings.notifications) return
    const isSelected = uiStateRef.current.selectedInstanceId === instanceId
    if (document.hasFocus() && isSelected) return
    const inst = instStateRef.current.instances.find(i => i.id === instanceId)
    const name = inst?.name ?? 'Agent'
    const fired = notifyChatEvent({
      instanceId,
      title: 'OrcStrator',
      body: makeBody(name),
      onClick: () => selectInstance(instanceId),
    })
    // Notification ping (tier-gated inside soundEngine; same throttle as the notification)
    if (fired) soundEngine.play('messageReceived')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch initial state and connect WebSocket
  useEffect(() => {
    let mounted = true
    api.getState().then((data) => {
      if (mounted) {
        dispatch({ type: 'SET_STATE', payload: data })
        dispatch({ type: 'SEED_PERMISSIONS', payload: data.pendingPermissions ?? {} })
      }
    }).catch((err) => console.error('Failed to fetch initial state:', err))

    api.getUsage().then((usage) => {
      if (mounted) dispatch({ type: 'SET_USAGE', payload: usage })
    }).catch(() => {})

    api.connect()
    return () => { mounted = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to WebSocket events
  useEffect(() => {
    const unsubs: Array<() => void> = []

    unsubs.push(
      api.onConnection((payload: { connected: boolean; reconnected?: boolean }) => {
        dispatch({ type: 'SET_CONNECTED', payload: payload.connected })
        if (payload.connected) {
          // Check server boot time to detect restarts
          api.getHealth().then(health => {
            dispatch({ type: 'SET_SERVER_BOOT_TIME', payload: health.bootTime })
          }).catch(() => {})

          if (payload.reconnected) {
            // Re-sync full instance state — WS events missed while disconnected can
            // leave instances wedged in 'running' (optimistic state never corrected).
            api.getState().then((data) => {
              dispatch({ type: 'SET_STATE', payload: data })
              // Requests answered or raised while the socket was down are only right on the server.
              dispatch({ type: 'SEED_PERMISSIONS', payload: data.pendingPermissions ?? {} })
              // Flush orphaned streaming buffers for instances the server says are idle —
              // otherwise a ghost "streaming" bubble sticks around forever.
              for (const inst of data.instances) {
                if (inst.state !== 'running' &&
                    (msgStateRef.current.streamingContent[inst.id] !== undefined ||
                     msgStateRef.current.streamingToolCalls[inst.id] !== undefined)) {
                  dispatch({ type: 'CLEAR_STREAMING', payload: inst.id })
                }
              }
            }).catch((err) => console.error('Failed to re-sync state after reconnect:', err))

            if (uiStateRef.current.selectedInstanceId) {
              const id = uiStateRef.current.selectedInstanceId
              api.getHistory(id, { limit: 150 }).then((data) => {
                const messages = (data as any).messages ?? data
                const hasMore = (data as any).hasMore ?? false
                dispatch({ type: 'SET_MESSAGES', payload: { instanceId: id, messages, hasMore } })
              }).catch(() => {})
              api.getSessionCostSummary(id).then((cost) => {
                dispatch({ type: 'SET_SESSION_COST', payload: { instanceId: id, cost } })
              }).catch(() => {})
            }
          }
        }
      })
    )

    unsubs.push(
      api.onClaudeOutputBatch((payload: { instanceId: string; events: ClaudeStreamEvent[] }) => {
        const { instanceId, events } = payload
        // Process assistant-message first to clear streaming before any trailing text-deltas
        // (the server parser may emit text-delta events from the same assistant line)
        const hasAssistantMsg = events.some(e => e.type === 'assistant-message')
        // A completed turn means nothing is blocked on stdin, so any attention banner is
        // stale by definition. Without this it only cleared on dismiss/send/process-exit,
        // so one banner stuck to the composer for the rest of the session.
        if (events.some(e => e.type === 'result')) {
          dispatch({ type: 'CLEAR_CLI_PROMPT', payload: instanceId })
          // Permission requests are NOT cleared here. A result ends one turn, not the process: a
          // background agent can still be waiting on an answer, and the server keeps its request
          // queued. Dropping the card here hid a live request behind a tile that said "running".
          // Requests leave on permission:resolved (answered, or withdrawn by the CLI) and on exit.
        }
        let streamingCleared = false
        for (const event of events) {
          if (event.type === 'text-delta') {
            // Skip text-delta events that arrive after assistant-message in the same batch —
            // these are redundant re-emissions from the parser and would re-populate streaming
            if (streamingCleared) continue
            dispatch({ type: 'APPEND_STREAMING', payload: { instanceId, text: event.text } })
          } else if (event.type === 'tool-start') {
            if (streamingCleared) continue
            dispatch({ type: 'TOOL_START', payload: { instanceId, toolId: event.toolId, toolName: event.toolName, parentToolUseId: event.parentToolUseId } })
          } else if (event.type === 'tool-input-delta') {
            if (streamingCleared) continue
            dispatch({ type: 'TOOL_INPUT_DELTA', payload: { instanceId, toolId: event.toolId, input: event.input, parentToolUseId: event.parentToolUseId } })
          } else if (event.type === 'tool-complete') {
            dispatch({ type: 'TOOL_COMPLETE', payload: { instanceId, toolId: event.toolId, output: event.output, isError: event.isError, parentToolUseId: event.parentToolUseId } })
          } else if (event.type === 'raw-line') {
            if (uiStateRef.current.terminalPanelOpen) {
              dispatch({ type: 'APPEND_RAW_LINE', payload: { instanceId, line: event.line, isStderr: event.isStderr } })
            }
          } else if (event.type === 'assistant-message') {
            dispatch({ type: 'ADD_MESSAGE', payload: event.message })
            dispatch({ type: 'CLEAR_STREAMING', payload: instanceId })
            streamingCleared = true
          } else if (event.type === 'cli-prompt') {
            // Ignore non-interactive events outright — no banner, no notification.
            if (isInteractivePrompt(event.eventType, event.data)) {
              dispatch({ type: 'SET_CLI_PROMPT', payload: { instanceId, eventType: event.eventType, data: event.data, receivedAt: Date.now() } })
              maybeNotify(instanceId, name => `${name} needs your input`)
            }
          } else if (event.type === 'permission-request') {
            // Every field rides through, the why-fields included: the banner decides from them
            // whether "Allow always" can honestly be offered.
            const { type: _type, ...request } = event
            dispatch({ type: 'ADD_PERMISSION', payload: { ...request, instanceId, receivedAt: Date.now() } })
            maybeNotify(instanceId, name => `${name} needs permission`)
          } else if (event.type === 'ask-user') {
            // Interactive AskUserQuestion card is rendered by ToolCallBlock from the
            // tool-start + tool-input-delta stream; here we just nudge the user.
            maybeNotify(instanceId, name => `${name} is asking a question`)
          } else if (event.type === 'plan-presented') {
            // Same — ExitPlanMode card is rendered by ToolCallBlock; nudge only.
            maybeNotify(instanceId, name => `${name} presented a plan for review`)
          } else if (event.type === 'compaction') {
            // Mirror what Claude Code shows in its TUI: drop a small system marker into
            // the chat so the user knows context was summarized. Reset the context gauge —
            // the next turn's result event records the true post-compact size — and stamp
            // ctxCompactedAt so the gauge can flash "Compacted ✓" briefly.
            dispatch({
              type: 'UPDATE_INSTANCE',
              payload: { id: instanceId, updates: { ctxTokens: 0, ctxCompactedAt: Date.now() } },
            })
            const body = event.summary
              ? `[Context compacted — older messages summarized: ${event.summary}]`
              : '[Context compacted — older messages summarized]'
            dispatch({
              type: 'ADD_MESSAGE',
              payload: {
                id: `compaction-${instanceId}-${Date.now()}`,
                instanceId,
                role: 'system',
                content: [{ type: 'text', text: body }],
                createdAt: Date.now(),
              },
            })
            if (instStateRef.current.settings.soundsEnabled) {
              soundEngine.play('messageReceived')
            }
          } else if (event.type === 'error') {
            maybeNotify(instanceId, name => `${name} hit an error`)
          } else if (event.type === 'result' && event.inputTokens !== undefined) {
            // NOT the gauge. event.inputTokens is summed across every request in the turn,
            // so it is a turn cost, not context occupancy: this line used to set ctxTokens
            // from it and put numbers like 1.86M on a 1M-window tile. The gauge is now owned
            // by the server, which writes a single request's prompt size live during the
            // turn and pushes it as instance:updated. Only the model and the hover
            // breakdown are set here.
            const updates: Record<string, unknown> = {}
            if (event.model) updates.ctxModel = event.model
            // Last-turn breakdown for the gauge hover tooltip. `input` = COLD input only.
            const cacheRead = event.deltaCacheReadTokens ?? event.cacheReadTokens ?? 0
            const cacheCreation = event.deltaCacheCreationTokens ?? event.cacheCreationTokens ?? 0
            updates.lastTurnUsage = {
              input: Math.max(0, (event.inputTokens ?? 0) - cacheRead - cacheCreation),
              cacheRead,
              cacheCreation,
              output: event.deltaOutputTokens ?? event.outputTokens ?? 0,
            }
            dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instanceId, updates } })
            // Accumulate per-turn cost for live session display
            if (event.deltaCostUsd !== undefined) {
              dispatch({
                type: 'ACCUMULATE_TURN_COST',
                payload: {
                  instanceId,
                  deltaCost: event.deltaCostUsd ?? 0,
                  deltaInput: event.deltaInputTokens ?? 0,
                  deltaOutput: event.deltaOutputTokens ?? 0,
                  deltaCacheRead: event.deltaCacheReadTokens ?? 0,
                  deltaCacheCreation: event.deltaCacheCreationTokens ?? 0,
                },
              })
            }
          }
        }
      })
    )

    // A request was answered, in this tab or another: drop it everywhere, so a second tab does not
    // keep offering a banner for a call that has already run.
    unsubs.push(
      api.onEvent('permission:resolved', (payload: { instanceId: string; requestId: string }) => {
        dispatch({ type: 'RESOLVE_PERMISSION', payload })
      })
    )

    unsubs.push(
      api.onClaudeProcessExit((payload: ClaudeProcessExitEvent) => {
        const { instanceId } = payload
        dispatch({ type: 'CLEAR_STREAMING', payload: instanceId })
        dispatch({ type: 'CLEAR_CLI_PROMPT', payload: instanceId })
        // The process is gone, so nothing it was blocked on can be answered any more.
        dispatch({ type: 'CLEAR_PERMISSIONS', payload: instanceId })
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instanceId, updates: { state: 'idle', activeTaskId: undefined, activeTaskTitle: undefined, taskStartedAt: undefined, turnStartedAt: undefined, turnOutputTokens: undefined } } })
        maybeNotify(instanceId, name => `${name} finished`)
        // Refetch history so the final message appears. Retry once after 1.5s;
        // on persistent failure surface a dismissible banner instead of failing silently.
        const fetchHistory = () => api.getHistory(instanceId, { limit: 150 }).then((data) => {
          const messages = (data as any).messages ?? data
          const hasMore = (data as any).hasMore ?? false
          dispatch({ type: 'SET_MESSAGES', payload: { instanceId, messages, hasMore } })
          dispatch({ type: 'SET_HISTORY_ERROR', payload: { instanceId, error: null } })
        })
        fetchHistory().catch(() => {
          setTimeout(() => {
            fetchHistory().catch(() => {
              dispatch({
                type: 'SET_HISTORY_ERROR',
                payload: { instanceId, error: 'Failed to load the latest messages — the final reply may be missing. Reselect the chat or reload to retry.' },
              })
            })
          }, 1500)
        })
      })
    )

    unsubs.push(api.onUsageUpdated((payload: any) => dispatch({ type: 'SET_USAGE', payload })))

    // Plan-limit threshold alerts (server gates these on settings.notifications and
    // fires each threshold once per crossing)
    unsubs.push(
      api.onUsageAlert((payload: { bucket: string; pct: number; threshold: number }) => {
        const emoji = payload.threshold >= 95 ? '⚠️' : payload.threshold >= 80 ? '⚡' : 'ℹ️'
        notifyChatEvent({
          instanceId: `plan-limit-${payload.bucket}`,
          title: `${emoji} Claude ${payload.bucket} hit ${payload.threshold}%`,
          body: `${payload.bucket} usage is now at ${Math.round(payload.pct)}%`,
        })
      })
    )

    // Cache advisor: offer (never auto) to compact a heavy idle session that's about to
    // go cold, or when the 5-hour quota is high. Click the notification to compact.
    unsubs.push(
      api.onEvent('compaction:suggested', (payload: { instanceId: string; instanceName: string; ctxTokens: number; reason: 'cold' | 'quota'; minutesToCold?: number; usagePct?: number }) => {
        const k = Math.round((payload.ctxTokens || 0) / 1000)
        const why = payload.reason === 'quota'
          ? `5-hour usage at ${payload.usagePct ?? '—'}%`
          : `cache goes cold in ~${payload.minutesToCold ?? 0}m`
        notifyChatEvent({
          instanceId: `compact-${payload.instanceId}`,
          title: `🗜 Compact "${payload.instanceName}"?`,
          body: `${k}k-token context · ${why}. Compacting now makes the next start cheaper. Click to compact.`,
          onClick: () => { api.compactInstance(payload.instanceId).catch(() => {}) },
        })
      })
    )

    unsubs.push(
      api.onEvent('wakeup:scheduled', (payload: ScheduledWakeup) => {
        dispatch({ type: 'ADD_WAKEUP', payload })
      })
    )
    unsubs.push(
      api.onEvent('wakeup:cancelled', (payload: { instanceId: string; wakeupId: string }) => {
        dispatch({ type: 'REMOVE_WAKEUP', payload })
      })
    )
    unsubs.push(
      api.onEvent('wakeup:fired', (payload: { instanceId: string; wakeupId: string }) => {
        dispatch({ type: 'REMOVE_WAKEUP', payload })
      })
    )

    // A chat the SERVER created on its own: the task-runner starting a pipeline task, or
    // an agent edit session. Without this listener a started task would spawn a chat that
    // did not exist for the client at all until the next page load, and the grid would have
    // nothing to render even after it was told to open a tile for it.
    unsubs.push(
      api.onEvent('instance:created', (payload: InstanceConfig) => {
        if (!payload?.id) return
        dispatch({ type: 'ADD_INSTANCE', payload })
      })
    )

    unsubs.push(
      api.onEvent('instance:updated', (payload: Record<string, unknown>) => {
        if (!payload.id) return
        const id = payload.id as string
        const updates: Record<string, unknown> = {}
        const fields = ['state', 'sessionId', 'name', 'sortOrder', 'agentId',
          'idleRestartMinutes', 'overdriveTasks', 'overdriveStartedAt', 'lastTaskAt',
          'dirtyCount', 'keepWarm', 'ctxTokens', 'nativeTasks', 'lastTurnMs', 'maxTurnMs',
          'lastTurnMessageId', 'awaitingInput', 'awaitingInputAt',
          // A surface-ack from any tab clears the bright status in every tab.
          'surfacedAt', 'surfacedSource',
          // Without it a grant saved in one tab never reaches any other, so the
          // Grid tab keeps diagnosing a refusal as "hook or CLI" with the rule already in the DB.
          // The PUT broadcast sends null (not undefined) when cleared, so the key survives JSON
          // and the `?? undefined` below clears the field. Absent key = partial event, leave it.
          'permissionRules']
        for (const f of fields) {
          if (f in payload) updates[f] = payload[f] ?? undefined
        }
        // Clear task metadata only when the server EXPLICITLY reports the session ended
        // (sessionId key present and null). Partial broadcasts — dirtyCount / keepWarm /
        // ctxTokens — omit sessionId entirely and must NOT wipe task metadata.
        if ('sessionId' in payload && payload.sessionId == null) {
          updates.sessionId = undefined
          updates.activeTaskId = undefined
          updates.activeTaskTitle = undefined
          updates.taskStartedAt = undefined
        }
        // Acked before its glow ever played (read in another tab, say): nothing is owed.
        if ('surfacedAt' in payload && payload.surfacedAt == null) dropSurface(id)
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates } })
      })
    )

    // A SCHEDULED fire (a card carrying a schedule, or a wake-up) surfaced a chat. This is
    // the one signal the grid behaviour keys on. NOT instance:created: a scheduled card
    // firing on its own existing chat never emits that, and that is the common case. The
    // handler only puts the fact on the instance; the surfaces effect below turns it into
    // a tile and a queued glow, the same way it does for a surface found in /api/state on
    // a cold open.
    unsubs.push(
      api.onEvent('instance:surfaced', (payload: { instanceId: string; source: InstanceConfig['surfacedSource']; surfacedAt: number; instance?: InstanceConfig }) => {
        if (!payload?.instanceId || !payload.surfacedAt) return
        const known = instStateRef.current.instances.some(i => i.id === payload.instanceId)
        if (!known && payload.instance) dispatch({ type: 'ADD_INSTANCE', payload: payload.instance })
        dispatch({
          type: 'UPDATE_INSTANCE',
          payload: { id: payload.instanceId, updates: { surfacedAt: payload.surfacedAt, surfacedSource: payload.source } },
        })
      })
    )

    // Authoritative running/idle/paused transitions from the server. Covers turns the
    // client didn't initiate (scheduled cards, wake-ups, task-runner, auto-retry). Without
    // this, an autonomously-started turn would never flip the instance to 'running'.
    unsubs.push(
      api.onEvent('instance:state', (payload: { instanceId: string; state: InstanceConfig['state'] }) => {
        if (!payload?.instanceId) return
        const updates: Partial<InstanceConfig> = { state: payload.state }
        // Turn over → drop the live elapsed/token counter.
        if (payload.state !== 'running') {
          updates.turnStartedAt = undefined
          updates.turnOutputTokens = undefined
        }
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id: payload.instanceId, updates } })
      })
    )

    // Live turn progress: elapsed-timer start + running output-token count for the composer.
    unsubs.push(
      api.onEvent('turn:progress', (payload: { instanceId: string; startedAt: number; outputTokens: number }) => {
        if (!payload?.instanceId) return
        dispatch({
          type: 'UPDATE_INSTANCE',
          payload: { id: payload.instanceId, updates: { turnStartedAt: payload.startedAt, turnOutputTokens: payload.outputTokens } },
        })
      })
    )

    // VFX: pipeline events
    unsubs.push(
      api.onPipelineUpdated((payload: any) => {
        if (payload?.action === 'moved') {
          if (payload.newColumn === 'done') {
            vfxBus.fire('task:completed', { text: 'DONE!' })
          } else {
            vfxBus.fire('task:moved')
          }
        } else if (payload?.action === 'created') {
          vfxBus.fire('task:created')
        }
      })
    )

    // The close-time summary landed. The server has broadcast this since the feature
    // shipped, but nothing subscribed to it, so a close reported the transcript scrub and
    // stayed silent about the thing the user actually cares about: that the work got
    // written down.
    //
    // ONE surface: the in-app banner, and nothing else. This used to also fire a desktop
    // notification "for anyone who has walked away from the screen", which in practice
    // meant every close stacked a Windows toast on top of the banner saying the same
    // thing, so the close still had to be read twice. A close is initiated by hand, at
    // the screen, so the person is by definition looking at the app when it happens.
    unsubs.push(
      api.onEvent('session:summary', (payload: {
        instanceId: string
        instanceName?: string
        taskId: string | null
        taskTitle?: string | null
        summary: string | null
        ok: boolean
        loggedAsNewTask: boolean
      }) => {
        // Nowhere to file it (mode 'tasks' with a task-less chat, or the task was deleted
        // mid-close) means there is nothing to announce — but the close notice may be
        // sitting there waiting on this event, so it still has to be told to stop.
        if (!payload.taskId) {
          dispatch({ type: 'SET_SESSION_LOG', payload: { instanceId: payload.instanceId, log: null } })
          return
        }

        const log: SessionLogResult = {
          taskId: payload.taskId,
          ok: payload.ok,
          loggedAsNewTask: payload.loggedAsNewTask,
          taskTitle: payload.taskTitle,
        }
        // Straight in, no hand-over timer. It merges into the close notice instead of
        // replacing it, so an early summary (measured: ~1.3s on a short chat) no longer
        // yanks the scrub line off screen before it can be read.
        dispatch({
          type: 'SET_SESSION_LOG',
          payload: { instanceId: payload.instanceId, name: payload.instanceName, log },
        })
      })
    )

    // An instance hard-stopped on a question or a plan and is now blocked on the user, or a
    // fresh turn just cleared that block. Keeps the top-bar strip honest without the client
    // having to hold that instance's messages.
    unsubs.push(
      api.onEvent('instance:awaiting-input', (payload: { instanceId: string; awaitingInput: 'question' | 'plan' | null; awaitingInputAt: number | null }) => {
        dispatch({
          type: 'UPDATE_INSTANCE',
          payload: {
            id: payload.instanceId,
            updates: {
              awaitingInput: payload.awaitingInput ?? undefined,
              awaitingInputAt: payload.awaitingInputAt ?? undefined,
            },
          },
        })
      })
    )

    // The running turn read its prompt cache, so the TTL restarted. Without this the
    // countdown runs against the previous turn's timestamp and a long turn shows "Expired"
    // while the cache is in fact being refreshed on every step.
    unsubs.push(
      api.onEvent('cache:touch', (payload: { instanceId: string; at: number }) => {
        dispatch({ type: 'TOUCH_SESSION_CACHE', payload: { instanceId: payload.instanceId, at: payload.at } })
      })
    )

    unsubs.push(
      api.onInstanceOverdrive((payload: { instanceId: string; overdriveTasks: number; overdriveStartedAt?: number; lastTaskAt?: number }) => {
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id: payload.instanceId, updates: { overdriveTasks: payload.overdriveTasks, overdriveStartedAt: payload.overdriveStartedAt, lastTaskAt: payload.lastTaskAt } } })
      })
    )

    unsubs.push(
      api.onMessageAdded((payload: { instanceId: string; message: ChatMessage }) => {
        dispatch({ type: 'ADD_MESSAGE', payload: payload.message })
        if (payload.message.role === 'assistant') {
          dispatch({ type: 'INCREMENT_UNREAD', payload: payload.instanceId })
        }
      })
    )

    return () => { unsubs.forEach(u => u()) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Client-side overdrive expiry sweep — reset instances whose cache window has expired
  useEffect(() => {
    const CACHE_WINDOW_MS = 3_600_000
    const sweep = () => {
      const now = Date.now()
      for (const inst of instStateRef.current.instances) {
        if (inst.lastTaskAt && (now - inst.lastTaskAt) > CACHE_WINDOW_MS) {
          dispatch({ type: 'UPDATE_INSTANCE', payload: { id: inst.id, updates: { overdriveTasks: 0, overdriveStartedAt: undefined, lastTaskAt: undefined } } })
        }
      }
    }
    sweep()
    const intervalId = setInterval(sweep, 60_000)
    return () => clearInterval(intervalId)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore full UI state from URL on initial load
  const restoredFromUrl = useRef(false)
  useEffect(() => {
    if (restoredFromUrl.current || instState.instances.length === 0) return
    restoredFromUrl.current = true
    const params = new URLSearchParams(location.search)

    // Restore view. ?view=routines is an old bookmark from when routines had a view of
    // their own. A routine is now just a pipeline card carrying a schedule, so the
    // bookmark lands on the board instead of being dropped and leaving the user wherever
    // the app happened to open. Keep this redirect: those URLs are still out there.
    const rawView = params.get('view')
    const urlView = (rawView === 'routines' ? 'pipeline' : rawView) as typeof uiState.view | null
    if (urlView && ['grid', 'chat', 'pipeline', 'monitor', 'agents', 'usage', 'sessions', 'skills', 'activity'].includes(urlView)) {
      dispatch({ type: 'SET_VIEW', payload: urlView })
    }

    // Restore settings modal
    if (params.get('settings') === '1') {
      dispatch({ type: 'OPEN_SETTINGS' })
    }

    // Restore pipeline project
    const urlPipeline = params.get('pipeline')
    if (urlPipeline) {
      dispatch({ type: 'SET_ACTIVE_PIPELINE', payload: urlPipeline })
    }

    // Restore selected instance
    const urlId = params.get('instance')
    if (urlId && uiState.selectedInstanceId === null && instState.instances.some(i => i.id === urlId)) {
      // An instance param implies the full chat view (grid is the no-param default)
      if (!urlView) dispatch({ type: 'SET_VIEW', payload: 'chat' })
      dispatch({ type: 'SELECT_INSTANCE', payload: urlId })
      dispatch({ type: 'CLEAR_UNREAD', payload: urlId })
      api.getHistory(urlId, { limit: 150 }).then((data) => {
        const messages = (data as any).messages ?? data
        const hasMore = (data as any).hasMore ?? false
        dispatch({ type: 'SET_MESSAGES', payload: { instanceId: urlId, messages, hasMore } })
      }).catch(() => {})
      // Hydrate session cost on URL restore (selectInstance() does this, but URL restore bypasses it)
      api.getSessionCostSummary(urlId).then((cost) => {
        dispatch({ type: 'SET_SESSION_COST', payload: { instanceId: urlId, cost } })
      }).catch(() => {})
    }
  }, [instState.instances]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync URL when view/instance/pipeline/settings change.
  // Each view writes exactly its own params — nothing stale is carried over
  // (e.g. leaving pipeline view drops `pipeline=<id>`, returning to chat drops `view=`).
  useEffect(() => {
    if (!restoredFromUrl.current) return // don't write URL before initial restore
    const params = new URLSearchParams()
    if (uiState.view !== 'grid') params.set('view', uiState.view)
    if (uiState.view === 'chat' && uiState.selectedInstanceId) {
      params.set('instance', uiState.selectedInstanceId)
    }
    if (uiState.view === 'pipeline' && uiState.activePipelineId) {
      params.set('pipeline', uiState.activePipelineId)
    }
    if (uiState.showSettings) params.set('settings', '1')
    const qs = params.toString()
    window.history.replaceState(null, '', qs ? `?${qs}` : location.pathname)
  }, [uiState.view, uiState.selectedInstanceId, uiState.activePipelineId, uiState.showSettings])

  // Dynamic page title
  useEffect(() => {
    const id = uiState.selectedInstanceId
    if (!id) { document.title = 'OrcStrator'; return }
    const instance = instState.instances.find(i => i.id === id)
    if (!instance) { document.title = 'OrcStrator'; return }
    const folder = instState.folders.find(f => f.id === instance.folderId)
    const parts: string[] = []
    if (folder) parts.push(folder.displayName || folder.name)
    parts.push(instance.name)
    const msgs = msgState.messages[id]
    if (msgs && msgs.length > 0) {
      const last = msgs[msgs.length - 1]
      const textBlock = last.content.find(b => b.type === 'text')
      if (textBlock && textBlock.type === 'text') {
        const preview = textBlock.text.replace(/\s+/g, ' ').trim().slice(0, 40)
        if (preview) parts.push(preview)
      }
    }
    document.title = parts.join(' | ')
  }, [uiState.selectedInstanceId, instState.instances, instState.folders, msgState.messages])

  // Global Alt+↑/↓ to cycle between instances
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      const instances = instStateRef.current.instances
      if (instances.length === 0) return
      e.preventDefault()
      const currentId = uiStateRef.current.selectedInstanceId
      const idx = instances.findIndex(i => i.id === currentId)
      const next = e.key === 'ArrowUp'
        ? (idx <= 0 ? instances.length - 1 : idx - 1)
        : (idx >= instances.length - 1 ? 0 : idx + 1)
      dispatch({ type: 'SELECT_INSTANCE', payload: instances[next].id })
      dispatch({ type: 'CLEAR_UNREAD', payload: instances[next].id })
      if (!msgStateRef.current.messageOrder.includes(instances[next].id)) {
        api.getHistory(instances[next].id, { limit: 150 }).then((data) => {
          const messages = (data as any).messages ?? data
          const hasMore = (data as any).hasMore ?? false
          dispatch({ type: 'SET_MESSAGES', payload: { instanceId: instances[next].id, messages, hasMore } })
        }).catch(() => {})
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Shared hydration: history (if not cached), session cost, pending wake-ups.
  // Used by selectInstance (full chat) and addToGrid (grid tiles) so both paths
  // load identical per-instance state.
  const hydrateInstance = useCallback((id: string) => {
    // Re-fetch if messages are missing OR were partially rebuilt after cache eviction
    const inCache = msgStateRef.current.messageOrder.includes(id)
    if (!inCache) {
      api.getHistory(id, { limit: 150 }).then((data) => {
        const messages = (data as any).messages ?? data
        const hasMore = (data as any).hasMore ?? false
        dispatch({ type: 'SET_MESSAGES', payload: { instanceId: id, messages, hasMore } })
      }).catch((err) => console.error('Failed to fetch history:', err))
    }
    // Hydrate session cost from DB (restores counter after page reload / instance switch)
    api.getSessionCostSummary(id).then((cost) => {
      dispatch({ type: 'SET_SESSION_COST', payload: { instanceId: id, cost } })
    }).catch(() => {})
    // Hydrate pending auto-scheduled wake-ups (so banner survives page reload)
    api.getWakeups(id).then((res) => {
      dispatch({ type: 'SET_INSTANCE_WAKEUPS', payload: { instanceId: id, wakeups: res.wakeups } })
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Opening a chat that a scheduled fire surfaced counts as having looked at it: tell the
  // server, which clears the bright status on every tab. Reads the ref so the callback
  // stays stable; skips the round trip entirely for an ordinary chat.
  const ackSurfaceIfPending = useCallback((id: string) => {
    const inst = instStateRef.current.instances.find(i => i.id === id)
    if (inst?.surfacedAt == null) return
    dropSurface(id)
    dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates: { surfacedAt: undefined, surfacedSource: undefined } } })
    // The value being acked travels with the ack, so a fire that lands inside this round
    // trip (newer surfacedAt) is not cleared by a click that was aimed at the older one.
    api.ackSurface(id, inst.surfacedAt).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Stable action callbacks
  const selectInstance = useCallback((id: string | null) => {
    dispatch({ type: 'SELECT_INSTANCE', payload: id })
    if (id) {
      dispatch({ type: 'CLEAR_UNREAD', payload: id })
      hydrateInstance(id)
      ackSurfaceIfPending(id)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Always-fresh ref so the stale addToGrid closure reads the current limit
  const maxGridTilesRef = useRef(GRID_MAX_TILES)
  maxGridTilesRef.current = instState.settings?.maxGridTiles ?? GRID_MAX_TILES

  // Add an instance as a grid tile (or focus it if already present) + hydrate it
  const addToGrid = useCallback((id: string) => {
    dispatch({ type: 'GRID_ADD', payload: { id, maxTiles: maxGridTilesRef.current } })
    dispatch({ type: 'CLEAR_UNREAD', payload: id })
    hydrateInstance(id)
    // Every "take me to this chat" path lands here (sidebar row, top-bar chip, rail,
    // Activity row). The user asked for it by name, so they have looked at it: same ack as a
    // click on the tile. Without this the bright status would outlive the very click that opened it.
    ackSurfaceIfPending(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Put an instance in the grid WITHOUT navigating to it or moving the focus. Used by the
  // pipeline: starting a task must not throw you into a chat, but the instance it started
  // has to be a tile, or the grid stays empty while the run is already going.
  const addToGridBackground = useCallback((id: string) => {
    dispatch({ type: 'GRID_ADD_BACKGROUND', payload: { id, maxTiles: maxGridTilesRef.current } })
    hydrateInstance(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Surfaces: every instance carrying a surfacedAt this client has not handled yet gets a
  // grid tile NOW (ungated, background add: nothing moves, nothing steals focus) and one
  // glow QUEUED (gated: it plays when the grid is on screen and the window is in front).
  // One mechanism for both ways a surface arrives: the instance:surfaced event while the
  // app is open, and /api/state on a cold open hours after the card fired. The seen
  // set is keyed on id + surfacedAt, so a re-sync of unchanged state is a no-op and a new
  // fire on the same chat is not.
  const seenSurfacesRef = useRef(new Set<string>())
  useEffect(() => {
    for (const inst of instState.instances) {
      if (inst.surfacedAt == null) continue
      const key = `${inst.id}:${inst.surfacedAt}`
      if (seenSurfacesRef.current.has(key)) continue
      seenSurfacesRef.current.add(key)
      addToGridBackground(inst.id)
      enqueueSurface(inst.id, inst.surfacedAt)
    }
  }, [instState.instances]) // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the queue what is on screen, so a glow owed while the user was on the pipeline board
  // plays the moment they come back to the grid (or closes settings, or un-maximizes).
  useEffect(() => {
    // A maximized id that is no longer a tile must not reach the gate, or it would block
    // every drain with nothing on screen to un-maximize.
    const maximizedId = uiState.gridMaximizedId && uiState.gridInstanceIds.includes(uiState.gridMaximizedId)
      ? uiState.gridMaximizedId : null
    setSurfaceGate({ view: uiState.view, showSettings: uiState.showSettings, maximizedId })
  }, [uiState.view, uiState.showSettings, uiState.gridMaximizedId, uiState.gridInstanceIds])

  // A surface whose tile got evicted before its glow played (two fires landed on a full
  // grid while the user was away) can never drain, because no tile for it will mount again. The
  // glow is forfeited; the bright status stays on the server and shows in the sidebar and
  // in Activity, which is where an evicted chat is found anyway.
  useEffect(() => {
    for (const id of pendingSurfaceIds()) {
      if (!uiState.gridInstanceIds.includes(id)) dropSurface(id)
    }
  }, [uiState.gridInstanceIds])

  // Persist grid composition + maximized tile + Recent (evicted); restored on boot via loadStoredGrid()
  useEffect(() => {
    localStorage.setItem(GRID_STORAGE_KEY, JSON.stringify({
      ids: uiState.gridInstanceIds,
      maximizedId: uiState.gridMaximizedId,
      evicted: uiState.gridEvicted,
    }))
  }, [uiState.gridInstanceIds, uiState.gridMaximizedId, uiState.gridEvicted])

  // Once instances load: prune grid tiles whose instance no longer exists,
  // then hydrate the surviving restored tiles (history/cost/wakeups).
  const gridRestoredRef = useRef(false)
  useEffect(() => {
    if (gridRestoredRef.current || instState.instances.length === 0) return
    gridRestoredRef.current = true
    const existing = new Set(instState.instances.map(i => i.id))
    for (const id of uiStateRef.current.gridInstanceIds) {
      if (!existing.has(id)) {
        dispatch({ type: 'GRID_REMOVE', payload: id })
      } else {
        hydrateInstance(id)
      }
    }
  }, [instState.instances]) // eslint-disable-line react-hooks/exhaustive-deps

  const sendMessage = useCallback(async (instanceId: string, text: string, images?: string[], flags?: string[]) => {
    const contentBlocks: ChatMessage['content'] = []
    if (text) contentBlocks.push({ type: 'text', text })
    if (images && images.length > 0) {
      for (const b64 of images) {
        contentBlocks.push({ type: 'image', base64: b64, mediaType: b64.startsWith('/9j/') ? 'image/jpeg' : 'image/png' } as any)
      }
    }
    if (contentBlocks.length === 0) contentBlocks.push({ type: 'text', text })
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      instanceId,
      role: 'user',
      content: contentBlocks,
      createdAt: Date.now(),
    }
    dispatch({ type: 'ADD_MESSAGE', payload: userMessage })
    dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instanceId, updates: { state: 'running' } } })
    try {
      await api.sendMessage(instanceId, { text, images, flags })
    } catch (err) {
      // API rejected (409 already running, network error, etc.) — reset state so the UI isn't stuck
      dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instanceId, updates: { state: 'idle' } } })
      dispatch({ type: 'CLEAR_STREAMING', payload: instanceId })
      // This used to be a bare `catch {}`. A failed send then looked EXACTLY like a normal
      // one: the message bubble stayed on screen and nothing ever answered it, with no
      // error anywhere in the UI. Say so instead of going quiet.
      const reason = err instanceof Error ? err.message : String(err)
      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          id: crypto.randomUUID(),
          instanceId,
          role: 'system',
          content: [{ type: 'text', text: `⚠ Couldn't send that message: ${reason}. It was not delivered — try again.` }],
          createdAt: Date.now(),
        },
      })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const deleteInstance = useCallback(async (id: string) => {
    await api.deleteInstance(id)
    dispatch({ type: 'REMOVE_INSTANCE', payload: id })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Close + permanently scrub secrets from the transcript. The card closes
  // instantly (optimistic REMOVE_INSTANCE); the app-level banner reports the
  // scan result. The server deletes the DB row regardless of scrub outcome, so
  // the optimistic removal always stays consistent.
  const secureCloseInstance = useCallback(async (id: string, name: string, taskStatus?: 'done' | 'inbox') => {
    dispatch({ type: 'SET_SECURITY_NOTICE', payload: { id, name, phase: 'scanning', apiKeys: 0, passwords: 0, at: Date.now() } })
    dispatch({ type: 'REMOVE_INSTANCE', payload: id })
    try {
      const res = await api.secureCloseInstance(id, taskStatus)
      // `summarizing` is the server saying a background Haiku call is running and will
      // report where the summary landed. The notice holds itself open for it (pendingLog)
      // so the close is announced ONCE, in one banner, instead of the scrub and the
      // summary each posting one. An older server omits the field, in which case nothing
      // waits and a late summary merges in if the banner is still up.
      const pendingLog = res.summarizing === true
      dispatch({
        type: 'SET_SECURITY_NOTICE',
        payload: res.ok
          ? { id, name, phase: 'done', apiKeys: res.apiKeys, passwords: res.passwords, at: Date.now(), pendingLog }
          : { id, name, phase: 'error', apiKeys: 0, passwords: 0, at: Date.now(), pendingLog },
      })
    } catch {
      dispatch({ type: 'SET_SECURITY_NOTICE', payload: { id, name, phase: 'error', apiKeys: 0, passwords: 0, at: Date.now() } })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadOlderMessages = useCallback(async (instanceId: string) => {
    const currentMsgs = msgStateRef.current.messages[instanceId]
    if (!currentMsgs || currentMsgs.length === 0) return
    const earliest = currentMsgs[0].createdAt
    const data = await api.getHistory(instanceId, { limit: 150, before: earliest })
    const messages = (data as any).messages ?? data
    const hasMore = (data as any).hasMore ?? false
    dispatch({ type: 'PREPEND_MESSAGES', payload: { instanceId, messages, hasMore: messages.length > 0 ? hasMore : false } })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Memoized context values — each slice only re-renders its consumers
  const instancesValue = useMemo(
    () => ({ folders: instState.folders, instances: instState.instances }),
    [instState.folders, instState.instances]
  )

  const messagesValue = useMemo(
    () => ({
      messages: msgState.messages,
      hasMore: msgState.hasMore,
      streamingContent: msgState.streamingContent,
      streamingToolCalls: msgState.streamingToolCalls,
      toolResults: msgState.toolResults,
      unreadCounts: msgState.unreadCounts,
      rawOutput: msgState.rawOutput,
      cliPrompts: msgState.cliPrompts,
      permissionRequests: msgState.permissionRequests,
      pendingCommand: msgState.pendingCommand,
      pendingWakeups: msgState.pendingWakeups,
    }),
    [msgState.messages, msgState.hasMore, msgState.streamingContent, msgState.streamingToolCalls, msgState.toolResults, msgState.unreadCounts, msgState.rawOutput, msgState.cliPrompts, msgState.permissionRequests, msgState.pendingCommand, msgState.pendingWakeups]
  )

  const uiValue = useMemo(
    () => ({
      view: uiState.view,
      selectedInstanceId: uiState.selectedInstanceId,
      gridInstanceIds: uiState.gridInstanceIds,
      gridFocusedId: uiState.gridFocusedId,
      gridMaximizedId: uiState.gridMaximizedId,
      gridNotice: uiState.gridNotice,
      securityNotice: uiState.securityNotice,
      gridEvicted: uiState.gridEvicted,
      sidebarCollapsed: uiState.sidebarCollapsed,
      terminalPanelOpen: uiState.terminalPanelOpen,
      showSettings: uiState.showSettings,
      showFolderBrowser: uiState.showFolderBrowser,
      editingFolderId: uiState.editingFolderId,
      activePipelineId: uiState.activePipelineId,
      pendingTaskFocusId: uiState.pendingTaskFocusId,
      connected: uiState.connected,
      serverRestarted: uiState.serverRestarted,
      usage: uiState.usage,
      settings: instState.settings,
      verbosityOverrides: uiState.verbosityOverrides,
      sessionCosts: uiState.sessionCosts,
      historyErrors: uiState.historyErrors,
    }),
    [uiState, instState.settings]
  )

  const dispatchValue = useMemo(
    () => ({ dispatch, selectInstance, addToGrid, addToGridBackground, ackSurface: ackSurfaceIfPending, sendMessage, deleteInstance, secureCloseInstance, loadOlderMessages }),
    [dispatch, selectInstance, addToGrid, addToGridBackground, ackSurfaceIfPending, sendMessage, deleteInstance, secureCloseInstance, loadOlderMessages]
  )

  return (
    <AppDispatchContext.Provider value={dispatchValue}>
      <InstancesContext.Provider value={instancesValue}>
        <MessagesContext.Provider value={messagesValue}>
          <UIContext.Provider value={uiValue}>
            {children}
          </UIContext.Provider>
        </MessagesContext.Provider>
      </InstancesContext.Provider>
    </AppDispatchContext.Provider>
  )
}

// === Backward-Compatible useApp() shim ===
// Used by components not yet migrated to domain hooks.

interface AppContextValue {
  state: State
  dispatch: React.Dispatch<Action>
  selectInstance: (id: string | null) => void
  addToGrid: (id: string) => void
  deleteInstance: (id: string) => Promise<void>
  sendMessage: (instanceId: string, text: string, images?: string[], flags?: string[]) => Promise<void>
  loadOlderMessages: (instanceId: string) => Promise<void>
}

export function useApp(): AppContextValue {
  const { folders, instances } = useInstances()
  const msgs = useMessages()
  const ui = useUI()
  const { dispatch, selectInstance, addToGrid, sendMessage, deleteInstance, loadOlderMessages } = useAppDispatch()

  const state = useMemo<State>(
    () => ({
      folders,
      instances,
      settings: ui.settings,
      messages: msgs.messages,
      messageOrder: [],
      hasMore: msgs.hasMore,
      streamingContent: msgs.streamingContent,
      streamingToolCalls: msgs.streamingToolCalls,
      toolResults: msgs.toolResults,
      unreadCounts: msgs.unreadCounts,
      rawOutput: msgs.rawOutput,
      cliPrompts: msgs.cliPrompts,
      permissionRequests: msgs.permissionRequests,
      pendingCommand: msgs.pendingCommand,
      pendingWakeups: msgs.pendingWakeups,
      selectedInstanceId: ui.selectedInstanceId,
      gridInstanceIds: ui.gridInstanceIds,
      gridFocusOrder: [],
      gridFocusedId: ui.gridFocusedId,
      gridMaximizedId: ui.gridMaximizedId,
      gridNotice: ui.gridNotice,
      securityNotice: ui.securityNotice,
      gridEvicted: ui.gridEvicted,
      sidebarCollapsed: ui.sidebarCollapsed,
      showFolderBrowser: ui.showFolderBrowser,
      editingFolderId: ui.editingFolderId,
      view: ui.view,
      activePipelineId: ui.activePipelineId,
      pendingTaskFocusId: ui.pendingTaskFocusId,
      connected: ui.connected,
      serverRestarted: ui.serverRestarted,
      serverBootTime: null,
      usage: ui.usage,
      sessionCosts: ui.sessionCosts,
      terminalPanelOpen: ui.terminalPanelOpen,
      showSettings: ui.showSettings,
      verbosityOverrides: ui.verbosityOverrides,
      historyErrors: ui.historyErrors,
    }),
    [folders, instances, ui, msgs]
  )

  return useMemo(
    () => ({ state, dispatch, selectInstance, addToGrid, sendMessage, deleteInstance, loadOlderMessages }),
    [state, dispatch, selectInstance, addToGrid, sendMessage, deleteInstance, loadOlderMessages]
  )
}
