import type {
  AppState,
  FolderConfig,
  InstanceConfig,
  ChatMessage,
  PipelineTask,
  TaskComment,
  AppSettings,
  UsageData,
  AccountProfile,
  TourState,
  AgentConfig,
  SkillConfig,
  XpEventType,
  PipelineColumn,
  SavingsSummary,
  McpServerInfo,
  ScheduleConfig,
} from '@shared/types'

const BASE = import.meta.env.VITE_API_URL || ''

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
  return res.json()
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
  return res.json()
}

async function put<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
  return res.json()
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
  return res.json()
}

// === REST API ===

export const rest = {
  get,

  // State
  getState: () => get<AppState>('/api/state'),
  getHealth: () => get<{ status: string; uptime: number; clients: number; processes: number; totalInstances: number; runningInstances: number; memoryMb: number; heapMb: number }>('/api/health'),
  getProcesses: () => get<{ processes: Array<{ instanceId: string; instanceName: string; agentRole: string | null; pid: number; state: string; runningSec: number; taskId: string | null; taskTitle: string | null; lastCostUsd: number | null; lastInputTokens: number | null; lastOutputTokens: number | null }>; timestamp: number }>('/api/processes'),

  // Folders
  createFolder: (data: Partial<FolderConfig>) => post<FolderConfig>('/api/folders', data),
  updateFolder: (id: string, data: Partial<FolderConfig>) => put<FolderConfig>(`/api/folders/${id}`, data),
  deleteFolder: (id: string) => del<{ ok: true }>(`/api/folders/${id}`),
  reorderFolders: (ids: string[]) => put<{ ok: true }>('/api/folders/reorder', { ids }),

  // Instances
  createInstance: (data: Partial<InstanceConfig>) => post<InstanceConfig>('/api/instances', data),
  updateInstance: (id: string, data: Partial<InstanceConfig>) => put<InstanceConfig>(`/api/instances/${id}`, data),
  deleteInstance: (id: string) => del<{ ok: true }>(`/api/instances/${id}`),
  reorderInstances: (ids: string[]) => put<{ ok: true }>('/api/instances/reorder', { ids }),

  // Claude session control
  sendMessage: (instanceId: string, data: { text?: string; images?: string[]; flags?: string[] }) =>
    post<{ ok: true }>(`/api/instances/${instanceId}/send`, data),
  pauseInstance: (instanceId: string) =>
    post<{ ok: true }>(`/api/instances/${instanceId}/pause`),
  resumeInstance: (instanceId: string) =>
    post<{ ok: true }>(`/api/instances/${instanceId}/resume`),
  syncSession: (instanceId: string) =>
    post<{ ok: true }>(`/api/instances/${instanceId}/sync`),

  // History
  getHistory: (instanceId: string, params?: { before?: number; limit?: number }) => {
    const query = new URLSearchParams()
    if (params?.before) query.set('before', String(params.before))
    if (params?.limit) query.set('limit', String(params.limit))
    const qs = query.toString()
    return get<{ messages: ChatMessage[]; hasMore: boolean }>(`/api/instances/${instanceId}/history${qs ? `?${qs}` : ''}`)
  },
  addMessage: (instanceId: string, message: Partial<ChatMessage>) =>
    post<ChatMessage>(`/api/instances/${instanceId}/history`, message),
  clearHistory: (instanceId: string) =>
    del<{ ok: true }>(`/api/instances/${instanceId}/history`),

  // Pipeline
  getPipelines: () => get<Record<string, PipelineTask[]>>('/api/pipelines'),
  getProjectPipeline: (projectId: string, includeDone?: boolean) =>
    get<PipelineTask[]>(`/api/pipelines/${projectId}${includeDone ? '?includeDone=true' : ''}`),
  getTask: (projectId: string, taskId: string) => get<PipelineTask>(`/api/pipelines/${projectId}/tasks/${taskId}`),
  createTask: (projectId: string, data: Partial<PipelineTask>) =>
    post<PipelineTask>(`/api/pipelines/${projectId}/tasks`, data),
  updateTask: (projectId: string, taskId: string, data: Partial<PipelineTask>) =>
    put<PipelineTask>(`/api/pipelines/${projectId}/tasks/${taskId}`, data),
  deleteTask: (projectId: string, taskId: string) =>
    del<{ ok: true }>(`/api/pipelines/${projectId}/tasks/${taskId}`),
  moveTask: (projectId: string, taskId: string, column: PipelineColumn) =>
    post<PipelineTask>(`/api/pipelines/${projectId}/tasks/${taskId}/move`, { column }),
  claimTask: (projectId: string, taskId: string, agentRole: string) =>
    post<PipelineTask>(`/api/pipelines/${projectId}/tasks/${taskId}/claim`, { agentRole }),
  blockTask: (projectId: string, taskId: string, reason: string) =>
    post<PipelineTask>(`/api/pipelines/${projectId}/tasks/${taskId}/block`, { reason }),
  unblockTask: (projectId: string, taskId: string) =>
    post<PipelineTask>(`/api/pipelines/${projectId}/tasks/${taskId}/unblock`),
  getNextTask: (projectId: string, column: PipelineColumn) =>
    get<PipelineTask | null>(`/api/pipelines/${projectId}/next?column=${column}`),
  getTaskComments: (projectId: string, taskId: string) =>
    get<TaskComment[]>(`/api/pipelines/${projectId}/tasks/${taskId}/comments`),
  addTaskComment: (projectId: string, taskId: string, data: { author?: string; body: string }) =>
    post<TaskComment>(`/api/pipelines/${projectId}/tasks/${taskId}/comments`, data),
  updateTaskSchedule: (projectId: string, taskId: string, schedule: ScheduleConfig) =>
    put<PipelineTask>(`/api/pipelines/${projectId}/tasks/${taskId}/schedule`, schedule),
  getScheduledUpcoming: (projectId: string, days = 30) =>
    get<Array<{
      id: string; title: string; skill?: string
      schedule: ScheduleConfig | null
      executions: unknown[]
      nextRunAt?: number
      withinHorizon: boolean
      currentlyRunning: boolean
    }>>(`/api/pipelines/${projectId}/scheduled-upcoming?days=${days}`),

  // Settings
  getSettings: () => get<AppSettings>('/api/settings'),
  updateSettings: (data: Partial<AppSettings>) => put<AppSettings>('/api/settings', data),

  // Usage
  getUsage: () => get<UsageData>('/api/usage'),
  getAuthUrl: () => get<{ url: string }>('/api/usage/auth-url'),
  exchangeCode: (code: string) => post<{ ok: true }>('/api/usage/exchange', { code }),
  disconnectUsage: () => post<{ ok: true }>('/api/usage/disconnect'),
  refreshUsage: () => post<UsageData>('/api/usage/refresh'),
  getSavings: (days = 7) => get<SavingsSummary>(`/api/usage/savings?days=${days}`),

  // Profile / Gamification
  getProfile: () => get<AccountProfile>('/api/profile'),
  updateProfile: (data: Partial<AccountProfile>) => put<AccountProfile>('/api/profile', data),
  addXp: (eventType: XpEventType, multiplier?: number) =>
    post<{ xpAdded: number; leveledUp: boolean; profile: AccountProfile }>('/api/profile/xp', { eventType, multiplier }),
  getTour: () => get<TourState>('/api/tour'),
  updateTour: (data: Partial<TourState>) => put<TourState>('/api/tour', data),
  completeStep: (step: string) => post<TourState>('/api/tour/complete-step', { step }),
  dismissHint: (hint: string) => post<TourState>('/api/tour/dismiss-hint', { hint }),

  // Agents
  getAgents: () => get<AgentConfig[]>('/api/agents'),
  getAgent: (id: string) => get<AgentConfig>(`/api/agents/${id}`),
  createAgent: (data: Partial<AgentConfig>) => post<AgentConfig>('/api/agents', data),
  updateAgent: (id: string, data: Partial<AgentConfig>) => put<AgentConfig>(`/api/agents/${id}`, data),
  deleteAgent: (id: string) => del<{ ok: true }>(`/api/agents/${id}`),
  scanAgents: () => post<AgentConfig[]>('/api/agents/scan'),

  // Skills
  getSkills: () => get<SkillConfig[]>('/api/skills'),
  createSkill: (data: Partial<SkillConfig>) => post<SkillConfig>('/api/skills', data),
  deleteSkill: (id: string) => del<{ ok: true }>(`/api/skills/${id}`),

  // Orchestrator
  activateOrchestrator: (folderId: string) => post<{ ok: true; active: boolean }>(`/api/orchestrator/${folderId}/activate`),
  deactivateOrchestrator: (folderId: string) => post<{ ok: true; active: boolean }>(`/api/orchestrator/${folderId}/deactivate`),
  getOrchestratorStatus: (folderId: string) => get<{ folderId: string; active: boolean; idleAgents: number; runningAgents: number; pendingTasks: number }>(`/api/orchestrator/${folderId}/status`),
  pauseAll: (folderId: string) => post<{ paused: number }>(`/api/folders/${folderId}/pause-all`),
  releaseAll: (folderId: string) => post<{ released: number; instanceIds: string[] }>(`/api/folders/${folderId}/release-all`),
  shutdownAll: () => post<{ killed: number; instanceIds: string[] }>('/api/shutdown'),
  terminate: () => post<{ ok: true; killed: number; instanceIds: string[] }>('/api/terminate'),
  killInstance: (id: string) => post<{ killed: boolean }>(`/api/instances/${id}/kill`),

  // MCP server discovery
  getMcpAvailable: () => get<{ servers: McpServerInfo[] }>('/api/mcp/available'),

  // File browser
  browsePath: (dirPath: string) =>
    get<{ dir: string; items: Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean }> }>(
      `/api/fs/browse?dir=${encodeURIComponent(dirPath)}`
    ),
  getSubfolders: (dirPath?: string) =>
    get<{ dir: string; folders: Array<{ name: string; path: string }> }>(
      `/api/fs/subfolders${dirPath ? `?dir=${encodeURIComponent(dirPath)}` : ''}`
    ),
  checkClaudeMd: (dirPath: string) =>
    get<{ exists: boolean; path: string; content: string | null }>(
      `/api/fs/claude-md?dir=${encodeURIComponent(dirPath)}`
    ),
  writeClaudeMd: (dirPath: string, content: string) =>
    put<{ ok: boolean; path: string }>(
      `/api/fs/claude-md?dir=${encodeURIComponent(dirPath)}`,
      { content }
    ),

  // Usage log
  getUsageLog: (limit = 100, days?: number) =>
    get<Array<{ session_id: string; role: string; task_title: string | null; project_name: string | null; cost_usd: number; input_tokens: number; output_tokens: number; created_at: number }>>(
      `/api/usage/log?limit=${limit}${days ? `&days=${days}` : ''}`
    ),
  getUsageByProject: (days?: number) =>
    get<Array<{ project_name: string; total_cost_usd: number; session_count: number }>>(
      `/api/usage/log/by-project${days ? `?days=${days}` : ''}`
    ),
  getUsageStats: (days = 7) =>
    get<{
      summary: { total_cost_usd: number; total_sessions: number; avg_cost_per_session: number; cache_hit_ratio: number; total_input_tokens: number; total_output_tokens: number };
      byRole: Array<{ role: string; session_count: number; total_cost_usd: number; avg_cost_usd: number; cache_hit_ratio: number }>;
      byWeekday: Array<{ weekday: number; label: string; session_count: number; total_cost_usd: number }>;
      byDay: Array<{ day: string; session_count: number; total_cost_usd: number }>;
    }>(`/api/usage/stats?days=${days}`),
}
