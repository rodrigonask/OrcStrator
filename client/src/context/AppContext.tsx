import React, { createContext, useContext, useReducer, useEffect, useCallback, useMemo, useRef } from 'react'
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

// === State ===

interface StreamingToolCall {
  toolId: string
  toolName: string
  input: string
  output?: string
  isError?: boolean
  isRunning: boolean
}

interface State {
  folders: FolderConfig[]
  instances: InstanceConfig[]
  settings: AppSettings
  selectedInstanceId: string | null
  messages: Record<string, ChatMessage[]>
  streamingContent: Record<string, string>
  streamingToolCalls: Record<string, StreamingToolCall[]>
  unreadCounts: Record<string, number>
  sidebarCollapsed: boolean
  showFolderBrowser: boolean
  editingFolderId: string | null
  view: 'chat' | 'pipeline'
  activePipelineId: string | null
  connected: boolean
  usage: UsageData | null
  terminalPanelOpen: boolean
  showSettings: boolean
  rawOutput: Record<string, Array<{ line: string; isStderr?: boolean }>>
}

const initialState: State = {
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
  selectedInstanceId: null,
  messages: {},
  streamingContent: {},
  streamingToolCalls: {},
  unreadCounts: {},
  sidebarCollapsed: false,
  showFolderBrowser: false,
  editingFolderId: null,
  view: 'chat',
  activePipelineId: null,
  connected: false,
  usage: null,
  terminalPanelOpen: false,
  showSettings: false,
  rawOutput: {},
}

// === Actions ===

type Action =
  | { type: 'SET_STATE'; payload: { folders: FolderConfig[]; instances: InstanceConfig[]; settings: AppSettings } }
  | { type: 'ADD_FOLDER'; payload: FolderConfig }
  | { type: 'REMOVE_FOLDER'; payload?: string; folderId?: string }
  | { type: 'UPDATE_FOLDER'; payload: { id: string; updates: Partial<FolderConfig> } }
  | { type: 'REORDER_FOLDERS'; payload: string[] }
  | { type: 'ADD_INSTANCE'; payload: InstanceConfig }
  | { type: 'REMOVE_INSTANCE'; payload: string }
  | { type: 'UPDATE_INSTANCE'; payload: { id: string; updates: Partial<InstanceConfig> } }
  | { type: 'SELECT_INSTANCE'; payload: string | null }
  | { type: 'SET_MESSAGES'; payload: { instanceId: string; messages: ChatMessage[] } }
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

// === Reducer ===

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_STATE':
      return {
        ...state,
        folders: action.payload.folders,
        instances: action.payload.instances,
        settings: action.payload.settings,
      }

    case 'ADD_FOLDER':
      return { ...state, folders: [...state.folders, action.payload] }

    case 'REMOVE_FOLDER': {
      const fid = action.payload || action.folderId || ''
      return {
        ...state,
        folders: state.folders.filter((f) => f.id !== fid),
        instances: state.instances.filter((i) => i.folderId !== fid),
      }
    }

    case 'UPDATE_FOLDER':
      return {
        ...state,
        folders: state.folders.map((f) =>
          f.id === action.payload.id ? { ...f, ...action.payload.updates } : f
        ),
      }

    case 'REORDER_FOLDERS':
      return {
        ...state,
        folders: action.payload
          .map((id, index) => {
            const folder = state.folders.find((f) => f.id === id)
            return folder ? { ...folder, sortOrder: index } : null
          })
          .filter((f): f is FolderConfig => f !== null),
      }

    case 'ADD_INSTANCE':
      return { ...state, instances: [...state.instances, action.payload] }

    case 'REMOVE_INSTANCE': {
      const newSelected =
        state.selectedInstanceId === action.payload ? null : state.selectedInstanceId
      return {
        ...state,
        instances: state.instances.filter((i) => i.id !== action.payload),
        selectedInstanceId: newSelected,
      }
    }

    case 'UPDATE_INSTANCE':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.payload.id ? { ...i, ...action.payload.updates } : i
        ),
      }

    case 'SELECT_INSTANCE':
      return { ...state, selectedInstanceId: action.payload }

    case 'SET_MESSAGES':
      return {
        ...state,
        messages: { ...state.messages, [action.payload.instanceId]: action.payload.messages },
      }

    case 'ADD_MESSAGE': {
      const instId = action.payload.instanceId
      const existing = state.messages[instId] || []
      return {
        ...state,
        messages: { ...state.messages, [instId]: [...existing, action.payload] },
      }
    }

    case 'APPEND_STREAMING': {
      const { instanceId, text } = action.payload
      const current = state.streamingContent[instanceId] || ''
      return {
        ...state,
        streamingContent: { ...state.streamingContent, [instanceId]: current + text },
      }
    }

    case 'CLEAR_STREAMING': {
      const { [action.payload]: _sc, ...restSC } = state.streamingContent
      const { [action.payload]: _stc, ...restSTC } = state.streamingToolCalls
      return { ...state, streamingContent: restSC, streamingToolCalls: restSTC }
    }

    case 'TOOL_START': {
      const { instanceId, toolId, toolName } = action.payload
      const existing = state.streamingToolCalls[instanceId] || []
      return {
        ...state,
        streamingToolCalls: {
          ...state.streamingToolCalls,
          [instanceId]: [...existing, { toolId, toolName, input: '', isRunning: true }],
        },
      }
    }

    case 'TOOL_INPUT_DELTA': {
      const { instanceId, toolId, input } = action.payload
      const calls = state.streamingToolCalls[instanceId] || []
      return {
        ...state,
        streamingToolCalls: {
          ...state.streamingToolCalls,
          [instanceId]: calls.map(c =>
            c.toolId === toolId ? { ...c, input: c.input + input } : c
          ),
        },
      }
    }

    case 'TOOL_COMPLETE': {
      const { instanceId, toolId, output, isError } = action.payload
      const calls = state.streamingToolCalls[instanceId] || []
      return {
        ...state,
        streamingToolCalls: {
          ...state.streamingToolCalls,
          [instanceId]: calls.map(c =>
            c.toolId === toolId ? { ...c, output, isError, isRunning: false } : c
          ),
        },
      }
    }

    case 'SET_MESSAGE_TOKENS': {
      const { instanceId, messageId, ...tokens } = action.payload
      const msgs = (state.messages[instanceId] || []).map((m) =>
        m.id === messageId ? { ...m, ...tokens } : m
      )
      return { ...state, messages: { ...state.messages, [instanceId]: msgs } }
    }

    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed }

    case 'SET_VIEW':
      return { ...state, view: action.payload }

    case 'SET_ACTIVE_PIPELINE':
      return { ...state, activePipelineId: action.payload }

    case 'CLEAR_UNREAD': {
      const { [action.payload]: _, ...rest } = state.unreadCounts
      return { ...state, unreadCounts: rest }
    }

    case 'INCREMENT_UNREAD': {
      const id = action.payload
      if (id === state.selectedInstanceId) return state
      return {
        ...state,
        unreadCounts: {
          ...state.unreadCounts,
          [id]: (state.unreadCounts[id] || 0) + 1,
        },
      }
    }

    case 'SET_CONNECTED':
      return { ...state, connected: action.payload }

    case 'SET_USAGE':
      return { ...state, usage: action.payload }

    case 'UPDATE_SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.payload } }

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

    case 'TOGGLE_FOLDER':
      return {
        ...state,
        folders: state.folders.map((f) =>
          f.id === action.folderId ? { ...f, expanded: !f.expanded } : f
        ),
      }

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

// === Context ===

interface AppContextValue {
  state: State
  dispatch: React.Dispatch<Action>
  selectInstance: (id: string | null) => void
  deleteInstance: (id: string) => Promise<void>
  sendMessage: (instanceId: string, text: string, images?: string[], flags?: string[]) => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

// === Provider ===

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)

  // Fetch initial state and connect WebSocket
  useEffect(() => {
    let mounted = true

    api.getState().then((data) => {
      if (mounted) {
        dispatch({ type: 'SET_STATE', payload: data })
      }
    }).catch((err) => {
      console.error('Failed to fetch initial state:', err)
    })

    api.getUsage().then((usage) => {
      if (mounted) {
        dispatch({ type: 'SET_USAGE', payload: usage })
      }
    }).catch(() => {
      // usage might not be connected yet
    })

    api.connect()

    return () => {
      mounted = false
    }
  }, [])

  // Subscribe to WebSocket events
  useEffect(() => {
    const unsubs: Array<() => void> = []

    unsubs.push(
      api.onConnection((payload: { connected: boolean }) => {
        dispatch({ type: 'SET_CONNECTED', payload: payload.connected })
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
            dispatch({ type: 'APPEND_RAW_LINE', payload: { instanceId, line: event.line, isStderr: event.isStderr } })
          }
        }
        dispatch({ type: 'INCREMENT_UNREAD', payload: instanceId })
      })
    )

    unsubs.push(
      api.onClaudeProcessExit((payload: ClaudeProcessExitEvent) => {
        const { instanceId } = payload
        dispatch({ type: 'CLEAR_STREAMING', payload: instanceId })
        dispatch({
          type: 'UPDATE_INSTANCE',
          payload: { id: instanceId, updates: { state: 'idle', sessionId: payload.sessionId } },
        })
        // Refresh history to get the final messages
        api.getHistory(instanceId).then((data) => {
          const messages = (data as any).messages ?? data
          dispatch({ type: 'SET_MESSAGES', payload: { instanceId, messages } })
        }).catch(() => {
          // history fetch failed, streaming content already cleared
        })
      })
    )

    unsubs.push(
      api.onUsageUpdated((payload: any) => {
        dispatch({ type: 'SET_USAGE', payload })
      })
    )

    unsubs.push(
      api.onOrchestratorAssigned((payload: { folderId: string; instanceId: string; taskId: string; taskTitle: string }) => {
        // Update the assigned instance to running state (server will also broadcast instance:state)
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id: payload.instanceId, updates: { state: 'running' } } })
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
        dispatch({ type: 'INCREMENT_UNREAD', payload: payload.instanceId })
      })
    )

    return () => {
      unsubs.forEach((unsub) => unsub())
    }
  }, [])

  // Ref to avoid selectInstance depending on state.messages (which changes on every stream delta)
  const messagesRef = useRef(state.messages)
  messagesRef.current = state.messages

  // Refs for keyboard navigation (avoids stale closures)
  const instancesRef = useRef(state.instances)
  instancesRef.current = state.instances
  const selectedIdRef = useRef(state.selectedInstanceId)
  selectedIdRef.current = state.selectedInstanceId

  // Global Alt+↑/↓ to cycle between instances
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      const instances = instancesRef.current
      if (instances.length === 0) return
      e.preventDefault()
      const currentId = selectedIdRef.current
      const idx = instances.findIndex(i => i.id === currentId)
      let next: number
      if (e.key === 'ArrowUp') {
        next = idx <= 0 ? instances.length - 1 : idx - 1
      } else {
        next = idx >= instances.length - 1 ? 0 : idx + 1
      }
      dispatch({ type: 'SELECT_INSTANCE', payload: instances[next].id })
      dispatch({ type: 'CLEAR_UNREAD', payload: instances[next].id })
      if (!messagesRef.current[instances[next].id]) {
        api.getHistory(instances[next].id).then((data) => {
          const messages = (data as any).messages ?? data
          dispatch({ type: 'SET_MESSAGES', payload: { instanceId: instances[next].id, messages } })
        }).catch(() => {})
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Select instance and fetch history
  const selectInstance = useCallback(
    (id: string | null) => {
      dispatch({ type: 'SELECT_INSTANCE', payload: id })
      if (id) {
        dispatch({ type: 'CLEAR_UNREAD', payload: id })
        if (!messagesRef.current[id]) {
          api.getHistory(id).then((data) => {
            const messages = (data as any).messages ?? data
            dispatch({ type: 'SET_MESSAGES', payload: { instanceId: id, messages } })
          }).catch((err) => {
            console.error('Failed to fetch history:', err)
          })
        }
      }
    },
    [] // dispatch is stable from useReducer; messagesRef is a ref
  )

  // Send a message to an instance
  const sendMessage = useCallback(
    async (instanceId: string, text: string, images?: string[], flags?: string[]) => {
      // Add user message locally
      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        instanceId,
        role: 'user',
        content: [{ type: 'text', text }],
        createdAt: Date.now(),
      }
      dispatch({ type: 'ADD_MESSAGE', payload: userMessage })

      // Update instance state to running
      dispatch({
        type: 'UPDATE_INSTANCE',
        payload: { id: instanceId, updates: { state: 'running' } },
      })

      // Send to API
      await api.sendMessage(instanceId, { text, images, flags })
    },
    []
  )

  const deleteInstance = useCallback(async (id: string) => {
    await api.deleteInstance(id)
    dispatch({ type: 'REMOVE_INSTANCE', payload: id })
  }, [])

  const value = useMemo<AppContextValue>(
    () => ({ state, dispatch, selectInstance, deleteInstance, sendMessage }),
    [state, dispatch, selectInstance, deleteInstance, sendMessage]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

// === Hook ===

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within an AppProvider')
  return ctx
}
