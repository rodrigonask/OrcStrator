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
  'session-complete': 75
}

export const LEVELS = [
  { level: 1, name: 'Starter', xpRequired: 0 },
  { level: 2, name: 'Navigator', xpRequired: 300 },
  { level: 3, name: 'Strategist', xpRequired: 1200 },
  { level: 4, name: 'Agent Creator', xpRequired: 2500 },
  { level: 5, name: 'Craftsman', xpRequired: 4500 },
  { level: 6, name: 'Connector', xpRequired: 8000 },
  { level: 7, name: 'Orchestrator', xpRequired: 15000 }
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
