import React, { createContext, useContext } from 'react'
import type { Action } from './AppContext'

export interface AppDispatchContextValue {
  dispatch: React.Dispatch<Action>
  selectInstance: (id: string | null) => void
  /** Add an instance as a grid tile (focuses it if already present) and hydrate it */
  addToGrid: (id: string) => void
  /** Add an instance as a grid tile WITHOUT navigating or moving the focus/maximized tile */
  addToGridBackground: (id: string) => void
  /** The chat a scheduled fire surfaced has been looked at: drop its bright status everywhere. */
  ackSurface: (id: string) => void
  sendMessage: (instanceId: string, text: string, images?: string[], flags?: string[]) => Promise<void>
  deleteInstance: (id: string) => Promise<void>
  /** Close a session AND permanently scrub secrets from its transcript file. */
  secureCloseInstance: (id: string, name: string, taskStatus?: 'done' | 'inbox') => Promise<void>
  loadOlderMessages: (instanceId: string) => Promise<void>
}

const defaultValue: AppDispatchContextValue = {
  dispatch: () => {},
  selectInstance: () => {},
  addToGrid: () => {},
  addToGridBackground: () => {},
  ackSurface: () => {},
  sendMessage: async () => {},
  deleteInstance: async () => {},
  secureCloseInstance: async () => {},
  loadOlderMessages: async () => {},
}

export const AppDispatchContext = createContext<AppDispatchContextValue>(defaultValue)

export function useAppDispatch(): AppDispatchContextValue {
  return useContext(AppDispatchContext)
}
