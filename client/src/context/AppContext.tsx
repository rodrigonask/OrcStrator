import React, { createContext, useContext, useReducer, useEffect, useCallback } from 'react'
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

interface State {
  folders: FolderConfig[]
  instances: InstanceConfig[]
  settings: AppSettings
  selectedInstanceId: string | null
  messages: Record<string, ChatMessage[]>
  streamingContent: Record<string, string>
  unreadCounts: Record<string, number>
  sidebarCollapsed: boolean
  showFolderBrowser: boolean
  editingFolderId: string | null
  view: 'chat' | 'pipeline'
  activePipelineId: string | null
  connected: boolean
  usage: UsageData | null
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
  unreadCounts: {},
  sidebarCollapsed: false,
  showFolderBrowser: false,
  editingFolderId: null,
  view: 'chat',
  activePipelineId: null,
  connected: false,
  usage: null,
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
      const { [action.payload]: _, ...rest } = state.streamingContent
      return { ...state, streamingContent: rest }
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
      return { ...state, messages: restMessages }
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

    default:
      return state
  }
}

// === Context ===

interface AppContextValue {
  state: State
  dispatch: React.Dispatch<Action>
  selectInstance: (id: string | null) => void
  sendMessage: (instanceId: string, text: string, images?: string[]) => Promise<void>
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

    return () => {
      unsubs.forEach((unsub) => unsub())
    }
  }, [])

  // Select instance and fetch history
  const selectInstance = useCallback(
    (id: string | null) => {
      dispatch({ type: 'SELECT_INSTANCE', payload: id })
      if (id) {
        dispatch({ type: 'CLEAR_UNREAD', payload: id })
        if (!state.messages[id]) {
          api.getHistory(id).then((data) => {
            const messages = (data as any).messages ?? data
            dispatch({ type: 'SET_MESSAGES', payload: { instanceId: id, messages } })
          }).catch((err) => {
            console.error('Failed to fetch history:', err)
          })
        }
      }
    },
    [state.messages]
  )

  // Send a message to an instance
  const sendMessage = useCallback(
    async (instanceId: string, text: string, images?: string[]) => {
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
      await api.sendMessage(instanceId, { text, images })
    },
    []
  )

  const value: AppContextValue = { state, dispatch, selectInstance, sendMessage }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

// === Hook ===

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within an AppProvider')
  return ctx
}
