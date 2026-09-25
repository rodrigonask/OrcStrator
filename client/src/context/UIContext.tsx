import { createContext, useContext } from 'react'
import type { AppSettings, UsageData, VerbosityLevel, SessionCostState } from '@shared/types'

export type ViewName = 'grid' | 'chat' | 'pipeline' | 'monitor' | 'agents' | 'usage' | 'sessions' | 'skills' | 'activity'

export interface GridNotice {
  evictedId: string
  at: number
}

/** Drives the security scan banner shown when a session is closed-and-scrubbed. */
/**
 * Where the close-time summary ended up. Arrives seconds AFTER the close itself, on the
 * `session:summary` WS event, because the Haiku call runs in the background.
 */
export interface SessionLogResult {
  /** The board task the summary landed on, or null if it could not be filed anywhere. */
  taskId: string | null
  /** False when the summary call failed and a placeholder was filed in its place. */
  ok: boolean
  /** True when a chat that came from no task was filed AS a new task (Session Summary = "all"). */
  loggedAsNewTask: boolean
  /** Title of the task it landed on. Absent on servers older than this field, null if deleted. */
  taskTitle?: string | null
}

export interface SecurityNotice {
  /** The closed instance's id. */
  id: string
  /** Name shown in the banner (instance no longer exists once closed). */
  name: string
  phase: 'scanning' | 'done' | 'error'
  apiKeys: number
  passwords: number
  at: number
  /**
   * The server said a background summary is on its way, so this notice is not finished
   * yet: it waits (dismissible, but on a long timer) for `log` to land instead of
   * auto-dismissing and letting the summary arrive as a SECOND banner to dismiss.
   */
  pendingLog?: boolean
  /** Where the close-time summary ended up, once it reports back. */
  log?: SessionLogResult
}

export interface UIContextValue {
  view: ViewName
  selectedInstanceId: string | null
  /** Ordered list of instance ids shown as grid tiles (max 8) */
  gridInstanceIds: string[]
  /** Currently focused grid tile (accent border) */
  gridFocusedId: string | null
  /** Tile expanded in-place to fill the grid view (others stay mounted, hidden) */
  gridMaximizedId: string | null
  /** Transient notice shown when a tile was evicted to make room */
  gridNotice: GridNotice | null
  /** Security scan banner shown while/after a closed session is scrubbed */
  securityNotice: SecurityNotice | null
  /** Instances bumped out of a full grid (not manually closed) — the "Recent" list */
  gridEvicted: string[]
  sidebarCollapsed: boolean
  terminalPanelOpen: boolean
  showSettings: boolean
  showFolderBrowser: boolean
  editingFolderId: string | null
  activePipelineId: string | null
  /** Task the pipeline board should open as soon as that project's tasks have loaded. */
  pendingTaskFocusId: string | null
  connected: boolean
  serverRestarted: boolean
  usage: UsageData | null
  settings: AppSettings
  verbosityOverrides: Record<string, VerbosityLevel>
  sessionCosts: Record<string, SessionCostState>
  historyErrors: Record<string, string>
}

const defaultSettings: AppSettings = {
  globalFlags: [],
  idleTimeoutSeconds: 60,
  notifications: true,
  startWithOS: false,
  rootFolder: '',
  usagePollMinutes: 1,
  theme: 'system',
  port: 3334,
}

const defaultValue: UIContextValue = {
  view: 'grid',
  selectedInstanceId: null,
  gridInstanceIds: [],
  gridFocusedId: null,
  gridMaximizedId: null,
  gridNotice: null,
  securityNotice: null,
  gridEvicted: [],
  sidebarCollapsed: false,
  terminalPanelOpen: false,
  showSettings: false,
  showFolderBrowser: false,
  editingFolderId: null,
  activePipelineId: null,
  pendingTaskFocusId: null,
  connected: false,
  serverRestarted: false,
  usage: null,
  settings: defaultSettings,
  verbosityOverrides: {},
  sessionCosts: {},
  historyErrors: {},
}

export const UIContext = createContext<UIContextValue>(defaultValue)

export function useUI(): UIContextValue {
  return useContext(UIContext)
}
