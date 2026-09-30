import type {
  AppState,
  ActivityEntry,
  FolderConfig,
  InstanceConfig,
  ChatMessage,
  PipelineTask,
  TaskComment,
  AppSettings,
  PermissionMode,
  UsageData,
  AccountProfile,
  AgentConfig,
  SkillConfig,
  SkillInventory,
  PipelineColumn,
  SavingsSummary,
  CompactionSavingsSummary,
  McpServerInfo,
  UsageTrendDay,
  UsageByColumn,
  UsageForecast,
  UsageAnomaly,
  UsageEfficiencyDay,
  SessionFile,
  SessionCostState,
  TaskRun,
  PermissionRuleSet,
} from '@shared/types'
import type { PermissionUpdate } from '@shared/permission-rules'
import { authFetch } from './auth'

const BASE = import.meta.env.VITE_API_URL || ''

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
  return res.json()
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.clone().json() as { message?: string; error?: string }
    return body.message || body.error || fallback
  } catch {
    try {
      const text = await res.clone().text()
      return text.trim() || fallback
    } catch {
      return fallback
    }
  }
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await authFetch(`${BASE}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const msg = await readErrorMessage(res, `${res.status} ${res.statusText}`)
    throw new Error(msg)
  }
  return res.json()
}

async function put<T>(path: string, body?: unknown): Promise<T> {
  const res = await authFetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const msg = await readErrorMessage(res, `${res.status} ${res.statusText}`)
    throw new Error(msg)
  }
  return res.json()
}

async function del<T>(path: string): Promise<T> {
  const res = await authFetch(`${BASE}${path}`, { method: 'DELETE' })
  if (!res.ok) {
    const msg = await readErrorMessage(res, `${res.status} ${res.statusText}`)
    throw new Error(msg)
  }
  return res.json()
}

async function patch<T>(path: string, body?: unknown): Promise<T> {
  const res = await authFetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const msg = await readErrorMessage(res, `${res.status} ${res.statusText}`)
    throw new Error(msg)
  }
  return res.json()
}

// === REST API ===

export const rest = {
  get,

  // State
  getState: () => get<AppState>('/api/state'),
  getHealth: () => get<{ status: string; uptime: number; bootTime: number; clients: number; processes: number; maxProcesses: number; maxProcessesEnforced?: boolean; dbReadOnly?: string | null; totalInstances: number; runningInstances: number; memoryMb: number; heapMb: number }>('/api/health'),
  getProcesses: () => get<{ processes: Array<{ instanceId: string; instanceName: string; pid: number; state: string; runningSec: number; lastCostUsd: number | null; lastInputTokens: number | null; lastOutputTokens: number | null }>; timestamp: number }>('/api/processes'),

  // Folders
  createFolder: (data: Partial<FolderConfig>) => post<FolderConfig>('/api/folders', data),
  /**
   * Create a project, or learn which project already owns this folder. The server matches
   * spellings the browser cannot (short 8.3 names, shares, trailing dots), so its 409 answer,
   * which names the owning project, is the one to act on.
   */
  createFolderOrFindOwner: async (data: Partial<FolderConfig>): Promise<{ folder: FolderConfig } | { ownerId: string; hidden: boolean }> => {
    const res = await authFetch(`${BASE}/api/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    if (res.status === 409 && typeof body.id === 'string') return { ownerId: body.id, hidden: !!body.hidden }
    if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : `${res.status} ${res.statusText}`)
    return { folder: body as unknown as FolderConfig }
  },
  updateFolder: (id: string, data: Partial<FolderConfig>) => put<FolderConfig>(`/api/folders/${id}`, data),
  /** Hide a project from the sidebar. Flips one flag; every card, routine and chat is kept. */
  hideFolder: (id: string) => post<FolderConfig>(`/api/folders/${id}/hide`, {}),
  unhideFolder: (id: string) => post<FolderConfig>(`/api/folders/${id}/unhide`, {}),
  /** What a permanent delete would remove, for the confirmation text. */
  getFolderDeleteSummary: (id: string) =>
    get<{ id: string; name: string; cards: number; routines: number; comments: number; chats: number; messages: number }>(
      `/api/folders/${id}/delete-summary`,
    ),
  /** Permanent. The server refuses unless the id is repeated as the confirmation. */
  deleteFolder: (id: string, confirmId: string) =>
    del<{ ok: true }>(`/api/folders/${id}?confirm=${encodeURIComponent(confirmId)}`),
  reorderFolders: (ids: string[]) => put<{ ok: true }>('/api/folders/reorder', { ids }),
  /** This project's own rules plus every folder above it, for the read-only list in Permissions. */
  getFolderPermissionRules: (id: string) =>
    get<{ own: PermissionRuleSet | null; chain: Array<{ folderId: string; folderName: string; folderPath: string; rules: PermissionRuleSet }> }>(
      `/api/folders/${id}/permission-rules`,
    ),
  /** "Allow always" at project scope, and the modal's remove. Appends and subtracts on the server,
   *  so a tab that loaded an hour ago cannot wipe a rule a second chat added since. */
  patchFolderPermissionRules: (id: string, body: { add?: string[]; remove?: string[] }) =>
    patch<{ ok: boolean; permissionRules?: PermissionRuleSet | null; error?: string; refused?: string[] }>(
      `/api/folders/${id}/permission-rules`,
      body,
    ),

  // Instances
  createInstance: (data: Partial<InstanceConfig>) => post<InstanceConfig>('/api/instances', data),
  updateInstance: (id: string, data: Partial<InstanceConfig>) => put<InstanceConfig>(`/api/instances/${id}`, data),
  deleteInstance: (id: string) => del<{ ok: true }>(`/api/instances/${id}`),
  // Close + permanently scrub secrets from the transcript file (returns the counts).
  secureCloseInstance: (id: string, taskStatus?: 'done' | 'inbox') =>
    post<{ ok: boolean; sessionFound: boolean; apiKeys: number; passwords: number; removed: number; affectedLines: number; summarizing?: boolean; taskId?: string | null; error?: string }>(
      `/api/instances/${id}/secure-close`,
      taskStatus ? { taskStatus } : undefined
    ),
  /** The pipeline task this instance is linked to, if any. Drives the close dialog. */
  getInstanceTask: (id: string) => get<{ task: PipelineTask | null }>(`/api/instances/${id}/task`),
  reorderInstances: (ids: string[]) => put<{ ok: true }>('/api/instances/reorder', { ids }),

  // Uncommitted-work scan for the close guard (includes untracked; splits mine vs others).
  getInstanceGitStatus: (id: string) =>
    get<{ isRepo: boolean; total: number; mine: string[]; others: string[] }>(`/api/instances/${id}/git-status`),
  // Worktrees this session created and never removed. Read from its own transcript, so
  // it is true even when the session no longer remembers making them.
  getInstanceWorktreeOrphans: (id: string) =>
    get<{ checked: boolean; orphans: Array<{ path: string; name: string; branch: string; registered: boolean; dirty: number; unpushed: number }> }>(
      `/api/instances/${id}/worktree-orphans`
    ),
  // Compact an idle session's context on demand (cold-start / quota lever).
  compactInstance: (id: string) =>
    post<{ ok: boolean; error?: string }>(`/api/instances/${id}/compact`),
  // Toggle keep-warm (the 🔥 chip): server pings the session before its cache goes cold.
  setKeepWarm: (id: string, enabled: boolean) =>
    post<{ ok: boolean; keepWarm: boolean }>(`/api/instances/${id}/keep-warm`, { enabled }),
  // Task Activity: every scheduled card run and wake-up, newest first.
  getActivity: (limit = 100) =>
    get<{ entries: ActivityEntry[] }>(`/api/activity?limit=${limit}`),
  // The chat surfaced by a scheduled fire has been looked at: drops its bright status.
  ackSurface: (id: string, surfacedAt?: number) =>
    post<{ ok: boolean; cleared: boolean }>(`/api/instances/${id}/surface-ack`, surfacedAt != null ? { surfacedAt } : {}),

  // Claude session control
  sendMessage: (instanceId: string, data: { text?: string; images?: string[]; flags?: string[] }) =>
    post<{ ok: true }>(`/api/instances/${instanceId}/send`, data),
  // "By the way": queue a steering note while a turn runs (auto-runs as a follow-up
  // turn the instant the current one ends), or send it now if the instance is idle.
  btw: (instanceId: string, text: string, flags?: string[]) =>
    post<{ ok: boolean; queued: boolean; duplicate?: boolean; error?: string }>(
      `/api/instances/${instanceId}/btw`,
      flags && flags.length ? { text, flags } : { text }
    ),
  pauseInstance: (instanceId: string) =>
    post<{ ok: true }>(`/api/instances/${instanceId}/pause`),
  resumeInstance: (instanceId: string) =>
    post<{ ok: true }>(`/api/instances/${instanceId}/resume`),
  syncSession: (instanceId: string) =>
    post<{ ok: true }>(`/api/instances/${instanceId}/sync`),
  // `flags` carries the composer's model / effort / permission picks. Commands that run as
  // a real turn (/goal, /compact, skills) go through the normal send path server-side, so
  // without them the turn silently falls back to the global defaults.
  sendCommand: (instanceId: string, command: string, flags?: string[]) =>
    post<{ ok: boolean; result: string; action?: string; value?: string; url?: string }>(
      `/api/instances/${instanceId}/command`,
      flags && flags.length ? { command, flags } : { command }
    ),
  writeStdin: (instanceId: string, data: string) =>
    post<{ ok: boolean }>(`/api/instances/${instanceId}/stdin`, { data }),
  answerQuestion: (instanceId: string, toolUseId: string, answer: string) =>
    post<{ ok: boolean; error?: string }>(`/api/instances/${instanceId}/answer-question`, { toolUseId, answer }),
  // `permissionMode` is the composer's per-instance pick. The server can't read it
  // (it's localStorage), so approval must carry it or the resumed turn silently runs
  // under a different mode than the UI shows.
  decidePlan: (
    instanceId: string,
    toolUseId: string,
    decision: 'approve' | 'reject',
    opts?: { feedback?: string; permissionMode?: PermissionMode },
  ) =>
    post<{ ok: boolean; error?: string }>(`/api/instances/${instanceId}/decide-plan`, {
      toolUseId,
      decision,
      ...(opts?.feedback ? { feedback: opts.feedback } : {}),
      ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    }),
  // Respond to a can_use_tool permission request (--permission-prompt-tool stdio).
  // `input` (the original tool input) is required on allow — it becomes updatedInput.
  // `updatedPermissions` rides along on "Allow always" so the running process stops asking now.
  controlResponse: (instanceId: string, body: { requestId: string; behavior: 'allow' | 'deny'; input?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; message?: string; interrupt?: boolean }) =>
    post<{ ok: boolean; error?: string }>(`/api/instances/${instanceId}/control-response`, body),
  sanitizeSurrogates: (instanceId: string) =>
    post<{ ok: boolean; error?: string; removedChars?: number; backupPath?: string; affectedLines?: number }>(
      `/api/instances/${instanceId}/sanitize-surrogates`
    ),
  // Unpin a session from an isolation worktree that was removed — otherwise every --resume
  // aborts with exit 1 and the tab can never reply again.
  repairWorktree: (instanceId: string) =>
    post<{ ok: boolean; error?: string; alreadyClear?: boolean; worktreePath?: string; worktreeName?: string; repairedFiles?: string[]; backups?: string[] }>(
      `/api/instances/${instanceId}/repair-worktree`
    ),
  getWakeups: (instanceId: string) =>
    get<{ wakeups: Array<{ id: string; instanceId: string; fireAt: number; delaySeconds: number; prompt: string; reason: string | null; status: 'pending' | 'fired' | 'cancelled'; createdAt: number }> }>(
      `/api/instances/${instanceId}/wakeups`
    ),
  cancelWakeup: (instanceId: string, wakeupId: string) =>
    del<{ ok: boolean; error?: string }>(`/api/instances/${instanceId}/wakeups/${wakeupId}`),

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
  getPipelines: (includeDone?: boolean) =>
    get<Record<string, PipelineTask[]>>(`/api/pipelines${includeDone ? '?includeDone=true' : ''}`),
  getProjectPipeline: (projectId: string, includeDone?: boolean) =>
    get<PipelineTask[]>(`/api/pipelines/${projectId}${includeDone ? '?includeDone=true' : ''}`),
  getTask: (projectId: string, taskId: string) => get<PipelineTask>(`/api/pipelines/${projectId}/tasks/${taskId}`),
  // These two are also how a SCHEDULED card is created and edited. There is no separate
  // routines API any more: a schedule is a property of a card, so scheduleKind,
  // scheduleValue, scheduleEnabled, targetInstanceId, silent, rawPrompt and the per-card
  // run settings (model, effort, permissionMode, maxBudgetUsd, fallbackModel, outputStyle,
  // language) all ride in this same body. Partial<PipelineTask> already covers every one
  // of them, so nothing here needed widening.
  createTask: (projectId: string, data: Partial<PipelineTask>) =>
    post<PipelineTask>(`/api/pipelines/${projectId}/tasks`, data),
  updateTask: (projectId: string, taskId: string, data: Partial<PipelineTask>) =>
    put<PipelineTask>(`/api/pipelines/${projectId}/tasks/${taskId}`, data),
  deleteTask: (projectId: string, taskId: string) =>
    del<{ ok: true }>(`/api/pipelines/${projectId}/tasks/${taskId}`),
  moveTask: (projectId: string, taskId: string, column: PipelineColumn, agent?: string) =>
    post<PipelineTask>(`/api/pipelines/${projectId}/tasks/${taskId}/move`, { column, agent }),
  // startedBy: 'user' says this start came from a click, not from an agent posting to the
  // same endpoint. The server cannot tell otherwise, and the difference decides whether an
  // edit-session or summary chat surfaces itself. A card start surfaces either way.
  startTask: (projectId: string, taskId: string, instanceId?: string) =>
    post<{ task: PipelineTask; instanceId: string; created: boolean }>(`/api/pipelines/${projectId}/tasks/${taskId}/start`, { instanceId, startedBy: 'user' }),
  blockTask: (projectId: string, taskId: string, reason: string) =>
    post<PipelineTask>(`/api/pipelines/${projectId}/tasks/${taskId}/block`, { reason }),
  unblockTask: (projectId: string, taskId: string) =>
    post<PipelineTask>(`/api/pipelines/${projectId}/tasks/${taskId}/unblock`),
  getTaskComments: (projectId: string, taskId: string) =>
    get<TaskComment[]>(`/api/pipelines/${projectId}/tasks/${taskId}/comments`),
  addTaskComment: (projectId: string, taskId: string, data: { author?: string; body: string }) =>
    post<TaskComment>(`/api/pipelines/${projectId}/tasks/${taskId}/comments`, data),

  // Scheduled cards. Everything else about a schedule is just a field on the card, so only
  // these two need their own path: firing a card and reading its run history are ACTIONS
  // on a card, not properties of one. They replace POST /routines/:id/run-now and
  // GET /routines/:id/runs, which went with the routines table.
  /** Fire the card now. Does not consume its next scheduled slot unless that slot is due. */
  runTaskNow: (projectId: string, taskId: string) =>
    post<{ ok: boolean; runId?: string }>(`/api/pipelines/${projectId}/tasks/${taskId}/run-now`),
  /** Run history, newest first. Every card can have one; today only scheduled cards do. */
  getTaskRuns: (projectId: string, taskId: string, limit = 50) =>
    get<{ runs: TaskRun[] }>(`/api/pipelines/${projectId}/tasks/${taskId}/runs?limit=${limit}`),

  // Settings
  getSettings: () => get<AppSettings>('/api/settings'),
  updateSettings: (data: Partial<AppSettings>) => put<AppSettings>('/api/settings', data),
  // "Allow always": append allow rules to the app-wide list, on the server, so a stale tab cannot
  // overwrite rules added elsewhere. Refuses (422) any rule auto mode would drop.
  addPermissionAllowRules: (rules: string[]) =>
    post<{ ok: boolean; added?: number; permissionAllowRules?: string[]; error?: string; refused?: string[] }>(
      '/api/settings/permission-allow-rules',
      { rules },
    ),
  // Anthropic API key for AI session naming — write-only; the server returns only whether one is set.
  /** Custom output styles found on disk (~/.claude/output-styles, plus a chat's own
   *  project dir when `cwd` is given). The five built-ins come from shared/constants. */
  getOutputStyles: (cwd?: string) =>
    get<{ styles: Array<{ value: string; name: string; description: string; source: 'user' | 'project' }> }>(
      `/api/settings/output-styles${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`
    ),

  getAnthropicKeyStatus: () => get<{ set: boolean }>('/api/settings/anthropic-key'),
  setAnthropicKey: (key: string) => put<{ set: boolean }>('/api/settings/anthropic-key', { key }),

  // Plan limits (Claude OAuth usage API)
  getUsage: () => get<UsageData>('/api/plan-usage'),
  getAuthUrl: () => post<{ url: string }>('/api/plan-usage/connect'),
  exchangeCode: (code: string) => post<UsageData>('/api/plan-usage/code', { code }),
  disconnectUsage: () => post<UsageData>('/api/plan-usage/disconnect'),
  refreshUsage: () => post<UsageData>('/api/plan-usage/refresh'),
  getSavings: (days = 7) => get<SavingsSummary>(`/api/usage/savings?days=${days}`),
  getMultiplier: () => get<{ multiplier: number; cacheRatio: number; totalInput: number; cacheRead: number }>('/api/usage/multiplier'),

  // Profile stats
  getProfile: () => get<AccountProfile>('/api/profile'),

  // Agents
  getAgents: () => get<AgentConfig[]>('/api/agents'),
  getAgent: (id: string) => get<AgentConfig>(`/api/agents/${id}`),
  createAgent: (data: Partial<AgentConfig>) => post<AgentConfig>('/api/agents', data),
  updateAgent: (id: string, data: Partial<AgentConfig>) => put<AgentConfig>(`/api/agents/${id}`, data),
  deleteAgent: (id: string) => del<{ ok: true }>(`/api/agents/${id}`),
  createAgentEditSession: (agentId: string) => post<{ instanceId: string }>(`/api/agents/${agentId}/edit-session`, { startedBy: 'user' }),

  // Skills
  getSkills: () => get<SkillConfig[]>('/api/skills'),
  /** Deterministic disk scan of every skill Claude can see. No model call. */
  getAvailableSkills: () => get<SkillInventory>('/api/skills/available'),

  pauseAll: (folderId: string) => post<{ paused: number; notStopped?: string[] }>(`/api/folders/${folderId}/pause-all`),
  releaseAll: (folderId: string) => post<{ released: number; instanceIds: string[] }>(`/api/folders/${folderId}/release-all`),
  closeAll: (folderId: string) => post<{ closed: number; instanceIds: string[] }>(`/api/folders/${folderId}/close-all`),
  openFolder: (folderId: string) => post<{ ok: boolean; path: string }>(`/api/folders/${folderId}/open`),
  renewFolder: (folderId: string, body?: { newNames?: string[] }) => post<{ renewed: number; oldInstanceIds: string[]; newInstances: Record<string, unknown>[] }>(`/api/folders/${folderId}/renew`, body),
  shutdownAll: () => post<{ killed: number; instanceIds: string[] }>('/api/shutdown'),
  terminate: () => post<{ ok: true; killed: number; instanceIds: string[] }>('/api/terminate'),
  killInstance: (id: string) => post<{ killed: boolean }>(`/api/instances/${id}/kill`),
  forceResetInstance: (id: string) => post<{ ok: boolean; killed: boolean }>(`/api/instances/${id}/force-reset`),

  // MCP server discovery

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
  openPath: (filePath: string) =>
    post<{ ok: boolean; error?: string }>('/api/fs/open', { path: filePath }),

  // Usage log
  getUsageLog: (limit = 100, days?: number) =>
    get<Array<{ session_id: string; role: string; task_title: string | null; project_name: string | null; cost_usd: number; input_tokens: number; output_tokens: number; created_at: number }>>(
      `/api/usage/log?limit=${limit}${days ? `&days=${days}` : ''}`
    ),
  // Longest single turn per chat, all time (not filtered by the day selector).
  getLongestTurns: (limit = 10) =>
    get<Array<{ instance_id: string; instance_name: string | null; project_name: string | null; max_ms: number; turns: number; last_turn_at: number }>>(
      `/api/usage/longest-turns?limit=${limit}`
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

  // Analytics endpoints
  getUsageTrend: (days = 14) =>
    get<UsageTrendDay[]>(`/api/usage/trend?days=${days}`),
  getUsageByColumn: (days = 14) =>
    get<UsageByColumn[]>(`/api/usage/by-column?days=${days}`),
  getUsageForecast: (days = 14) =>
    get<UsageForecast>(`/api/usage/forecast?days=${days}`),
  getUsageAnomalies: (days = 14) =>
    get<UsageAnomaly[]>(`/api/usage/anomalies?days=${days}`),
  getUsageEfficiency: (days = 14) =>
    get<UsageEfficiencyDay[]>(`/api/usage/efficiency?days=${days}`),
  getUsageByModel: (days = 14) =>
    get<Array<{
      model: string; totalCostUsd: number; inputTokens: number; outputTokens: number;
      cacheReadTokens: number; cacheCreationTokens: number; backfilledCostUsd: number; sessionCount: number;
    }>>(`/api/usage/by-model?days=${days}`),
  getCompactionSavings: (days = 14) =>
    get<CompactionSavingsSummary>(`/api/usage/compaction-savings?days=${days}`),
  runUsageBackfill: () =>
    post<{ sessionsScanned: number; sessionsMatched: number; rowsInserted: number; tokensAdded: number; costAdded: number }>(
      '/api/usage/backfill', {}
    ),

  // Per-turn cost tracking
  getSessionCostSummary: (instanceId: string) =>
    get<SessionCostState>(`/api/usage/session-summary/${instanceId}`),
  getUsageByFolder: (days = 14) =>
    get<Array<{
      folderId: string; folderName: string; folderPath: string; emoji: string | null;
      totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number;
      totalCacheRead: number; totalCacheCreation: number;
      turnCount: number; sessionCount: number; cacheHitRatio: number;
    }>>(`/api/usage/by-folder?days=${days}`),

  // Sessions
  // Always paged: there are thousands of transcripts on disk, and rendering them all at
  // once cost ~300k DOM nodes and half a gigabyte of heap in the tab.
  getSessions: (opts: {
    limit?: number; offset?: number; q?: string
    subagents?: boolean; project?: string; linked?: string; days?: number; sort?: string
  } = {}) => {
    const params = new URLSearchParams()
    if (opts.limit != null) params.set('limit', String(opts.limit))
    if (opts.offset) params.set('offset', String(opts.offset))
    if (opts.q) params.set('q', opts.q)
    if (opts.subagents) params.set('subagents', '1')
    if (opts.project) params.set('project', opts.project)
    if (opts.linked) params.set('linked', opts.linked)
    if (opts.days) params.set('days', String(opts.days))
    if (opts.sort && opts.sort !== 'recent') params.set('sort', opts.sort)
    const qs = params.toString()
    return get<{ sessions: SessionFile[]; total: number; offset: number; limit: number; hasMore: boolean }>(
      `/api/sessions${qs ? `?${qs}` : ''}`
    )
  },
  getSessionProjects: (subagents = false) =>
    get<{ projects: Array<{ slug: string; label: string; emoji?: string; known: boolean; count: number }> }>(
      `/api/sessions/projects${subagents ? '?subagents=1' : ''}`
    ),
  resumeSession: (sessionId: string) =>
    post<{ instanceId: string; created: boolean; imported: number; cwd?: string }>(
      `/api/sessions/${sessionId}/resume`, {}
    ),
  getSessionStats: (sessionId: string) =>
    get<{ inputTokens: number; outputTokens: number; costUsd: number; lineCount: number }>(`/api/sessions/${sessionId}/stats`),
  requestSessionSummary: (sessionId: string, instanceId: string) =>
    post<{ ok: true; instanceId: string; sessionId: string }>(`/api/sessions/${sessionId}/request-summary`, { instanceId, startedBy: 'user' }),
}
