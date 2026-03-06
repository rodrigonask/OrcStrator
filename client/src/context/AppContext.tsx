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
} from '@shared/types'
import { InstancesContext } from './InstancesContext'
import { MessagesContext } from './MessagesContext'
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
}

interface UISlice {
  selectedInstanceId: string | null
  sidebarCollapsed: boolean
  showFolderBrowser: boolean
  editingFolderId: string | null
  view: 'chat' | 'pipeline'
  activePipelineId: string | null
  connected: boolean
  usage: UsageData | null
  terminalPanelOpen: boolean
  showSettings: boolean
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
  | { type: 'SET_VIEW'; payload: 'chat' | 'pipeline' }
  | { type: 'SET_ACTIVE_PIPELINE'; payload: string | null }
  | { type: 'CLEAR_UNREAD'; payload: string }
  | { type: 'INCREMENT_UNREAD'; payload: string }
  | { type: 'SET_CONNECTED'; payload: boolean }
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
}

const initialUI: UISlice = {
  selectedInstanceId: null,
  sidebarCollapsed: false,
  showFolderBrowser: false,
  editingFolderId: null,
  view: 'chat',
  activePipelineId: null,
  connected: false,
  usage: null,
  terminalPanelOpen: false,
  showSettings: false,
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
    case 'REORDER_FOLDERS':
      return {
        ...state,
        folders: action.payload
          .map((id, index) => { const f = state.folders.find(f => f.id === id); return f ? { ...f, sortOrder: index } : null })
          .filter((f): f is FolderConfig => f !== null),
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
      const order = state.messageOrder.filter(id => id !== smId)
      const newOrder = [...order, smId]
      let newMessages = { ...state.messages, [smId]: smMsgs }
      let finalOrder = newOrder
      let newHasMore = smHasMore !== undefined ? { ...state.hasMore, [smId]: smHasMore } : { ...state.hasMore }
      if (newOrder.length > MAX_CACHED_INSTANCES) {
        const evict = newOrder[0]
        const { [evict]: _ev, ...rest } = newMessages
        const { [evict]: _hm, ...restHM } = newHasMore
        newMessages = rest
        newHasMore = restHM
        finalOrder = newOrder.slice(1)
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
        const urlInstance = new URLSearchParams(window.location.search).get('instance')
        if (urlInstance && data.instances.some((i: InstanceConfig) => i.id === urlInstance)) {
          dispatch({ type: 'SELECT_INSTANCE', payload: urlInstance })
          dispatch({ type: 'CLEAR_UNREAD', payload: urlInstance })
          api.getHistory(urlInstance, { limit: 50 }).then((histData) => {
            const messages = (histData as any).messages ?? histData
            const hasMore = (histData as any).hasMore ?? false
            dispatch({ type: 'SET_MESSAGES', payload: { instanceId: urlInstance, messages, hasMore } })
          }).catch(() => {})
        }
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
        if (payload.connected && payload.reconnected && uiStateRef.current.selectedInstanceId) {
          const id = uiStateRef.current.selectedInstanceId
          api.getHistory(id, { limit: 50 }).then((data) => {
            const messages = (data as any).messages ?? data
            const hasMore = (data as any).hasMore ?? false
            dispatch({ type: 'SET_MESSAGES', payload: { instanceId: id, messages, hasMore } })
          }).catch(() => {})
        }
      })
    )

    unsubs.push(
      api.onClaudeOutputBatch((payload: { instanceId: string; events: ClaudeStreamEvent[] }) => {
        const { instanceId, events } = payload
        for (const event of events) {
          if (event.type === 'text-delta') {
            dispatch({ type: 'APPEND_STREAMING', payload: { instanceId, text: event.text } })
          } else if (event.type === 'tool-start') {
            dispatch({ type: 'TOOL_START', payload: { instanceId, toolId: event.toolId, toolName: event.toolName } })
          } else if (event.type === 'tool-input-delta') {
            dispatch({ type: 'TOOL_INPUT_DELTA', payload: { instanceId, toolId: event.toolId, input: event.input } })
          } else if (event.type === 'tool-complete') {
            dispatch({ type: 'TOOL_COMPLETE', payload: { instanceId, toolId: event.toolId, output: event.output, isError: event.isError } })
          } else if (event.type === 'raw-line') {
            if (uiStateRef.current.terminalPanelOpen) {
              dispatch({ type: 'APPEND_RAW_LINE', payload: { instanceId, line: event.line, isStderr: event.isStderr } })
            }
          }
        }
      })
    )

    unsubs.push(
      api.onClaudeProcessExit((payload: ClaudeProcessExitEvent) => {
        const { instanceId } = payload
        dispatch({ type: 'CLEAR_STREAMING', payload: instanceId })
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instanceId, updates: { state: 'idle', sessionId: payload.sessionId, activeTaskId: undefined, activeTaskTitle: undefined, taskStartedAt: undefined } } })
        api.getHistory(instanceId, { limit: 50 }).then((data) => {
          const messages = (data as any).messages ?? data
          const hasMore = (data as any).hasMore ?? false
          dispatch({ type: 'SET_MESSAGES', payload: { instanceId, messages, hasMore } })
        }).catch(() => {})
      })
    )

    unsubs.push(api.onUsageUpdated((payload: any) => dispatch({ type: 'SET_USAGE', payload })))

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
      api.onMessageAdded((payload: { instanceId: string; message: ChatMessage }) => {
        dispatch({ type: 'ADD_MESSAGE', payload: payload.message })
        if (payload.message.role === 'assistant') {
          dispatch({ type: 'INCREMENT_UNREAD', payload: payload.instanceId })
        }
      })
    )

    return () => { unsubs.forEach(u => u()) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore selected instance from URL on initial load
  const restoredFromUrl = useRef(false)
  useEffect(() => {
    if (restoredFromUrl.current || instState.instances.length === 0 || uiState.selectedInstanceId !== null) return
    restoredFromUrl.current = true
    const urlId = new URLSearchParams(location.search).get('instance')
    if (urlId && instState.instances.some(i => i.id === urlId)) {
      dispatch({ type: 'SELECT_INSTANCE', payload: urlId })
      dispatch({ type: 'CLEAR_UNREAD', payload: urlId })
      api.getHistory(urlId, { limit: 50 }).then((data) => {
        const messages = (data as any).messages ?? data
        const hasMore = (data as any).hasMore ?? false
        dispatch({ type: 'SET_MESSAGES', payload: { instanceId: urlId, messages, hasMore } })
      }).catch(() => {})
    }
  }, [instState.instances, uiState.selectedInstanceId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Dynamic page title
  useEffect(() => {
    const id = uiState.selectedInstanceId
    if (!id) { document.title = 'NasKlaude'; return }
    const instance = instState.instances.find(i => i.id === id)
    if (!instance) { document.title = 'NasKlaude'; return }
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
      if (!msgStateRef.current.messages[instances[next].id]) {
        api.getHistory(instances[next].id, { limit: 50 }).then((data) => {
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
      window.history.replaceState(null, '', `?instance=${id}`)
      dispatch({ type: 'CLEAR_UNREAD', payload: id })
      if (!msgStateRef.current.messages[id]) {
        api.getHistory(id, { limit: 50 }).then((data) => {
          const messages = (data as any).messages ?? data
          const hasMore = (data as any).hasMore ?? false
          dispatch({ type: 'SET_MESSAGES', payload: { instanceId: id, messages, hasMore } })
        }).catch((err) => console.error('Failed to fetch history:', err))
      }
    } else {
      window.history.replaceState(null, '', location.pathname)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const sendMessage = useCallback(async (instanceId: string, text: string, images?: string[], flags?: string[]) => {
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      instanceId,
      role: 'user',
      content: [{ type: 'text', text }],
      createdAt: Date.now(),
    }
    dispatch({ type: 'ADD_MESSAGE', payload: userMessage })
    dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instanceId, updates: { state: 'running' } } })
    await api.sendMessage(instanceId, { text, images, flags })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const deleteInstance = useCallback(async (id: string) => {
    await api.deleteInstance(id)
    dispatch({ type: 'REMOVE_INSTANCE', payload: id })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadOlderMessages = useCallback(async (instanceId: string) => {
    const currentMsgs = msgStateRef.current.messages[instanceId]
    if (!currentMsgs || currentMsgs.length === 0) return
    const earliest = currentMsgs[0].createdAt
    const data = await api.getHistory(instanceId, { limit: 50, before: earliest })
    const messages = (data as any).messages ?? data
    const hasMore = (data as any).hasMore ?? false
    if (messages.length > 0) {
      dispatch({ type: 'PREPEND_MESSAGES', payload: { instanceId, messages, hasMore } })
    }
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
    }),
    [msgState.messages, msgState.hasMore, msgState.streamingContent, msgState.streamingToolCalls, msgState.unreadCounts, msgState.rawOutput]
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
      usage: uiState.usage,
      settings: instState.settings,
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
      usage: ui.usage,
      terminalPanelOpen: ui.terminalPanelOpen,
      showSettings: ui.showSettings,
    }),
    [folders, instances, ui, msgs]
  )

  return useMemo(
    () => ({ state, dispatch, selectInstance, sendMessage, deleteInstance, loadOlderMessages }),
    [state, dispatch, selectInstance, sendMessage, deleteInstance, loadOlderMessages]
  )
}
