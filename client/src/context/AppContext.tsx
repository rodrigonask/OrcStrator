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
} from '@shared/types'
import { vfxBus } from '../systems/vfx-bus'
import { InstancesContext } from './InstancesContext'
import { MessagesContext } from './MessagesContext'
import type { CliPromptData } from './MessagesContext'
import { UIContext } from './UIContext'
import { AppDispatchContext } from './AppDispatchContext'
import { useInstances } from './InstancesContext'
import { useMessages } from './MessagesContext'
import { useUI } from './UIContext'
import { useAppDispatch } from './AppDispatchContext'

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
  unreadCounts: Record<string, number>
  rawOutput: Record<string, Array<{ line: string; isStderr?: boolean }>>
  cliPrompts: Record<string, CliPromptData>
}

interface UISlice {
  selectedInstanceId: string | null
  sidebarCollapsed: boolean
  showFolderBrowser: boolean
  editingFolderId: string | null
  view: 'chat' | 'pipeline' | 'monitor' | 'agents' | 'usage' | 'sessions'
  activePipelineId: string | null
  connected: boolean
  serverRestarted: boolean
  serverBootTime: number | null
  usage: UsageData | null
  terminalPanelOpen: boolean
  showSettings: boolean
  gameActive: boolean
  verbosityOverrides: Record<string, VerbosityLevel>
}

export interface StreamingToolCall {
  toolId: string
  toolName: string
  input: string
  output?: string
  isError?: boolean
  isRunning: boolean
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
  | { type: 'SET_MESSAGES'; payload: { instanceId: string; messages: ChatMessage[]; hasMore?: boolean } }
  | { type: 'PREPEND_MESSAGES'; payload: { instanceId: string; messages: ChatMessage[]; hasMore: boolean } }
  | { type: 'ADD_MESSAGE'; payload: ChatMessage }
  | { type: 'APPEND_STREAMING'; payload: { instanceId: string; text: string } }
  | { type: 'CLEAR_STREAMING'; payload: string }
  | { type: 'TOOL_START'; payload: { instanceId: string; toolId: string; toolName: string } }
  | { type: 'TOOL_INPUT_DELTA'; payload: { instanceId: string; toolId: string; input: string } }
  | { type: 'TOOL_COMPLETE'; payload: { instanceId: string; toolId: string; output: string; isError?: boolean } }
  | { type: 'SET_MESSAGE_TOKENS'; payload: { instanceId: string; messageId: string; inputTokens?: number; outputTokens?: number; costUsd?: number } }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_VIEW'; payload: 'chat' | 'pipeline' | 'monitor' | 'agents' | 'usage' | 'sessions' }
  | { type: 'SET_ACTIVE_PIPELINE'; payload: string | null }
  | { type: 'CLEAR_UNREAD'; payload: string }
  | { type: 'INCREMENT_UNREAD'; payload: string }
  | { type: 'SET_CONNECTED'; payload: boolean }
  | { type: 'SET_SERVER_BOOT_TIME'; payload: number }
  | { type: 'DISMISS_SERVER_RESTART' }
  | { type: 'SET_SERVER_RESTARTED' }
  | { type: 'SET_USAGE'; payload: UsageData | null }
  | { type: 'UPDATE_SETTINGS'; payload: Partial<AppSettings> }
  | { type: 'CLEAR_MESSAGES'; payload: string }
  | { type: 'TOGGLE_FOLDER'; folderId: string }
  | { type: 'OPEN_FOLDER_BROWSER' }
  | { type: 'CLOSE_FOLDER_BROWSER' }
  | { type: 'OPEN_PROJECT_EDIT'; folderId: string }
  | { type: 'CLOSE_PROJECT_EDIT' }
  | { type: 'SET_PIPELINE_PROJECT'; projectId: string | null }
  | { type: 'TOGGLE_TERMINAL' }
  | { type: 'SET_TERMINAL_OPEN'; payload: boolean }
  | { type: 'OPEN_SETTINGS' }
  | { type: 'CLOSE_SETTINGS' }
  | { type: 'APPEND_RAW_LINE'; payload: { instanceId: string; line: string; isStderr?: boolean } }
  | { type: 'SET_CLI_PROMPT'; payload: CliPromptData }
  | { type: 'CLEAR_CLI_PROMPT'; payload: string }
  | { type: 'SET_GAME_ACTIVE'; payload: boolean }
  | { type: 'SET_INSTANCE_VERBOSITY'; payload: { instanceId: string; level: VerbosityLevel | null } }

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
    usagePollMinutes: 10,
    theme: 'system',
    port: 3333,
  },
}

const initialMessages: MessagesSlice = {
  messages: {},
  messageOrder: [],
  hasMore: {},
  streamingContent: {},
  streamingToolCalls: {},
  unreadCounts: {},
  rawOutput: {},
  cliPrompts: {},
}

const initialUI: UISlice = {
  selectedInstanceId: null,
  sidebarCollapsed: false,
  showFolderBrowser: false,
  editingFolderId: null,
  view: 'chat',
  activePipelineId: null,
  connected: false,
  serverRestarted: false,
  serverBootTime: null,
  usage: null,
  terminalPanelOpen: false,
  showSettings: false,
  gameActive: (() => { try { return localStorage.getItem('orcstrator.gameActive') === 'true' } catch { return false } })(),
  verbosityOverrides: {},
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
      const MAX_CACHED_INSTANCES = 3
      const { instanceId: smId, messages: smMsgs, hasMore: smHasMore } = action.payload
      const protectId = (action as any)._protectId as string | null
      const order = state.messageOrder.filter(id => id !== smId)
      const newOrder = [...order, smId]
      let newMessages = { ...state.messages, [smId]: smMsgs }
      let finalOrder = newOrder
      let newHasMore = smHasMore !== undefined ? { ...state.hasMore, [smId]: smHasMore } : { ...state.hasMore }
      if (newOrder.length > MAX_CACHED_INSTANCES) {
        // Never evict the instance the user is currently viewing
        const evict = newOrder.find(id => id !== protectId && id !== smId) ?? newOrder[0]
        const { [evict]: _ev, ...rest } = newMessages
        const { [evict]: _hm, ...restHM } = newHasMore
        newMessages = rest
        newHasMore = restHM
        finalOrder = newOrder.filter(id => id !== evict)
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
      const { instanceId, toolId, toolName } = action.payload
      const existing = state.streamingToolCalls[instanceId] || []
      return { ...state, streamingToolCalls: { ...state.streamingToolCalls, [instanceId]: [...existing, { toolId, toolName, input: '', isRunning: true }] } }
    }
    case 'TOOL_INPUT_DELTA': {
      const { instanceId, toolId, input } = action.payload
      const calls = state.streamingToolCalls[instanceId] || []
      return { ...state, streamingToolCalls: { ...state.streamingToolCalls, [instanceId]: calls.map(c => c.toolId === toolId ? { ...c, input: c.input + input } : c) } }
    }
    case 'TOOL_COMPLETE': {
      const { instanceId, toolId, output, isError } = action.payload
      const calls = state.streamingToolCalls[instanceId] || []
      return { ...state, streamingToolCalls: { ...state.streamingToolCalls, [instanceId]: calls.map(c => c.toolId === toolId ? { ...c, output, isError, isRunning: false } : c) } }
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
    default:
      return state
  }
}

function uiReducer(state: UISlice, action: Action): UISlice {
  switch (action.type) {
    case 'SELECT_INSTANCE':
      return { ...state, selectedInstanceId: action.payload }
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
    case 'SET_SERVER_RESTARTED':
      return { ...state, serverRestarted: true }
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
    case 'TOGGLE_TERMINAL':
      return { ...state, terminalPanelOpen: !state.terminalPanelOpen }
    case 'SET_TERMINAL_OPEN':
      return { ...state, terminalPanelOpen: action.payload }
    case 'OPEN_SETTINGS':
      return { ...state, showSettings: true }
    case 'CLOSE_SETTINGS':
      return { ...state, showSettings: false }
    case 'SET_GAME_ACTIVE': {
      try { localStorage.setItem('orcstrator.gameActive', String(action.payload)) } catch { /* ignore */ }
      return { ...state, gameActive: action.payload }
    }
    case 'SET_INSTANCE_VERBOSITY': {
      const { instanceId, level } = action.payload
      if (level === null) {
        const { [instanceId]: _, ...rest } = state.verbosityOverrides
        return { ...state, verbosityOverrides: rest }
      }
      return { ...state, verbosityOverrides: { ...state.verbosityOverrides, [instanceId]: level } }
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

      // Cross-cutting: REMOVE_INSTANCE clears messages + deselects if needed
      case 'REMOVE_INSTANCE':
        msgDispatch({ type: 'CLEAR_MESSAGES', payload: action.payload })
        instDispatch(action)
        if (uiStateRef.current.selectedInstanceId === action.payload) {
          uiDispatch({ type: 'SELECT_INSTANCE', payload: null })
        }
        break

      // Messages slice
      case 'SET_MESSAGES':
        // Attach selected instance so reducer never evicts the viewed chat
        msgDispatch({ ...action, _protectId: uiStateRef.current.selectedInstanceId } as any)
        break
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
        msgDispatch(action)
        break

      // Cross-cutting: skip INCREMENT_UNREAD for the currently selected instance
      case 'INCREMENT_UNREAD':
        if (action.payload !== uiStateRef.current.selectedInstanceId) {
          msgDispatch(action)
        }
        break

      // UI slice
      case 'SELECT_INSTANCE':
      case 'TOGGLE_SIDEBAR':
      case 'SET_VIEW':
      case 'SET_ACTIVE_PIPELINE':
      case 'SET_CONNECTED':
      case 'SET_SERVER_BOOT_TIME':
      case 'DISMISS_SERVER_RESTART':
      case 'SET_SERVER_RESTARTED':
      case 'SET_USAGE':
      case 'OPEN_FOLDER_BROWSER':
      case 'CLOSE_FOLDER_BROWSER':
      case 'OPEN_PROJECT_EDIT':
      case 'CLOSE_PROJECT_EDIT':
      case 'SET_PIPELINE_PROJECT':
      case 'TOGGLE_TERMINAL':
      case 'SET_TERMINAL_OPEN':
      case 'OPEN_SETTINGS':
      case 'CLOSE_SETTINGS':
      case 'SET_GAME_ACTIVE':
      case 'SET_INSTANCE_VERBOSITY':
        uiDispatch(action)
        break
    }
  }, []) // sub-dispatchers from useReducer are stable

  // Fetch initial state and connect WebSocket
  useEffect(() => {
    let mounted = true
    api.getState().then((data) => {
      if (mounted) {
        dispatch({ type: 'SET_STATE', payload: data })
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

          // On first load, check if a restart happened that hasn't been resolved yet
          api.getRestartStatus().then(status => {
            if (status.deactivatedFolders.length > 0) {
              dispatch({ type: 'SET_SERVER_RESTARTED' })
            }
          }).catch(() => {})

          if (payload.reconnected && uiStateRef.current.selectedInstanceId) {
            const id = uiStateRef.current.selectedInstanceId
            api.getHistory(id, { limit: 150 }).then((data) => {
              const messages = (data as any).messages ?? data
              const hasMore = (data as any).hasMore ?? false
              dispatch({ type: 'SET_MESSAGES', payload: { instanceId: id, messages, hasMore } })
            }).catch(() => {})
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
        let streamingCleared = false
        for (const event of events) {
          if (event.type === 'text-delta') {
            // Skip text-delta events that arrive after assistant-message in the same batch —
            // these are redundant re-emissions from the parser and would re-populate streaming
            if (streamingCleared) continue
            dispatch({ type: 'APPEND_STREAMING', payload: { instanceId, text: event.text } })
          } else if (event.type === 'tool-start') {
            if (streamingCleared) continue
            dispatch({ type: 'TOOL_START', payload: { instanceId, toolId: event.toolId, toolName: event.toolName } })
          } else if (event.type === 'tool-input-delta') {
            if (streamingCleared) continue
            dispatch({ type: 'TOOL_INPUT_DELTA', payload: { instanceId, toolId: event.toolId, input: event.input } })
          } else if (event.type === 'tool-complete') {
            dispatch({ type: 'TOOL_COMPLETE', payload: { instanceId, toolId: event.toolId, output: event.output, isError: event.isError } })
          } else if (event.type === 'raw-line') {
            if (uiStateRef.current.terminalPanelOpen) {
              dispatch({ type: 'APPEND_RAW_LINE', payload: { instanceId, line: event.line, isStderr: event.isStderr } })
            }
          } else if (event.type === 'assistant-message') {
            dispatch({ type: 'ADD_MESSAGE', payload: event.message })
            dispatch({ type: 'CLEAR_STREAMING', payload: instanceId })
            streamingCleared = true
          } else if (event.type === 'cli-prompt') {
            dispatch({ type: 'SET_CLI_PROMPT', payload: { instanceId, eventType: event.eventType, data: event.data, receivedAt: Date.now() } })
          } else if (event.type === 'result' && event.inputTokens !== undefined) {
            const updates: Record<string, unknown> = { ctxTokens: event.inputTokens }
            if (event.model) updates.ctxModel = event.model
            dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instanceId, updates } })
          }
        }
      })
    )

    unsubs.push(
      api.onClaudeProcessExit((payload: ClaudeProcessExitEvent) => {
        const { instanceId } = payload
        dispatch({ type: 'CLEAR_STREAMING', payload: instanceId })
        dispatch({ type: 'CLEAR_CLI_PROMPT', payload: instanceId })
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instanceId, updates: { state: 'idle', activeTaskId: undefined, activeTaskTitle: undefined, taskStartedAt: undefined } } })
        api.getHistory(instanceId, { limit: 150 }).then((data) => {
          const messages = (data as any).messages ?? data
          const hasMore = (data as any).hasMore ?? false
          dispatch({ type: 'SET_MESSAGES', payload: { instanceId, messages, hasMore } })
        }).catch(() => {})
      })
    )

    unsubs.push(api.onUsageUpdated((payload: any) => dispatch({ type: 'SET_USAGE', payload })))

    unsubs.push(
      api.onEvent('instance:updated', (payload: Record<string, unknown>) => {
        if (!payload.id) return
        const id = payload.id as string
        const updates: Record<string, unknown> = {}
        const fields = ['state', 'sessionId', 'name', 'agentRole', 'specialization',
          'orchestratorManaged', 'sortOrder', 'agentId', 'idleRestartMinutes',
          'xpTotal', 'level', 'overdriveTasks', 'overdriveStartedAt', 'lastTaskAt']
        for (const f of fields) {
          if (f in payload) updates[f] = payload[f] ?? undefined
        }
        // Clear task metadata when session ends
        if (payload.sessionId === null || payload.sessionId === undefined) {
          updates.sessionId = undefined
          updates.activeTaskId = undefined
          updates.activeTaskTitle = undefined
          updates.taskStartedAt = undefined
        }
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates } })
      })
    )

    unsubs.push(
      api.onOrchestratorAssigned((payload: { folderId: string; instanceId: string; taskId: string; taskTitle: string }) => {
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id: payload.instanceId, updates: { state: 'running', activeTaskId: payload.taskId, activeTaskTitle: payload.taskTitle, taskStartedAt: Date.now() } } })
      })
    )

    unsubs.push(
      api.onOrchestratorLockReleased((payload: { taskId: string; reason: string }) => {
        const inst = instStateRef.current.instances.find(i => i.activeTaskId === payload.taskId)
        if (inst) {
          dispatch({ type: 'UPDATE_INSTANCE', payload: { id: inst.id, updates: { activeTaskId: undefined, activeTaskTitle: undefined } } })
        }
      })
    )

    unsubs.push(
      api.onOrchestratorStatus((payload: { folderId: string; active: boolean; idleAgents: number; pendingTasks: number }) => {
        dispatch({ type: 'UPDATE_FOLDER', payload: { id: payload.folderId, updates: { orchestratorActive: payload.active } } })
      })
    )

    unsubs.push(
      api.onInstanceXp((payload: { instanceId: string; xpTotal: number; level: number }) => {
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id: payload.instanceId, updates: { xpTotal: payload.xpTotal, level: payload.level } } })
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

    // VFX: level-up events
    unsubs.push(
      api.onInstanceLevelUp((payload: { instanceId: string; newLevel: number }) => {
        vfxBus.fire('level:up', { amount: payload.newLevel })
      })
    )

    // VFX: profile level-up
    unsubs.push(
      api.onEvent('profile:level-up', (payload: { level: number }) => {
        vfxBus.fire('level:up', { amount: payload.level, text: `LEVEL ${payload.level}!` })
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

    // Restore view
    const urlView = params.get('view') as typeof uiState.view | null
    if (urlView && ['chat', 'pipeline', 'monitor', 'agents', 'usage', 'sessions'].includes(urlView)) {
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
      dispatch({ type: 'SELECT_INSTANCE', payload: urlId })
      dispatch({ type: 'CLEAR_UNREAD', payload: urlId })
      api.getHistory(urlId, { limit: 150 }).then((data) => {
        const messages = (data as any).messages ?? data
        const hasMore = (data as any).hasMore ?? false
        dispatch({ type: 'SET_MESSAGES', payload: { instanceId: urlId, messages, hasMore } })
      }).catch(() => {})
    }
  }, [instState.instances]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync URL when view/instance/pipeline/settings change
  useEffect(() => {
    if (!restoredFromUrl.current) return // don't write URL before initial restore
    const params = new URLSearchParams()
    if (uiState.view !== 'chat') params.set('view', uiState.view)
    if (uiState.selectedInstanceId) params.set('instance', uiState.selectedInstanceId)
    if (uiState.activePipelineId) params.set('pipeline', uiState.activePipelineId)
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
    if (instance.agentRole) parts.push(instance.agentRole.charAt(0).toUpperCase() + instance.agentRole.slice(1))
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

  // Stable action callbacks
  const selectInstance = useCallback((id: string | null) => {
    dispatch({ type: 'SELECT_INSTANCE', payload: id })
    if (id) {
      dispatch({ type: 'CLEAR_UNREAD', payload: id })
      // Re-fetch if messages are missing OR were partially rebuilt after cache eviction
      const inCache = msgStateRef.current.messageOrder.includes(id)
      if (!inCache) {
        api.getHistory(id, { limit: 150 }).then((data) => {
          const messages = (data as any).messages ?? data
          const hasMore = (data as any).hasMore ?? false
          dispatch({ type: 'SET_MESSAGES', payload: { instanceId: id, messages, hasMore } })
        }).catch((err) => console.error('Failed to fetch history:', err))
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
    } catch {
      // API rejected (409 already running, network error, etc.) — reset state so the UI isn't stuck
      dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instanceId, updates: { state: 'idle' } } })
      dispatch({ type: 'CLEAR_STREAMING', payload: instanceId })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const deleteInstance = useCallback(async (id: string) => {
    await api.deleteInstance(id)
    dispatch({ type: 'REMOVE_INSTANCE', payload: id })
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
      unreadCounts: msgState.unreadCounts,
      rawOutput: msgState.rawOutput,
      cliPrompts: msgState.cliPrompts,
    }),
    [msgState.messages, msgState.hasMore, msgState.streamingContent, msgState.streamingToolCalls, msgState.unreadCounts, msgState.rawOutput, msgState.cliPrompts]
  )

  const uiValue = useMemo(
    () => ({
      view: uiState.view,
      selectedInstanceId: uiState.selectedInstanceId,
      sidebarCollapsed: uiState.sidebarCollapsed,
      terminalPanelOpen: uiState.terminalPanelOpen,
      showSettings: uiState.showSettings,
      showFolderBrowser: uiState.showFolderBrowser,
      editingFolderId: uiState.editingFolderId,
      activePipelineId: uiState.activePipelineId,
      connected: uiState.connected,
      serverRestarted: uiState.serverRestarted,
      usage: uiState.usage,
      settings: instState.settings,
      gameActive: uiState.gameActive,
      verbosityOverrides: uiState.verbosityOverrides,
    }),
    [uiState, instState.settings]
  )

  const dispatchValue = useMemo(
    () => ({ dispatch, selectInstance, sendMessage, deleteInstance, loadOlderMessages }),
    [dispatch, selectInstance, sendMessage, deleteInstance, loadOlderMessages]
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
  deleteInstance: (id: string) => Promise<void>
  sendMessage: (instanceId: string, text: string, images?: string[], flags?: string[]) => Promise<void>
  loadOlderMessages: (instanceId: string) => Promise<void>
}

export function useApp(): AppContextValue {
  const { folders, instances } = useInstances()
  const msgs = useMessages()
  const ui = useUI()
  const { dispatch, selectInstance, sendMessage, deleteInstance, loadOlderMessages } = useAppDispatch()

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
      unreadCounts: msgs.unreadCounts,
      rawOutput: msgs.rawOutput,
      selectedInstanceId: ui.selectedInstanceId,
      sidebarCollapsed: ui.sidebarCollapsed,
      showFolderBrowser: ui.showFolderBrowser,
      editingFolderId: ui.editingFolderId,
      view: ui.view,
      activePipelineId: ui.activePipelineId,
      connected: ui.connected,
      serverRestarted: ui.serverRestarted,
      serverBootTime: null,
      usage: ui.usage,
      terminalPanelOpen: ui.terminalPanelOpen,
      showSettings: ui.showSettings,
      gameActive: ui.gameActive,
      verbosityOverrides: ui.verbosityOverrides,
    }),
    [folders, instances, ui, msgs]
  )

  return useMemo(
    () => ({ state, dispatch, selectInstance, sendMessage, deleteInstance, loadOlderMessages }),
    [state, dispatch, selectInstance, sendMessage, deleteInstance, loadOlderMessages]
  )
}
