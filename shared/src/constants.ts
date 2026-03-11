import type { PipelineColumn, XpEventType, AppSettings, VerbosityLevel } from './types.js'

export const PIPELINE_COLUMNS: PipelineColumn[] = [
  'backlog', 'ready', 'in_progress', 'in_review', 'done'
]

export const COLUMN_COLORS: Record<string, string> = {
  backlog: '#6b7280',
  ready: '#6366f1',
  in_progress: '#3b82f6',
  in_review: '#f59e0b',
  done: '#6b7280',
  scheduled: '#8b5cf6',
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
  // Beginner (1-5) — all reachable in first ~2 hours
  { level: 1, name: 'Novice', xpRequired: 0, tier: 'Beginner' },
  { level: 2, name: 'Apprentice', xpRequired: 75, tier: 'Beginner' },
  { level: 3, name: 'Initiate', xpRequired: 175, tier: 'Beginner' },
  { level: 4, name: 'Student', xpRequired: 300, tier: 'Beginner' },
  { level: 5, name: 'Adept', xpRequired: 500, tier: 'Beginner' },
  // Intermediate (6-10)
  { level: 6, name: 'Practitioner', xpRequired: 750, tier: 'Intermediate' },
  { level: 7, name: 'Specialist', xpRequired: 1050, tier: 'Intermediate' },
  { level: 8, name: 'Expert', xpRequired: 1400, tier: 'Intermediate' },
  { level: 9, name: 'Veteran', xpRequired: 1800, tier: 'Intermediate' },
  { level: 10, name: 'Master', xpRequired: 2300, tier: 'Intermediate' },
  // Advanced (11-15) — all features unlocked by Lv.15 (~5-8K XP)
  { level: 11, name: 'Sage', xpRequired: 2900, tier: 'Advanced' },
  { level: 12, name: 'Scholar', xpRequired: 3500, tier: 'Advanced' },
  { level: 13, name: 'Architect', xpRequired: 4200, tier: 'Advanced' },
  { level: 14, name: 'Innovator', xpRequired: 5000, tier: 'Advanced' },
  { level: 15, name: 'Virtuoso', xpRequired: 6000, tier: 'Advanced' },
  // Elite (16-20) — prestige tiers
  { level: 16, name: 'Commander', xpRequired: 8000, tier: 'Elite' },
  { level: 17, name: 'Strategist', xpRequired: 12000, tier: 'Elite' },
  { level: 18, name: 'Visionary', xpRequired: 18000, tier: 'Elite' },
  { level: 19, name: 'Pioneer', xpRequired: 28000, tier: 'Elite' },
  { level: 20, name: 'Legend', xpRequired: 40000, tier: 'Elite' },
  // Mythic (21-25)
  { level: 21, name: 'Mythic', xpRequired: 55000, tier: 'Mythic' },
  { level: 22, name: 'Transcendent', xpRequired: 70000, tier: 'Mythic' },
  { level: 23, name: 'Ascendant', xpRequired: 85000, tier: 'Mythic' },
  { level: 24, name: 'Sovereign', xpRequired: 100000, tier: 'Mythic' },
  { level: 25, name: 'Paragon', xpRequired: 120000, tier: 'Mythic' },
  // Cosmic (26-30)
  { level: 26, name: 'Cosmic', xpRequired: 150000, tier: 'Cosmic' },
  { level: 27, name: 'Eternal', xpRequired: 200000, tier: 'Cosmic' },
  { level: 28, name: 'Infinite', xpRequired: 300000, tier: 'Cosmic' },
  { level: 29, name: 'Omniscient', xpRequired: 500000, tier: 'Cosmic' },
  { level: 30, name: 'Singularity', xpRequired: 1000000, tier: 'Cosmic' },
]

export interface FeatureGate {
  key: string
  level: number
  title: string
  description: string
  concept: string
}

export const FEATURE_GATES: FeatureGate[] = [
  { key: 'multi-project', level: 2, title: 'Multiple Projects',
    description: 'Add more project directories to work on.',
    concept: 'Claude Code works best when scoped to a single project directory. Each project gets its own context and CLAUDE.md instructions.' },
  { key: 'create-project', level: 2, title: 'Create New Project',
    description: 'Scaffold a brand new project from scratch with Claude.',
    concept: 'Claude can initialize any kind of project — from a React app to a Python CLI. It reads the directory and adapts.' },
  { key: 'plan-mode', level: 3, title: 'Plan Mode',
    description: 'Ask Claude to plan before executing. Read-only exploration.',
    concept: 'Plan mode lets Claude explore your code and propose changes without writing anything. Great for understanding large codebases.' },
  { key: 'context-tools', level: 4, title: 'CLAUDE.md Editor',
    description: 'Edit project instructions that persist across sessions.',
    concept: 'CLAUDE.md is loaded into every Claude session in that folder. Use it for project rules, architecture notes, and conventions.' },
  { key: 'agents', level: 5, title: 'Agents',
    description: 'Create reusable AI personalities with custom system prompts.',
    concept: 'Agents are personas with specific instructions — a Security Auditor or Test Writer. They shape how Claude approaches your code.' },
  { key: 'skills', level: 6, title: 'Skills',
    description: 'Slash commands that encode your best workflows.',
    concept: 'Skills are reusable prompt templates. Create /deploy, /test, /review — any workflow you repeat.' },
  { key: 'custom-agents', level: 7, title: 'Custom Agent Roles',
    description: 'Assign custom roles and specializations to agents.',
    concept: 'Beyond the 4 built-in roles, you can create agents with any personality and toolset configuration.' },
  { key: 'pipeline', level: 8, title: 'Pipeline Board',
    description: 'Kanban board for managing tasks. Agents pick them up automatically.',
    concept: 'The pipeline is a task queue. Create tasks, and The Orc assigns them to the right agent based on the task type.' },
  { key: 'overdrive', level: 9, title: 'Overdrive Meter',
    description: 'Monitor prompt cache efficiency and cost savings.',
    concept: 'Claude caches repeated context (prompt caching). The Overdrive meter shows how much you are saving by reusing sessions.' },
  { key: 'scheduled-runs', level: 10, title: 'Scheduled Runs',
    description: 'Set tasks to run on a recurring schedule.',
    concept: 'Schedule tasks to run daily, hourly, or on cron. Great for automated testing, reports, or maintenance.' },
  { key: 'knowledge-base', level: 11, title: 'Knowledge Bases',
    description: 'Persistent domain expertise for your agents.',
    concept: 'Knowledge bases store domain-specific context that agents can reference. Think of them as shared memory across sessions.' },
  { key: 'agent-teams', level: 12, title: 'Agent Teams',
    description: 'Spawn pre-configured agent squads for a project.',
    concept: 'Teams are groups of agents that work together — a Planner specs the task, a Builder implements, a Tester validates.' },
  { key: 'the-orc', level: 13, title: 'The Orc',
    description: 'Hand over control. The Orc assigns tasks and manages agents autonomously.',
    concept: 'The Orc is the autonomous orchestrator. It watches the pipeline, assigns tasks to idle agents, and manages the entire workflow.' },
  { key: 'dark-factory', level: 14, title: 'Dark Factory',
    description: 'Full autonomous pipeline — 4 agents, zero supervision.',
    concept: 'Dark Factory is lights-out automation. The Orc runs the entire pipeline: planning, building, testing, and shipping — while you sleep.' },
  { key: 'headless', level: 15, title: 'Headless Mode',
    description: 'Run agents without the UI. Pure CLI orchestration.',
    concept: 'Headless mode lets you trigger OrcStrator from scripts, CI/CD, or other tools. The engine runs without the game UI.' },
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
  planner: ['Read', 'Grep', 'Glob', 'Bash'],
  builder: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  tester: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  promoter: ['Read', 'Grep', 'Glob', 'Bash'],
  scheduler: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
}

export const DEFAULT_COLUMN_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  scheduled: 'Scheduled',
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
  userName: '',
  userEmoji: '🧠',
  animationsEnabled: true,
  soundsEnabled: false,
  animationTier: 0,
  soundTier: 0,
}

export const DEFAULT_AGENT_NAMES: Record<string, string> = {
  planner: 'Planner',
  builder: 'Builder',
  tester: 'Tester',
  promoter: 'Promoter',
  scheduler: 'Scheduler',
}

export const OD_TIERS = [
  { min: 1,   label: 'Cold',      color: '#4b5563' },
  { min: 1.5, label: 'Warm',      color: '#60a5fa' },
  { min: 2,   label: 'Hot',       color: '#22d3ee' },
  { min: 3,   label: 'Blazing',   color: '#f97316' },
  { min: 4,   label: 'Overdrive', color: '#ef4444' },
  { min: 5,   label: 'Supernova', color: '#e879f9' },
] as const

export const TIER_COLORS: Record<string, string> = {
  Beginner: '#10b981',
  Intermediate: '#3b82f6',
  Advanced: '#8b5cf6',
  Elite: '#f59e0b',
  Mythic: '#ef4444',
  Cosmic: '#ec4899',
}

export const TIER_ICONS: Record<string, string> = {
  Beginner: '🌱',
  Intermediate: '🔥',
  Advanced: '⚡',
  Elite: '👑',
  Mythic: '🏛',
  Cosmic: '🌌',
}

export const ORC_LOG_LABELS: Record<string, string> = {
  assigned: 'Assigned',
  task_moved: 'Advanced',
  task_stuck: 'Stuck',
  lock_timeout: 'Timed Out',
  session_resumed: 'Resumed',
  spawn_failed: 'Failed',
  cooldown_hit: 'Cooldown',
  concurrency_limit: 'Full',
  zombie_detected: 'Zombie',
  process_exited: 'Done',
  no_idle_agents: 'All Busy',
}

export const ORC_LOG_FILTER_TYPES: Record<string, string[]> = {
  errors: ['spawn_failed', 'task_stuck', 'lock_timeout', 'zombie_detected'],
  assignments: ['assigned', 'task_moved', 'cooldown_hit', 'concurrency_limit', 'no_idle_agents', 'process_exited'],
}

export const ANIMATION_TIERS = [
  { level: 0, name: 'Peaceful',          icon: '\u23F8' },
  { level: 1, name: 'Normal',            icon: '\u2726' },
  { level: 2, name: 'Heroic',            icon: '\u26A1' },
  { level: 3, name: 'Mythic',            icon: '\u{1F525}' },
  { level: 4, name: 'Vampire Survivors', icon: '\u{1F300}' },
] as const

export const SOUND_TIERS = [
  { level: 0, name: 'Peaceful',          icon: '\u{1F507}' },
  { level: 1, name: 'Normal',            icon: '\u{1F508}' },
  { level: 2, name: 'Heroic',            icon: '\u{1F509}' },
  { level: 3, name: 'Mythic',            icon: '\u{1F50A}' },
  { level: 4, name: 'Vampire Survivors', icon: '\u{1F4E2}' },
] as const

export const VERBOSITY_TIERS: Array<{ level: VerbosityLevel; name: string; icon: string; description: string }> = [
  { level: 1, name: 'Zen',      icon: '\u{1F9D8}', description: 'Wave dots + tool counter only' },
  { level: 2, name: 'Clean',    icon: '\u{1F333}', description: 'Dots + streaming text preview' },
  { level: 3, name: 'Standard', icon: '\u2699',     description: 'Current behavior' },
  { level: 4, name: 'Detailed', icon: '\u{1F50D}',  description: 'Tools expanded by default' },
  { level: 5, name: 'Full',     icon: '\u{1F4DC}',  description: 'Everything expanded, nothing hidden' },
]

export const ORC_TOOL_VERBS: Record<string, string> = {
  Read: 'Scouting scrolls',
  Edit: 'Forging code',
  Write: 'Inscribing runes',
  Bash: 'Raiding the shell',
  Grep: 'Tracking prey',
  Glob: 'Surveying the land',
  Agent: 'Summoning allies',
  WebFetch: 'Plundering the web',
  WebSearch: 'Hunting across realms',
  AskUserQuestion: 'Consulting the chief',
}

export const ORC_VERB_FALLBACK = 'Working dark magic'

export const MAX_CACHED_MESSAGES = 200
export const FORCE_UPDATE_INTERVAL_MS = 60_000

export const OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: 'org:create_api_key user:profile user:inference',
  authBaseUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  usageUrl: 'https://api.anthropic.com/api/oauth/usage'
}
