// === FOLDERS & INSTANCES ===

export interface FolderConfig {
  id: string
  path: string
  name: string
  displayName?: string
  emoji?: string
  client?: string
  projectType?: 'landing-page' | 'saas-app' | 'static-site' | 'game' | 'utility' | 'other'
  color?: string
  status?: 'active' | 'paused' | 'archived'
  repoUrl?: string
  notes?: string
  expanded: boolean
  sortOrder: number
  createdAt: number
  orchestratorActive?: boolean
  stealthMode?: boolean
}

export interface InstanceConfig {
  id: string
  folderId: string
  name: string
  cwd: string
  sessionId?: string
  state: 'idle' | 'running' | 'paused'
  agentId?: string
  idleRestartMinutes: number
  sortOrder: number
  createdAt: number
  agentRole?: 'planner' | 'builder' | 'tester' | 'promoter'
  specialization?: string
  orchestratorManaged?: boolean
  activeTaskId?: string
  activeTaskTitle?: string
  taskStartedAt?: number
  xpTotal?: number
  level?: number
  overdriveTasks?: number
  overdriveStartedAt?: number
  lastTaskAt?: number
}

// === CHAT MESSAGES ===

export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mediaType: string }
  | { type: 'tool-call'; toolId: string; toolName: string; input: string }
  | { type: 'tool-result'; toolId: string; output: string; isError?: boolean }
  | { type: 'cost'; inputTokens: number; outputTokens: number; costUsd?: number; durationMs?: number }
  | { type: 'error'; message: string }
  | { type: 'orc-brief'; taskTitle: string; taskId: string; instanceName: string }

export interface ChatMessage {
  id: string
  instanceId: string
  role: 'user' | 'assistant' | 'system'
  content: MessageContentBlock[]
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  createdAt: number
}

// === CLAUDE PROCESS EVENTS ===

export type ClaudeStreamEvent =
  | { type: 'text-delta'; instanceId: string; text: string }
  | { type: 'tool-start'; instanceId: string; toolId: string; toolName: string }
  | { type: 'tool-input-delta'; instanceId: string; toolId: string; input: string }
  | { type: 'tool-complete'; instanceId: string; toolId: string; output: string; isError?: boolean }
  | { type: 'result'; instanceId: string; sessionId?: string; costUsd?: number; inputTokens?: number; outputTokens?: number; durationMs?: number }
  | { type: 'error'; instanceId: string; message: string }
  | { type: 'system'; instanceId: string; sessionId?: string }
  | { type: 'raw-line'; instanceId: string; line: string; isStderr?: boolean }

export interface ClaudeProcessExitEvent {
  instanceId: string
  sessionId?: string
  exitCode: number | null
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
}

// === PIPELINE ===

export type PipelineColumn = 'backlog' | 'spec' | 'build' | 'qa' | 'staging' | 'ship' | 'done'

export interface TaskAttachment {
  id: string
  name: string
  dataUrl: string
}

export interface PipelineTask {
  id: string
  projectId: string
  title: string
  description: string
  column: PipelineColumn
  priority: 1 | 2 | 3 | 4
  labels: string[]
  attachments: TaskAttachment[]
  assignedAgent?: string
  groupId?: string
  groupIndex?: number
  groupTotal?: number
  dependsOn: string[]
  createdBy: string
  history: TaskHistoryEntry[]
  completedAt?: number
  createdAt: number
  updatedAt: number
  lockedBy?: string
  lockedAt?: number
  retryCount?: number
}

export interface TaskComment {
  id: string
  taskId: string
  author: string
  body: string
  createdAt: number
}

export interface TaskHistoryEntry {
  action: 'created' | 'moved' | 'claimed' | 'blocked' | 'unblocked' | 'edited' | 'completed'
  timestamp: number
  agent?: string
  from?: string
  to?: string
  note?: string
}

export interface PipelineEvent {
  projectId: string
  taskId: string
  action: string
  newColumn?: PipelineColumn
}

// === AGENTS & SKILLS ===

export interface AgentConfig {
  id: string
  name: string
  content: string
  level: number        // 0=empty, 1=identity, 2=behavior, 3=full
  skills: string[]
  mcpServers: string[]
  createdAt: number
}

export interface SkillConfig {
  id: string
  name: string
  description: string
  content: string
  tags: string[]
  createdAt: number
}

// === SETTINGS ===

export interface AppSettings {
  globalFlags: string[]
  idleTimeoutSeconds: number
  notifications: boolean
  startWithOS: boolean
  rootFolder: string
  usagePollMinutes: number
  theme: 'light' | 'dark' | 'system'
  port: number
  orchestratorAgentNames?: { planner: string; builder: string; tester: string; promoter: string }
  orchestratorAllowSpawn?: boolean
  userName?: string
  userEmoji?: string
  columnLabels?: Partial<Record<PipelineColumn, string>>
  animationsEnabled?: boolean
  soundsEnabled?: boolean
  namingTheme?: 'fruits' | 'rpg' | 'wow' | 'memes'
}

// === USAGE MONITORING ===

export interface UsageBucket {
  label: string
  used: number
  limit: number
  percentage: number
  resetsAt?: string
  resetCountdown?: string
}

export interface UsageData {
  connected: boolean
  buckets: UsageBucket[]
  lastUpdated?: number
}

// === GAMIFICATION ===

export interface AccountProfile {
  accountLevel: number
  totalXp: number
  messagesSent: number
  tokensSent: number
  tokensReceived: number
}

export interface TourState {
  completedSteps: string[]
  currentLevel: number
  levelChallengesCompleted: string[]
  dismissedHints: string[]
  onboardingComplete: boolean
}

export type XpEventType =
  | 'tour-step' | 'challenge' | 'agent-created' | 'skill-created'
  | 'message-sent' | 'session-complete'
  | 'lesson-completed' | 'knowledge-base-created' | 'first-pipeline-task'

// === WEBSOCKET MESSAGES ===

export interface WsMessage {
  type: string
  payload: unknown
}

// === API STATE ===

export interface AppState {
  folders: FolderConfig[]
  instances: InstanceConfig[]
  settings: AppSettings
}
