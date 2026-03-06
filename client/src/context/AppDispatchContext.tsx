import React, { createContext, useContext } from 'react'
import type { Action } from './AppContext'

export interface AppDispatchContextValue {
  dispatch: React.Dispatch<Action>
  selectInstance: (id: string | null) => void
  sendMessage: (instanceId: string, text: string, images?: string[], flags?: string[]) => Promise<void>
  deleteInstance: (id: string) => Promise<void>
  loadOlderMessages: (instanceId: string) => Promise<void>
}

const defaultValue: AppDispatchContextValue = {
  dispatch: () => {},
  selectInstance: () => {},
  sendMessage: async () => {},
  deleteInstance: async () => {},
  loadOlderMessages: async () => {},
}

export const AppDispatchContext = createContext<AppDispatchContextValue>(defaultValue)

export function useAppDispatch(): AppDispatchContextValue {
  return useContext(AppDispatchContext)
}
