// === VERBOSITY ===

export type VerbosityLevel = 1 | 2 | 3 | 4 | 5

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
  cloudSync?: boolean
  lastSyncedAt?: number
}

export type ProcessState = 'idle' | 'reserved' | 'spawning' | 'running' | 'exiting'

export interface InstanceConfig {
  id: string
  folderId: string
  name: string
  cwd: string
  sessionId?: string
  state: 'idle' | 'running' | 'paused'
  processState?: ProcessState
  agentId?: string
  idleRestartMinutes: number
  sortOrder: number
  createdAt: number
  agentRole?: 'planner' | 'builder' | 'tester' | 'promoter' | 'scheduler'
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
  contextHealth?: 'cold' | 'fresh' | 'warm' | 'heavy' | 'stale'
  ctxTokens?: number
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
  | { type: 'result'; instanceId: string; sessionId?: string; costUsd?: number; inputTokens?: number; outputTokens?: number; durationMs?: number; cacheCreationTokens?: number; cacheReadTokens?: number; resultText?: string }
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

// === TOKEN SAVINGS ===

export interface DailySavingsEntry {
  day: string
  totalInput: number
  cacheRead: number
  cacheCreation: number
  coldInput: number
  totalOutput: number
  totalCost: number
  sessions: number
  overdriveSessions: number
}

export interface SavingsSummary {
  days: DailySavingsEntry[]
  totalCacheRead: number
  totalSessions: number
  overdriveSessions: number
  overdrivePct: number
  savedTokens: number
  savedUsd: number
  recommendation: string | null
}

// === USAGE ANALYTICS ===

export interface UsageTrendDay {
  day: string
  coldInput: number
  cacheCreation: number
  cacheRead: number
  outputTokens: number
  costUsd: number
  sessions: number
}

export interface UsageByColumn {
  column: string
  costUsd: number
  sessions: number
}

export interface UsageForecast {
  projectedMonthly: number
  dailyRate: number
  r2: number
}

export interface UsageAnomaly {
  sessionId: string
  role: string
  costUsd: number
  medianCost: number
  multiplier: number
  taskTitle: string | null
  createdAt: number
  isAnomaly: boolean
}

export interface UsageEfficiencyDay {
  day: string
  yieldRatio: number
  avgPromptChars: number
  cacheGrade: 'A' | 'B' | 'C' | 'D' | 'F'
}

// === PIPELINE ===

export type PipelineColumn = 'backlog' | 'ready' | 'in_progress' | 'in_review' | 'done' | 'scheduled'

export interface BlueprintStep {
  role: string           // 'planner' | 'builder' | 'tester' | 'promoter' | 'scheduler'
  agentId?: string       // optional FK to agents table
  instruction?: string   // default instruction for this step
}

export interface PipelineBlueprint {
  id: string
  name: string
  steps: BlueprintStep[]
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

export interface TaskAttachment {
  id: string
  name: string
  dataUrl: string
}

export interface ScheduleConfig {
  type: 'once' | 'daily' | 'weekly' | 'interval' | 'monthly'
  enabled: boolean
  // once
  runAt?: number
  // daily
  hours?: number[]
  // weekly
  days?: number[]
  weeklyHour?: number
  // interval
  intervalValue?: number
  intervalUnit?: 'hours' | 'days' | 'weeks'
  // monthly
  dayOfMonth?: number
  monthlyHour?: number
  // runtime (server-managed)
  nextRunAt?: number
  lastRunAt?: number
  fireCount?: number
  currentlyRunning?: boolean
  currentInstanceId?: string
}

export interface ScheduleExecution {
  runId: string
  startedAt: number
  endedAt?: number
  instanceId: string
  status: 'running' | 'completed' | 'failed'
  summary?: string
  tokensUsed?: number
  costUsd?: number
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
  schedule?: ScheduleConfig
  executions?: ScheduleExecution[]
  skill?: string
  totalInputTokens?: number
  totalOutputTokens?: number
  totalCostUsd?: number
  pipelineId?: string
  currentStep?: number          // 1-indexed
  totalSteps?: number
  currentStepRole?: string      // denormalized for efficient DB query
  stepInstructions?: Record<string, string>  // "1" → instruction override
}

export interface TaskComment {
  id: string
  taskId: string
  author: string
  body: string
  createdAt: number
}

export interface TaskHistoryEntry {
  action: 'created' | 'moved' | 'claimed' | 'blocked' | 'unblocked' | 'edited' | 'completed' | 'pipeline reset' | 'pipeline changed'
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

export interface AgentPersonality {
  disc?: { D: number; I: number; S: number; C: number }
  mbti?: string
  big5?: { O: number; C: number; E: number; A: number; N: number }
  tone?: 'formal' | 'casual' | 'playful' | 'technical'
  formality?: number
}

export interface AgentConfig {
  id: string
  name: string
  content: string
  level: number        // 0=empty, 1=identity, 2=behavior, 3=full
  skills: string[]
  mcpServers: string[]
  personality?: AgentPersonality | null
  source?: 'user' | 'native'
  role?: string        // agent's default role (planner/builder/tester/promoter/scheduler)
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

// === MCP SERVER DISCOVERY ===

export interface McpServerInfo {
  name: string
  type: string
  source: string    // 'global' | 'project:<dir>'
  command?: string
}

// === SETTINGS ===

export type PermissionMode = 'bypass' | 'plan' | 'default'
export type AgentModel = 'haiku' | 'sonnet' | 'opus' | 'default'
export type AgentRole = 'planner' | 'builder' | 'tester' | 'promoter' | 'scheduler'

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
  orchestratorMcpServers?: { planner: string[]; builder: string[]; tester: string[]; promoter: string[] }
  orchestratorModels?: Record<AgentRole, AgentModel>
  orchestratorTools?: Record<AgentRole, string[]>
  permissionMode?: PermissionMode
  disableCache?: boolean
  maxTokens?: number
  userName?: string
  userEmoji?: string
  columnLabels?: Partial<Record<PipelineColumn, string>>
  animationsEnabled?: boolean
  soundsEnabled?: boolean
  animationTier?: 0 | 1 | 2 | 3 | 4
  soundTier?: 0 | 1 | 2 | 3 | 4
  namingTheme?: 'fruits' | 'rpg' | 'wow' | 'memes'
  maxConcurrentProcesses?: number
  verbosity?: VerbosityLevel
  // Cloud Sync (Supabase)
  cloudSyncUrl?: string
  cloudSyncKey?: string
  machineName?: string
  machineId?: string
  customCommands?: Array<{ name: string; command: string; description: string }>
}

// === CLOUD SYNC ===

export type CloudSyncStatus = 'disconnected' | 'connected' | 'syncing' | 'error'

export interface CloudSyncState {
  status: CloudSyncStatus
  lastSyncedAt?: number
  error?: string
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
  tasksDone: number
}

export interface TourState {
  completedSteps: string[]
  currentLevel: number
  levelChallengesCompleted: string[]
  dismissedHints: string[]
  onboardingComplete: boolean
  guidedMode?: 'guided' | 'god'
}

export type XpEventType =
  | 'tour-step' | 'challenge' | 'agent-created' | 'skill-created'
  | 'message-sent' | 'session-complete'
  | 'lesson-completed' | 'knowledge-base-created' | 'first-pipeline-task'

// === ORCHESTRATOR LOG ===

export type OrcLogEventType =
  | 'assigned' | 'task_moved' | 'task_stuck' | 'process_exited'
  | 'cooldown_hit' | 'concurrency_limit' | 'lock_timeout'
  | 'spawn_failed' | 'zombie_detected'
  | 'sweep_ran' | 'session_resumed'
  | 'no_idle_agents'

export interface OrcLogEntry {
  id: number
  type: OrcLogEventType | string
  timestamp: number
  instanceId?: string
  instanceName?: string
  agentRole?: string
  taskId?: string
  taskTitle?: string
  detail?: string
}

export type OrcLogFilter = 'all' | 'errors' | 'assignments'

// === SESSION FILES ===

export interface SessionFile {
  sessionId: string
  instanceId?: string
  instanceName?: string
  folderId?: string
  folderName?: string
  folderEmoji?: string
  mtime: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  lineCount: number
}

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
