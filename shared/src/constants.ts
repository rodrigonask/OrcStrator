import type { PipelineColumn, XpEventType, AppSettings } from './types.js'

export const PIPELINE_COLUMNS: PipelineColumn[] = [
  'backlog', 'scheduled', 'spec', 'build', 'qa', 'ship', 'done'
]

export const COLUMN_COLORS: Record<PipelineColumn, string> = {
  backlog: '#6b7280',
  scheduled: '#6366f1',
  spec: '#8b5cf6',
  build: '#3b82f6',
  qa: '#f59e0b',
  ship: '#10b981',
  done: '#6b7280'
}

export const SPECIAL_LABELS = ['stuck', 'blocked'] as const

export const XP_TABLE: Record<XpEventType, number> = {
  'tour-step': 50,
  'challenge': 200,
  'agent-created': 150,
  'skill-created': 100,
  'message-sent': 15,
  'session-complete': 75,
  'lesson-completed': 100,
  'knowledge-base-created': 125,
  'first-pipeline-task': 200,
}

export type LevelTier = 'Beginner' | 'Intermediate' | 'Advanced' | 'Elite' | 'Mythic' | 'Cosmic'

export const LEVELS: Array<{ level: number; name: string; xpRequired: number; tier: LevelTier }> = [
  // Beginner (1-5)
  { level: 1, name: 'Novice', xpRequired: 0, tier: 'Beginner' },
  { level: 2, name: 'Apprentice', xpRequired: 150, tier: 'Beginner' },
  { level: 3, name: 'Initiate', xpRequired: 350, tier: 'Beginner' },
  { level: 4, name: 'Student', xpRequired: 700, tier: 'Beginner' },
  { level: 5, name: 'Adept', xpRequired: 1500, tier: 'Beginner' },
  // Intermediate (6-10)
  { level: 6, name: 'Practitioner', xpRequired: 2500, tier: 'Intermediate' },
  { level: 7, name: 'Specialist', xpRequired: 4000, tier: 'Intermediate' },
  { level: 8, name: 'Expert', xpRequired: 6500, tier: 'Intermediate' },
  { level: 9, name: 'Veteran', xpRequired: 9500, tier: 'Intermediate' },
  { level: 10, name: 'Master', xpRequired: 13000, tier: 'Intermediate' },
  // Advanced (11-15)
  { level: 11, name: 'Sage', xpRequired: 18000, tier: 'Advanced' },
  { level: 12, name: 'Scholar', xpRequired: 24000, tier: 'Advanced' },
  { level: 13, name: 'Architect', xpRequired: 32000, tier: 'Advanced' },
  { level: 14, name: 'Innovator', xpRequired: 42000, tier: 'Advanced' },
  { level: 15, name: 'Virtuoso', xpRequired: 55000, tier: 'Advanced' },
  // Elite (16-20)
  { level: 16, name: 'Commander', xpRequired: 72000, tier: 'Elite' },
  { level: 17, name: 'Strategist', xpRequired: 95000, tier: 'Elite' },
  { level: 18, name: 'Visionary', xpRequired: 125000, tier: 'Elite' },
  { level: 19, name: 'Pioneer', xpRequired: 160000, tier: 'Elite' },
  { level: 20, name: 'Legend', xpRequired: 200000, tier: 'Elite' },
  // Mythic (21-25)
  { level: 21, name: 'Mythic', xpRequired: 250000, tier: 'Mythic' },
  { level: 22, name: 'Transcendent', xpRequired: 310000, tier: 'Mythic' },
  { level: 23, name: 'Ascendant', xpRequired: 385000, tier: 'Mythic' },
  { level: 24, name: 'Sovereign', xpRequired: 465000, tier: 'Mythic' },
  { level: 25, name: 'Paragon', xpRequired: 550000, tier: 'Mythic' },
  // Cosmic (26-30)
  { level: 26, name: 'Cosmic', xpRequired: 660000, tier: 'Cosmic' },
  { level: 27, name: 'Eternal', xpRequired: 800000, tier: 'Cosmic' },
  { level: 28, name: 'Infinite', xpRequired: 980000, tier: 'Cosmic' },
  { level: 29, name: 'Omniscient', xpRequired: 1200000, tier: 'Cosmic' },
  { level: 30, name: 'Singularity', xpRequired: 1400000, tier: 'Cosmic' },
]

export const OVERDRIVE_LEVELS = [
  { level: 0, label: 'Cold',      minTasks: 0,  savings: 0,  color: 'transparent' },
  { level: 1, label: 'Warm',      minTasks: 1,  savings: 40, color: '#60a5fa' },
  { level: 2, label: 'Hot',       minTasks: 2,  savings: 60, color: '#22d3ee' },
  { level: 3, label: 'Blazing',   minTasks: 4,  savings: 70, color: '#f97316' },
  { level: 4, label: 'Overdrive', minTasks: 7,  savings: 80, color: '#ef4444' },
  { level: 5, label: 'Supernova', minTasks: 12, savings: 85, color: '#e879f9' },
] as const

export const ALLOWED_FLAG_PREFIXES = [
  '--dangerously-skip-permissions',
  '--system-prompt',
  '--append-system-prompt',
  '--permission-mode',
  '--model',
  '--max-tokens',
  '--verbose',
  '--output-format',
  '--input-format',
  '--resume',
  '--session-id',
  '--no-cache',
  '--mcp-config',
  '--strict-mcp-config',
  '--tools',
  '--allowedTools',
  '--disallowedTools',
]

export const AVAILABLE_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'Agent',
] as const

export const DEFAULT_ROLE_MODELS: Record<string, string> = {
  planner: 'sonnet',
  builder: 'opus',
  tester: 'sonnet',
  promoter: 'sonnet',
  scheduler: 'sonnet',
}

export const DEFAULT_ROLE_TOOLS: Record<string, string[]> = {
  planner: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch'],
  builder: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch'],
  tester: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch'],
  promoter: ['Read', 'Grep', 'Glob', 'Bash'],
  scheduler: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch'],
}

export const DEFAULT_COLUMN_LABELS: Record<PipelineColumn, string> = {
  backlog: 'Inbox',
  scheduled: 'Scheduled',
  spec: 'Planning',
  build: 'Building',
  qa: 'Testing',
  ship: 'Publishing',
  done: 'Done',
}

export const DEFAULT_SETTINGS: AppSettings = {
  globalFlags: ['--dangerously-skip-permissions'],
  idleTimeoutSeconds: 60,
  notifications: true,
  startWithOS: false,
  rootFolder: '',
  usagePollMinutes: 10,
  theme: 'system',
  port: 3333,
  columnLabels: DEFAULT_COLUMN_LABELS,
  userName: 'Rodrigo Nask',
  userEmoji: '🧠',
  animationsEnabled: true,
  soundsEnabled: false,
}

export const OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: 'org:create_api_key user:profile user:inference',
  authBaseUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  usageUrl: 'https://api.anthropic.com/api/oauth/usage'
}
