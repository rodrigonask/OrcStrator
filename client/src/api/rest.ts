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
  // State
  getState: () => get<AppState>('/api/state'),

  // Folders
  createFolder: (data: Partial<FolderConfig>) => post<FolderConfig>('/api/folders', data),
  updateFolder: (id: string, data: Partial<FolderConfig>) => put<FolderConfig>(`/api/folders/${id}`, data),
  deleteFolder: (id: string) => del<{ ok: true }>(`/api/folders/${id}`),
  reorderFolders: (ids: string[]) => put<{ ok: true }>('/api/folders/reorder', { ids }),

  // Instances
  createInstance: (data: Partial<InstanceConfig>) => post<InstanceConfig>('/api/instances', data),
  updateInstance: (id: string, data: Partial<InstanceConfig>) => put<InstanceConfig>(`/api/instances/${id}`, data),
  deleteInstance: (id: string) => del<{ ok: true }>(`/api/instances/${id}`),

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
  getProjectPipeline: (projectId: string) => get<PipelineTask[]>(`/api/pipelines/${projectId}`),
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

  // Settings
  getSettings: () => get<AppSettings>('/api/settings'),
  updateSettings: (data: Partial<AppSettings>) => put<AppSettings>('/api/settings', data),

  // Usage
  getUsage: () => get<UsageData>('/api/usage'),
  getAuthUrl: () => get<{ url: string }>('/api/usage/auth-url'),
  exchangeCode: (code: string) => post<{ ok: true }>('/api/usage/exchange', { code }),
  disconnectUsage: () => post<{ ok: true }>('/api/usage/disconnect'),
  refreshUsage: () => post<UsageData>('/api/usage/refresh'),

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

  // File browser
  browsePath: (dirPath: string) =>
    get<{ dir: string; items: Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean }> }>(
      `/api/fs/browse?dir=${encodeURIComponent(dirPath)}`
    ),
  getSubfolders: (dirPath: string) =>
    get<{ dir: string; folders: Array<{ name: string; path: string }> }>(
      `/api/fs/subfolders?dir=${encodeURIComponent(dirPath)}`
    ),
  checkClaudeMd: (dirPath: string) =>
    get<{ exists: boolean; path: string; content: string | null }>(
      `/api/fs/claude-md?dir=${encodeURIComponent(dirPath)}`
    ),
}
