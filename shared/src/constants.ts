import type { PipelineColumn, AppSettings, VerbosityLevel, AgentModel, EffortLevel } from './types.js'

export const PIPELINE_COLUMNS: PipelineColumn[] = [
  'backlog', 'ready', 'in_progress', 'in_review', 'done'
]

export const COLUMN_COLORS: Record<string, string> = {
  backlog: '#6b7280',
  ready: '#6366f1',
  in_progress: '#3b82f6',
  in_review: '#f59e0b',
  done: '#6b7280',
}

export const SPECIAL_LABELS = ['stuck', 'blocked'] as const

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
  '--effort',
  '--max-budget-usd',
  '--fallback-model',
]

export const AVAILABLE_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'Agent',
] as const

/** Map short AgentModel names to full Claude CLI model IDs */
export const MODEL_ID_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5',
  'sonnet-5': 'claude-sonnet-5',
  // A bare family name means the latest in that family, so `opus` follows Opus
  // forward the way `sonnet` follows Sonnet. Pin `opus-5` if you want the old one.
  opus: 'claude-opus-5-5',
  'opus-5-5': 'claude-opus-5-5',
  'opus-5': 'claude-opus-5',
  'opus-4-8': 'claude-opus-4-8',
  fable: 'claude-fable-5-1',
  'fable-5-1': 'claude-fable-5-1',
  // Retired picks (Sonnet 4.6, Opus 4.6/4.7) → resolve to their replacement so a
  // saved default/fallback pref keeps launching after they left the picker.
  'sonnet-4-6': 'claude-sonnet-5',
  'opus-4-6': 'claude-opus-5',
  'opus-4-7': 'claude-opus-5',
  'fable-5': 'claude-fable-5-1',
  // Dotted and squashed spellings, for /model typed by hand. They live here rather
  // than in a second map inside the command handler, which is how the /model
  // command and the composer used to disagree about which models existed.
  sonnet5: 'claude-sonnet-5',
  opus5: 'claude-opus-5',
  'opus5.5': 'claude-opus-5-5',
  'opus4.8': 'claude-opus-4-8',
  'opus4.7': 'claude-opus-5',
  'fable5.1': 'claude-fable-5-1',
  fable5: 'claude-fable-5-1',
}

/** Resolve an AgentModel short name to a CLI --model value */
export function resolveModelId(model: string): string {
  return MODEL_ID_MAP[model] ?? model
}

/**
 * The app-wide fallbacks, used when neither the instance nor the settings row
 * names a model or an effort. These exist so "what does OrcStrator run by
 * default" is ONE answer in ONE place: the composer, the settings page, the
 * chat header, the grid tile and the spawn path all read these instead of
 * carrying their own literal, which is how the app ended up offering 'opus',
 * 'claude-sonnet-5' and 'high' as three different ideas of the same default.
 *
 * Opus 5.5 at medium: medium is the model's own default effort, and on long
 * agentic sessions 5.5 is noticeably cheaper per turn than Opus 5, almost
 * entirely because its cache reads are 0.05x input instead of 0.1x.
 */
export const DEFAULT_MODEL: AgentModel = 'opus-5-5'
export const DEFAULT_MODEL_ID = resolveModelId(DEFAULT_MODEL)
export const DEFAULT_EFFORT: EffortLevel = 'medium'

/**
 * The models on offer, in the order they are shown. ONE list: the composer
 * picker, the card picker, the Settings default-model dropdown and the /model
 * command all read it, so a new model ships in one edit instead of four.
 * Anything not listed here is still launchable by full ID, it just is not
 * offered.
 */
export const MODEL_OPTIONS: { id: string; short: AgentModel; label: string }[] = [
  { id: 'claude-opus-5-5',            short: 'opus-5-5',  label: 'Opus 5.5 (default)' },
  { id: 'claude-fable-5-1',           short: 'fable-5-1', label: 'Fable 5.1 (most capable · premium $$$)' },
  { id: 'claude-sonnet-5',            short: 'sonnet-5',  label: 'Sonnet 5 (balanced)' },
  { id: 'claude-opus-5',              short: 'opus-5',    label: 'Opus 5 (previous Opus)' },
  { id: 'claude-opus-4-8',            short: 'opus-4-8',  label: 'Opus 4.8' },
  { id: 'claude-haiku-4-5-20251001',  short: 'haiku',     label: 'Haiku 4.5 (fast/cheap)' },
]

/**
 * Models that can read another model's thinking blocks.
 *
 * A thinking block records which model produced it, and the API silently drops
 * blocks the target model cannot read. Switching a live chat to a model outside
 * the producer's reader set therefore throws the reasoning away, on top of the
 * prompt cache the switch already costs.
 *
 * Only the producers with a documented, NARROWER-than-everything reader set are
 * listed. Anything not listed returns false: we make no claim rather than
 * inventing one.
 *   Fable 5.1 / Mythos 5.1 blocks: only those two can read them.
 *   Opus 5.5 blocks: Opus 5.5, Fable 5.1 and Mythos 5.1, and nothing else.
 */
const THINKING_READERS: Record<string, string[]> = {
  'fable-5-1': ['fable-5-1', 'mythos-5-1'],
  'mythos-5-1': ['fable-5-1', 'mythos-5-1'],
  'opus-5-5': ['opus-5-5', 'fable-5-1', 'mythos-5-1'],
}

/**
 * True when switching a chat from `fromId` to `toId` drops the reasoning the
 * conversation already holds. Both arguments are full model IDs.
 */
export function switchLosesThinking(fromId: string | null | undefined, toId: string | null | undefined): boolean {
  if (!fromId || !toId || fromId === toId) return false
  const from = fromId.toLowerCase()
  const to = toId.toLowerCase()
  const producer = Object.keys(THINKING_READERS).find(f => from.includes(f))
  if (!producer) return false
  return !THINKING_READERS[producer].some(reader => to.includes(reader))
}

/** $ per million tokens */
export interface ModelPricing { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }

/** Prompt-cache TTL a cache write was made at. The two are billed at different rates. */
export type CacheTtl = '5m' | '1h'

/**
 * Anthropic API pricing per model family, $ per Mtok.
 * Source: Anthropic API pricing docs (re-checked against the current page):
 *   Haiku 4.5 $1/$5 · Sonnet 5 $2/$10 · Sonnet 4.5/4.6 $3/$15 · Opus 5.5 $4/$20 ·
 *   Opus 4.5-5 $5/$25 · Fable 5/5.1 $10/$50.
 * Cache reads are 0.1x input on most models, but NOT all: Fable 5.1 reads at
 * 0.025x ($0.25/Mtok) and Opus 5.5 at 0.05x ($0.20/Mtok). Long agentic sessions
 * re-read a warm prefix constantly, so cache reads dominate the bill and the
 * cache-read rate matters more than the sticker price. That is why Opus 5.5
 * lands well below Opus 5 on this kind of work, not just the headline gap.
 * Sonnet 5 is $2/$10. It launched at $3/$15 with $2/$10 as an intro offer, and this
 * row tracked the $3/$15 sticker; the pricing page now lists $2/$10 as the
 * standard price, so the row follows it (cache 2.50 / 4 / 0.20 by the same multipliers).
 * History keeps the price it was computed at: computed_cost_usd is not recomputed.
 * Cache economics (same source): 5-minute cache write = 1.25x input price,
 * 1-hour cache write = 2x input price. OrcStrator runs the 1-hour cache unless
 * the promptCache1h setting is off, so live turns are priced at cacheWrite1h.
 *
 * ORDER IS LOAD-BEARING. resolvePricing matches by substring, so any family
 * whose key is a prefix of a longer key must come AFTER it: 'opus-5-5' before
 * 'opus-5', 'fable-5-1' before 'fable-5'. Append a new model to the bottom and
 * it will be silently billed at the older model's rate.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'haiku-4-5':  { input: 1,  output: 5,  cacheWrite5m: 1.25, cacheWrite1h: 2,  cacheRead: 0.10 },
  'sonnet-5':   { input: 2,  output: 10, cacheWrite5m: 2.50, cacheWrite1h: 4,  cacheRead: 0.20 },
  'sonnet-4-6': { input: 3,  output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6,  cacheRead: 0.30 },
  'sonnet-4-5': { input: 3,  output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6,  cacheRead: 0.30 },
  // 'opus-5-5' must precede 'opus-5': see the ORDER IS LOAD-BEARING note above.
  'opus-5-5':   { input: 4,  output: 20, cacheWrite5m: 5.00, cacheWrite1h: 8,  cacheRead: 0.20 },
  'opus-5':     { input: 5,  output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.50 },
  'opus-4-8':   { input: 5,  output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.50 },
  'opus-4-7':   { input: 5,  output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.50 },
  'opus-4-6':   { input: 5,  output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.50 },
  'opus-4-5':   { input: 5,  output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.50 },
  // 'fable-5-1' must precede 'fable-5': resolvePricing matches by substring and
  // 'fable-5' is a prefix of 'claude-fable-5-1'.
  'fable-5-1':  { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  'fable-5':    { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1.00 },
}

/**
 * Match a full model ID (e.g. "claude-opus-4-8", "claude-haiku-4-5-20251001")
 * to its pricing family by substring. Unknown models return null - callers must
 * not guess a price.
 */
export function resolvePricing(modelId: string | null | undefined): ModelPricing | null {
  if (!modelId) return null
  const id = modelId.toLowerCase()
  for (const family of Object.keys(MODEL_PRICING)) {
    if (id.includes(family)) return MODEL_PRICING[family]
  }
  return null
}

/**
 * Context window (tokens) per model family.
 * Per the official models reference: Fable 5/5.1, Opus 5.5, Opus 5, Opus
 * 4.6/4.7/4.8, and Sonnet 4.6/5 are 1M GA; Haiku 4.5 is 200k. Empirically
 * verified against real Claude Code session JSONLs: single
 * requests reached 1.52M (opus-4-7) and 933k (opus-4-8) of context, confirming
 * the CLI runs the full 1M windows.
 * Sonnet 4.5 stays at its 200k GA window. Unknown models fall back to 200k.
 *
 * Same substring matching as MODEL_PRICING, so the same ordering rule applies:
 * a key that is a prefix of a longer key must come after it.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'haiku-4-5':  200_000,
  'sonnet-5':   1_000_000,
  'sonnet-4-6': 1_000_000,
  'sonnet-4-5': 200_000,
  'opus-5-5':   1_000_000,
  'opus-5':     1_000_000,
  'opus-4-8':   1_000_000,
  'opus-4-7':   1_000_000,
  'opus-4-6':   1_000_000,
  'opus-4-5':   200_000,
  'fable-5-1':  1_000_000,
  'fable-5':    1_000_000,
}

/**
 * Match a full model ID (e.g. "claude-opus-4-8", "claude-haiku-4-5-20251001")
 * to its context window by family substring, same matching strategy as
 * resolvePricing. Unknown/empty models return DEFAULT_CONTEXT_WINDOW.
 */
export function resolveContextWindow(modelId: string | null | undefined): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW
  const id = modelId.toLowerCase()
  for (const family of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (id.includes(family)) return MODEL_CONTEXT_WINDOWS[family]
  }
  return DEFAULT_CONTEXT_WINDOW
}

/** $ per Mtok for a cache write at the given TTL. */
export function cacheWriteRate(p: ModelPricing, cacheTtl: CacheTtl): number {
  return cacheTtl === '1h' ? p.cacheWrite1h : p.cacheWrite5m
}

/**
 * Compute the API-equivalent cost in USD for one turn.
 * `input` must be the UNCACHED input tokens (exclusive of cacheWrite/cacheRead).
 * Returns null when the model has no known pricing.
 * `cacheTtl` picks the cache-write rate. It defaults to '5m' so a caller that
 * does not know the TTL keeps its old meaning rather than silently changing it.
 */
export function computeCostUsd(
  usage: { input: number; output: number; cacheWrite: number; cacheRead: number },
  modelId: string | null | undefined,
  cacheTtl: CacheTtl = '5m'
): number | null {
  const p = resolvePricing(modelId)
  if (!p) return null
  const cost =
    (Math.max(0, usage.input) * p.input +
     Math.max(0, usage.output) * p.output +
     Math.max(0, usage.cacheWrite) * cacheWriteRate(p, cacheTtl) +
     Math.max(0, usage.cacheRead) * p.cacheRead) / 1_000_000
  return cost
}

export const DEFAULT_COLUMN_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
}

export const DEFAULT_TASK_KICKOFF_TEMPLATE = `You're working on this task from the OrcStrator pipeline:

# {{title}}

{{description}}

{{comments}}

When you're done, finish with a short summary of what you changed.`

export const DEFAULT_SETTINGS: AppSettings = {
  globalFlags: ['--dangerously-skip-permissions'],
  idleTimeoutSeconds: 60,
  notifications: true,
  startWithOS: false,
  rootFolder: '',
  usagePollMinutes: 1,
  theme: 'system',
  port: 3334,
  columnLabels: DEFAULT_COLUMN_LABELS,
  userName: '',
  userEmoji: '🧠',
  animationsEnabled: true,
  soundsEnabled: false,
  animationTier: 0,
  soundTier: 0,
  customCommands: [],
  showPlanLimits: true,
  namingMode: 'random',
}

export const OD_TIERS = [
  { min: 1,   label: 'Cold',      color: '#4b5563' },
  { min: 1.5, label: 'Warm',      color: '#60a5fa' },
  { min: 2,   label: 'Hot',       color: '#22d3ee' },
  { min: 3,   label: 'Blazing',   color: '#f97316' },
  { min: 4,   label: 'Overdrive', color: '#ef4444' },
  { min: 5,   label: 'Supernova', color: '#e879f9' },
] as const

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

/**
 * Claude Code's built-in output styles (CLI 2.1.238).
 *
 * VERBOSITY_TIERS above is a RENDERER setting: how much of the transcript OrcStrator draws.
 * This is the opposite half: it changes what the model actually writes, by swapping the
 * output-style block of the CLI's system prompt. 'Default' means "send nothing", so the CLI
 * keeps its own default prompt.
 *
 * Custom styles (markdown in ~/.claude/output-styles) are discovered at runtime and appended
 * to this list by the client. See GET /api/settings/output-styles.
 */
export const OUTPUT_STYLE_BUILTINS: Array<{ value: string; name: string; icon: string; description: string }> = [
  { value: 'Default',     name: 'Default',     icon: '⚙',     description: 'The stock Claude Code prompt' },
  { value: 'Concise',     name: 'Concise',     icon: '\u{1F5DC}',  description: 'Leads with the result, no preamble' },
  { value: 'Proactive',   name: 'Proactive',   icon: '\u{1F680}',  description: 'Acts on assumptions instead of asking' },
  { value: 'Explanatory', name: 'Explanatory', icon: '\u{1F4A1}',  description: 'Adds insights while it works' },
  { value: 'Learning',    name: 'Learning',    icon: '\u{1F393}',  description: 'Leaves TODO(human) pieces for you' },
]

/** Auto-compact window sizes accepted by the CLI's `--autocompact` flag ('auto', or 100k-1M). */
export const AUTOCOMPACT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '',     label: 'OrcStrator default (80% of window)' },
  { value: 'auto', label: 'Auto (let Claude Code decide)' },
  { value: '100k', label: '100k tokens' },
  { value: '200k', label: '200k tokens' },
  { value: '500k', label: '500k tokens' },
  { value: '1m',   label: '1M tokens' },
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
  // Endpoints extracted from the working claude.exe binary (v2.1.170), which runs this
  // exact OAuth flow with this exact client_id. Anthropic migrated console.anthropic.com
  // to platform.claude.com - older endpoint sets (all-console, or a mix of
  // console-token + platform-redirect) now fail the token exchange with a misleading
  // 429 "Rate limited". token URL and redirect_uri must BOTH be platform.claude.com.
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  scopes: 'org:create_api_key user:profile user:inference',
  // The authorize page must be the same platform host as the redirect/token pair -
  // codes minted by the legacy claude.ai authorize page are rejected by the platform
  // token endpoint (masked as 429).
  authBaseUrl: 'https://platform.claude.com/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  usageUrl: 'https://api.anthropic.com/api/oauth/usage'
}

// Plan-limit alert thresholds (% of a bucket). Each fires once per crossing.
export const USAGE_ALERT_THRESHOLDS = [50, 80, 95] as const
