import type { PipelineColumn, XpEventType, AppSettings } from './types.js'

export const PIPELINE_COLUMNS: PipelineColumn[] = [
  'backlog', 'spec', 'build', 'qa', 'staging', 'ship', 'done'
]

export const COLUMN_COLORS: Record<PipelineColumn, string> = {
  backlog: '#6b7280',
  spec: '#8b5cf6',
  build: '#3b82f6',
  qa: '#f59e0b',
  staging: '#ef4444',
  ship: '#10b981',
  done: '#6b7280'
}

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
  '--no-cache'
]

export const DEFAULT_SETTINGS: AppSettings = {
  globalFlags: ['--dangerously-skip-permissions'],
  idleTimeoutSeconds: 60,
  notifications: true,
  startWithOS: false,
  rootFolder: '',
  usagePollMinutes: 10,
  theme: 'system',
  port: 3333
}

export const OAUTH = {
  clientId: 'a3e06de4-0807-4612-b15f-7da209a0e252',
  redirectUri: 'https://console.anthropic.com/oauth/callback',
  scopes: 'org:usage',
  authBaseUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  usageUrl: 'https://api.anthropic.com/api/oauth/usage'
}
