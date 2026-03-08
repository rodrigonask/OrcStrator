import { createContext, useContext } from 'react'
import type { AppSettings, UsageData, PipelineColumn } from '@shared/types'

/** Maps pipeline columns to the agent role responsible for that phase */
export const COLUMN_TO_ROLE: Partial<Record<PipelineColumn, string>> = {
  spec: 'planner',
  build: 'builder',
  qa: 'tester',
  ship: 'promoter',
}

/** Inverse mapping: agent role → pipeline column */
export const ROLE_TO_COLUMN: Record<string, PipelineColumn> = {
  planner: 'spec',
  builder: 'build',
  tester: 'qa',
  promoter: 'ship',
}

export interface UIContextValue {
  view: 'chat' | 'pipeline' | 'monitor' | 'agents' | 'usage'
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
}

export const UIContext = createContext<UIContextValue>(defaultValue)

export function useUI(): UIContextValue {
  return useContext(UIContext)
}
