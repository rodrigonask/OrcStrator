import { createContext, useContext } from 'react'
import type { AppSettings, UsageData, VerbosityLevel, SessionCostState } from '@shared/types'

export interface UIContextValue {
  view: 'chat' | 'pipeline' | 'monitor' | 'agents' | 'usage' | 'sessions'
  selectedInstanceId: string | null
  sidebarCollapsed: boolean
  terminalPanelOpen: boolean
  showSettings: boolean
  showFolderBrowser: boolean
  editingFolderId: string | null
  activePipelineId: string | null
  connected: boolean
  serverRestarted: boolean
  usage: UsageData | null
  settings: AppSettings
  gameActive: boolean
  verbosityOverrides: Record<string, VerbosityLevel>
  sessionCosts: Record<string, SessionCostState>
}

const defaultSettings: AppSettings = {
  globalFlags: [],
  idleTimeoutSeconds: 60,
  notifications: true,
  startWithOS: false,
  rootFolder: '',
  usagePollMinutes: 10,
  theme: 'system',
  port: 3333,
}

const defaultValue: UIContextValue = {
  view: 'chat',
  selectedInstanceId: null,
  sidebarCollapsed: false,
  terminalPanelOpen: false,
  showSettings: false,
  showFolderBrowser: false,
  editingFolderId: null,
  activePipelineId: null,
  connected: false,
  serverRestarted: false,
  usage: null,
  settings: defaultSettings,
  gameActive: false,
  verbosityOverrides: {},
  sessionCosts: {},
}

export const UIContext = createContext<UIContextValue>(defaultValue)

export function useUI(): UIContextValue {
  return useContext(UIContext)
}
