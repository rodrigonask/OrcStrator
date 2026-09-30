import type { PermissionBundleId } from './permission-bundles.js'
import type { PermissionScope, PermissionUpdate } from './permission-rules.js'

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
  stealthMode?: boolean
  lastSyncedAt?: number
  /** Left out of the sidebar, with every card, routine, comment and chat kept. Shown again
   *  from the "Hidden projects" list. Hiding never deletes anything. */
  hidden?: boolean
  /** Permission rules for every chat in this project, ADDED to the app-wide and per-chat ones.
   *  Inherited down the folder tree: a chat in `C:\code\clients\acme` also carries whatever
   *  `C:\code\clients` and `C:\code` grant, because that is exactly how the sidebar nests
   *  them. Allow only in the UI, though the spawn path unions deny and ask too if they are ever
   *  written here. Undefined = adds nothing. Applies from a chat's next turn. */
  permissionRules?: PermissionRuleSet
}

export type ProcessState = 'idle' | 'reserved' | 'spawning' | 'running' | 'exiting'

/** What kind of autonomous start surfaced a chat. See InstanceConfig.surfacedAt. */
export type SurfaceSource = 'routine' | 'wakeup' | 'task'

/**
 * Who asked for a Claude turn. REQUIRED on every sendMessage call, because the
 * surfacing decision (does this chat pull itself into the grid?) is made from it and
 * nothing else. A new caller that does not declare an origin does not compile, which
 * is the whole point: visibility stops being something a caller can forget.
 *
 * The authoritative per-origin table lives in server/src/services/turn-origins.ts.
 */
export type TurnOrigin =
  | 'user'        // the user typed it
  | 'routine'     // routine scheduler fire (or run-now)
  | 'wakeup'      // ScheduleWakeup fire
  | 'task'        // pipeline card start, clicked or over HTTP
  | 'retry'       // auto-retry after a retryable error: a continuation
  | 'keepalive'   // cache keep-warm ping: never a real turn
  | 'btw'         // queued "by the way" note flushed after a turn: a continuation
  | 'agent-edit'  // agent edit-session interview
  | 'summary'     // session summary request
  | 'command'     // slash command turn (routed through /send today)

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
  activeTaskId?: string
  activeTaskTitle?: string
  taskStartedAt?: number
  overdriveTasks?: number
  overdriveStartedAt?: number
  lastTaskAt?: number
  contextHealth?: 'cold' | 'fresh' | 'warm' | 'heavy' | 'stale'
  ctxTokens?: number
  ctxModel?: string
  /** Count of files this instance holds uncommitted edit-locks on (server file_locks
   *  table - tracked-modified only). Drives the sidebar "uncommitted work" ⚠ badge. */
  dirtyCount?: number
  /** Keep this session's prompt cache warm: the server fires a minimal keep-alive turn
   *  (on the session's own model) just before the cache TTL expires, so the session
   *  never pays a cold-start re-read. User-toggled via the 🔥 chip. */
  keepWarm?: boolean
  /** Duration of this chat's most recent turn, in ms. Drives the "worked for" footnote on
   *  the chat's LAST message. Denormalized from turn_costs.duration_ms so the client gets it
   *  on the instance object it already holds. Undefined until the chat has run one turn. */
  lastTurnMs?: number
  /** Longest single turn this chat has ever run, in ms. Monotonic maximum, never overwritten
   *  by a later shorter turn. Drives the longest-turn record. */
  maxTurnMs?: number
  /** Client-side, not persisted: id of the assistant message that ended the turn lastTurnMs
   *  describes. Pins the footnote to the right message instead of "whatever is last". Absent
   *  after a reload, where the client falls back to the last assistant message. */
  lastTurnMessageId?: string
  /** Client-side: set when a compaction event arrives, drives the "Compacted ✓" flash */
  ctxCompactedAt?: number
  /** Client-side: last turn's token breakdown for the context gauge hover tooltip.
   *  `input` is the COLD (uncached) input - exclusive of cacheRead/cacheCreation. */
  lastTurnUsage?: { input: number; cacheRead: number; cacheCreation: number; output: number }
  /** Live: epoch ms the current turn (round-trip) started - drives the composer's
   *  CLI-style elapsed timer. Set by the server on spawn, cleared when the turn ends. */
  turnStartedAt?: number
  /** Live: output tokens generated so far in the current turn (accumulates per
   *  assistant step). Cleared when the turn ends. */
  turnOutputTokens?: number
  /** Claude Code's own task list for this session, read straight off disk. See NativeTask. */
  nativeTasks?: NativeTask[]
  /**
   * Set when a turn hard-stopped on an interactive card and is BLOCKED ON THE USER:
   * 'question' for AskUserQuestion, 'plan' for ExitPlanMode.
   *
   * Why this exists: those tools deliberately kill the process (see
   * `hardStopForQuestion` in claude-process.ts) so the card is the last thing on
   * screen, and the exit handler then sets `state = 'idle'`. Without this column an
   * instance waiting on the user is indistinguishable from one that finished, so it
   * silently dropped out of the top-bar active strip, worst of all on a FIRST turn, which
   * has no warm cache to keep it there either.
   *
   * It is written by the server BEFORE the kill and cleared only when a new turn
   * spawns, or on an explicit stop/pause/reset. It deliberately survives the process
   * exit, a server restart, and a browser reload: the question is still pending.
   */
  awaitingInput?: 'question' | 'plan'
  /** Epoch ms the instance started waiting on the user. Sorts the oldest block first. */
  awaitingInputAt?: number
  /**
   * Set when a SCHEDULED fire (a routine or a wake-up) started a turn in this chat and the
   * chat has not been looked at since. Server-side truth, so it survives the app being
   * closed: on the next open the chat is still a grid tile and still owes its one glow.
   * Cleared by POST /instances/:id/surface-ack when the tile is focused or the chat is
   * selected. A NEW fire writes a new value, which is what lets the glow play again.
   */
  surfacedAt?: number | null
  /** What fired: a routine or a ScheduleWakeup wake-up. Null when nothing is pending. */
  surfacedSource?: SurfaceSource | null
  /**
   * Stamped at spawn from the routine's own silent flag. A silent chat never surfaces:
   * no tile, no glow, no bright status, not even for a wake-up scheduled from inside it.
   */
  surfaceSilent?: boolean
  /** Per-chat override of the app-wide `outputStyle` setting. Undefined/empty = inherit.
   *  Lives on the instance (not client-side like verbosity) because the server has to hand
   *  it to the CLI at spawn time. Applies from the chat's next turn. */
  outputStyle?: string
  /** Per-chat override of the app-wide `language` setting. Undefined/empty = inherit. */
  language?: string
  /** Permission rules for this chat, ADDED to the app-wide ones rather than replacing them.
   *  Unlike outputStyle this is not an override: "give this chat permissions" is a grant for
   *  one session. Denies win from either side, so a chat can tighten itself but can never
   *  loosen an app-wide deny. Undefined = adds nothing. Applies from the next turn. */
  permissionRules?: PermissionRuleSet
}

/**
 * One set of permission rules, in the two shapes the Claude CLI reads. Used app-wide (as the
 * five flat keys on AppSettings) and per-chat (as this object on InstanceConfig), so the same
 * five buckets mean the same thing in both places.
 */
export interface PermissionRuleSet {
  /** Plain-English grants this set turns on, by id. Expanded to allow patterns at spawn time
   *  rather than copied into `allow`, so a bundle whose contents improve in a later version
   *  applies without anyone re-clicking anything. See shared/permission-bundles.ts. */
  bundles?: PermissionBundleId[]
  /** Deterministic allow patterns, e.g. `Bash(gh pr merge:*)`. Globs, not plain prefixes. */
  allow?: string[]
  /** Deterministic deny patterns. Beat allow rules from every source. */
  deny?: string[]
  /** Deterministic ask patterns: stop the turn and raise the Allow/Deny banner. Beat allow
   *  rules, and are themselves beaten by a deny for the same command. See
   *  AppSettings.permissionAskRules. */
  ask?: string[]
  /** One-time ask rules, written by the refusal card's "Allow once". Unioned into
   *  `ask` at spawn, so the retry of a call auto mode refused stops on the banner instead of
   *  going back to the classifier. The server removes a rule from here the moment a banner it
   *  raised is answered, which is what makes it once rather than forever. */
  askOnce?: string[]
  /** Auto-mode classifier rules, plain English. Advisory: see AppSettings.autoModeAllow. */
  autoAllow?: string[]
  autoSoftDeny?: string[]
  autoHardDeny?: string[]
}

/**
 * One entry from Claude Code's NATIVE task list.
 *
 * The CLI's own TaskCreate/TaskUpdate tools materialise these as
 * `~/.claude/tasks/<session-id>/<n>.json` - the exact files the CLI reads back to
 * draw its ctrl+t panel. OrcStrator only ever READS them: the CLI owns the state,
 * we are a viewer. That is deliberate, and it is why there is no DB column and no
 * stream parsing here - a second copy of the truth would be a second thing to
 * desync. (Legacy note: this replaced the older TodoWrite tool, whose flat
 * `~/.claude/todos/` store no longer exists.)
 */
export interface NativeTask {
  /** Numeric string, and also the creation order - sort by it. */
  id: string
  subject: string
  /** Present-continuous label the CLI shows in its spinner while in_progress. */
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Ids of tasks that must finish first. Empty for most tasks. */
  blockedBy: string[]
  /**
   * When this task last changed status, as epoch ms. Taken from the task file's mtime,
   * because the CLI writes no timestamp of its own and rewrites the whole file on every
   * TaskUpdate, which makes mtime an exact record of the last transition. For a completed
   * task it is when it was completed.
   *
   * Optional on purpose: it is populated by a server that knows how to read it, and the
   * client must keep working against one that does not (it then treats every task as
   * current, which is the behaviour from before this field existed).
   */
  updatedAt?: number
}

// === CHAT MESSAGES ===

export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  // `url`: the full image, stored as a file by the server and served from
  // GET /api/media/:name. When it is set, `base64` holds only a small JPEG thumbnail (and
  // `mediaType` describes that thumbnail, not the file behind `url`). Rows saved
  // before it existed have no `url` and the full image in `base64`.
  | { type: 'image'; base64: string; mediaType: string; url?: string }
  | { type: 'tool-call'; toolId: string; toolName: string; input: string; parentToolUseId?: string }
  | { type: 'tool-result'; toolId: string; output: string; isError?: boolean }
  | { type: 'cost'; inputTokens: number; outputTokens: number; costUsd?: number; durationMs?: number }
  | { type: 'error'; message: string }

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
  | { type: 'text-delta'; instanceId: string; text: string; parentToolUseId?: string }
  | { type: 'tool-start'; instanceId: string; toolId: string; toolName: string; parentToolUseId?: string }
  | { type: 'tool-input-delta'; instanceId: string; toolId: string; input: string; parentToolUseId?: string }
  | { type: 'tool-complete'; instanceId: string; toolId: string; output: string; isError?: boolean; parentToolUseId?: string }
  | { type: 'result'; instanceId: string; sessionId?: string; costUsd?: number; inputTokens?: number; outputTokens?: number; durationMs?: number; cacheCreationTokens?: number; cacheReadTokens?: number; resultText?: string; model?: string; deltaCostUsd?: number; deltaInputTokens?: number; deltaOutputTokens?: number; deltaCacheCreationTokens?: number; deltaCacheReadTokens?: number; sessionTotalCostUsd?: number; turnMessageId?: string }
  | { type: 'error'; instanceId: string; message: string }
  | { type: 'system'; instanceId: string; sessionId?: string }
  | { type: 'raw-line'; instanceId: string; line: string; isStderr?: boolean }
  | { type: 'assistant-message'; instanceId: string; message: ChatMessage }
  | { type: 'cli-prompt'; instanceId: string; eventType: string; data: Record<string, unknown> }
  | { type: 'compaction'; instanceId: string; trigger: 'auto' | 'manual' | 'unknown'; summary?: string }
  | { type: 'ask-user'; instanceId: string; toolId: string; questions: AskUserQuestionInput[]; parentToolUseId?: string }
  | { type: 'plan-presented'; instanceId: string; toolId: string; plan?: string; allowedPrompts?: Array<{ tool: string; prompt: string }>; parentToolUseId?: string }
  | ({ type: 'permission-request'; instanceId: string; requestId: string; toolName: string; displayName?: string; toolUseId?: string; description?: string; input: Record<string, unknown> } & PermissionRequestMeta)

/**
 * What a can_use_tool request says about WHY it is asking, beyond the tool and its input.
 *
 * All of this used to be dropped in the stream parser, and it is exactly what decides whether an
 * "Allow always" button can honestly be offered: a request raised by an ask rule cannot be turned
 * into an allow (an ask beats an allow), a safety check the classifier may not approve will ask
 * again whatever is saved, and the CLI itself can say a saved rule will not apply to this call.
 * Snake_case on the wire, camelCase here. Every field is optional because older CLIs omit them.
 */
export interface PermissionRequestMeta {
  /** The CLI's own suggested rule changes for this call (PermissionUpdate[]). */
  permissionSuggestions?: PermissionUpdate[]
  /** The path a file-tool safety check tripped on, e.g. something under `.claude/`. */
  blockedPath?: string
  /** Why the CLI is asking, in its words, ANSI colour codes removed. */
  decisionReason?: string
  /** Machine form of the above, e.g. `rule`, `safetyCheck`, `subcommandResults`. */
  decisionReasonType?: string
  /** False when this needs a human and the classifier is not allowed to approve it. */
  classifierApprovable?: boolean
  /** True when the CLI says saved allow rules will not apply to this call at all. */
  suppressAlwaysAllowRule?: boolean
  /** The ask rule that raised this request, when one did, as a rule string. */
  matchedAskRule?: string
}

// Client-side state for a pending tool-permission request (the PermissionBanner).
// Mirrors the 'permission-request' stream event plus the local receivedAt stamp.
export interface PermissionRequestData extends PermissionRequestMeta {
  instanceId: string
  requestId: string
  toolName: string
  displayName?: string
  toolUseId?: string
  description?: string
  input: Record<string, unknown>
  receivedAt: number
}

// AskUserQuestion tool input shape - mirrors what the CLI emits as tool_use.input.
export interface AskUserQuestionOption {
  label: string
  description?: string
}
export interface AskUserQuestionInput {
  question: string
  header: string
  multiSelect?: boolean
  options: AskUserQuestionOption[]
}

export interface ClaudeProcessExitEvent {
  instanceId: string
  sessionId?: string
  exitCode: number | null
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
}

// === SESSION COST STATE ===

export interface SessionCostState {
  totalCost: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
  turns: number
  recentCacheRate: number
  lastCacheCreatedAt?: number  // ms timestamp of most recent turn that wrote cache_creation_tokens
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

// Compaction (tool-output) savings - ESTIMATED tokens/cost the PostToolUse compaction hook
// kept out of context. Distinct from the cache savings above; tokens are derived from byte
// deltas (chars / charsPerToken), priced once at the model's input rate (conservative).
export interface CompactionSavingsDay {
  day: string
  compactions: number
  beforeChars: number
  afterChars: number
  savedTokens: number
  savedUsd: number
}

export interface CompactionSavingsSummary {
  days: CompactionSavingsDay[]
  totalCompactions: number
  totalBeforeChars: number
  totalAfterChars: number
  totalSavedTokens: number
  totalSavedUsd: number
  charsPerToken: number
  enabled: boolean
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

export type PipelineColumn = 'backlog' | 'ready' | 'in_progress' | 'in_review' | 'done'

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
  // groupId / groupIndex / groupTotal / dependsOn / skill lived here after the orchestrator
  // was removed, kept alive only by two badges in TaskCard.tsx that could no longer appear.
  // TaskCard was rewritten for the schedule pills, the JSX went with it, and a repo-wide
  // grep confirmed nothing else read them, so they are gone.
  createdBy: string
  history: TaskHistoryEntry[]
  completedAt?: number
  createdAt: number
  updatedAt: number
  /**
   * When the work this task describes actually happened, as opposed to when the row was
   * filed. `createdAt` on a session log is the moment the chat was CLOSED, which can be
   * weeks after the last turn, so any "what did we do in period X" question has to read
   * these instead. Undefined for hand-filed tasks that never ran a session.
   */
  workStartedAt?: number
  workEndedAt?: number
  totalInputTokens?: number
  totalOutputTokens?: number
  totalCostUsd?: number
  /** Instance that is working / last worked this task (set by start-from-task) */
  instanceId?: string

  // ── Schedule (a task that carries one is what used to be a "routine") ──────
  // A card with scheduleKind === undefined is an ordinary card and the scheduler
  // never looks at it. With a kind it gains a fire path, a run history, and the
  // pills the old RoutineCard drew.
  //
  // ⚠ targetInstanceId and instanceId are TWO DIFFERENT THINGS and collapsing them
  // is the single worst thing that can be done to this type. See targetInstanceId.
  /**
   * undefined or null = no schedule (an ordinary card).
   *
   * Null is a value the CLIENT sends, and it means "clear the schedule on this card". An
   * omitted field leaves the column alone, so switching a card back to Now has to send an
   * explicit null or the old schedule survives the edit.
   */
  scheduleKind?: TaskScheduleKind | null
  /**
   * every: minutes as string (e.g. "300");
   * times: a comma-separated list of 'HH:MM' (e.g. "11:00,19:00");
   * once: 'YYYY-MM-DDTHH:MM'. A once card fires exactly once (late if it has to, never
   * silently dropped) and disarms itself after dispatch.
   *
   * Every wall-clock value is read in scheduleTz, or in computer time when that is null.
   */
  scheduleValue?: string | null
  /**
   * Date.getDay() numbers as 'D,D,D', ascending and unique (e.g. "0,2,3,4,5"). null or
   * undefined means every day. On an 'every' card the filter is about the day the active
   * WINDOW OPENS, so an overnight window that opened on Friday finishes on Saturday even
   * though Saturday is switched off.
   */
  scheduleDays?: string | null
  /**
   * 'HH:MM-HH:MM', on 'every' only. null means the whole day. An end at or before the
   * start means the window runs overnight and closes the following day. The end minute
   * is INCLUSIVE: "11:00 to 19:00, every 4 hours" fires at 19:00.
   */
  scheduleWindow?: string | null
  /**
   * IANA zone name, e.g. 'Asia/Tokyo'. null means COMPUTER TIME: whatever this machine
   * is set to, read fresh at every computation, so routines follow the laptop abroad. Never
   * the server's zone by accident; a card that names a zone keeps it wherever it runs.
   */
  scheduleTz?: string | null
  /** 'YYYY-MM-DD', inclusive, read in the card's zone. null = runs forever. */
  scheduleUntil?: string | null
  /** Stop after this many runs. null = no limit. */
  scheduleMaxRuns?: number | null
  /** Runs completed. Counts ok and error runs, never skips. */
  runCount?: number
  /**
   * What to do with a slot that went by while nothing was running. 'late' fires it if it
   * is still fresh, 'skip' records it as skipped and arms the next one.
   */
  catchupPolicy?: 'late' | 'skip' | null
  /** Consecutive failed runs. Reset by any ok run. Never touched by a skip or an interrupt. */
  consecutiveFailures?: number
  /** Switch the card off after this many consecutive failures. 0 = never. Default 3. */
  disarmAfterFailures?: number
  /** Kill a run that has been going this long. null = no limit. */
  maxRunMinutes?: number | null
  /** Rolling 7-day spend ceiling for THIS card. null = no limit, which is the default. */
  budgetCapUsd?: number | null
  /** Compact the chat when a scheduled run's turn finishes. */
  autoCompact?: boolean
  /** Close the chat when a scheduled run's turn finishes (after the compact, when both). */
  autoClose?: boolean
  /**
   * Close itself when it succeeds. The run must end its final message with `RESULT: OK`;
   * then the card goes to Done and its chat is closed. Anything else (NEEDS_REVIEW, no verdict,
   * a crash) keeps the chat and sends the card to review. Manual and scheduled cards alike.
   */
  selfClose?: boolean
  /**
   * The session an auto-close left behind, so the NEXT fire can resume it and the routine
   * keeps its memory without keeping its tab. A third identity, and emphatically not
   * targetInstanceId: the card is still aimed at its project.
   */
  resumeSessionId?: string | null
  /**
   * null normally. Set when the board has to explain the card rather than just show a
   * next-run time: it finished its run of runs, it failed too many times, or it is over
   * its rolling budget.
   */
  scheduleState?: 'finished' | 'failed' | 'over_budget' | null
  /** Armed. A card can carry a schedule and be switched off. */
  scheduleEnabled?: boolean
  nextRunAt?: number | null
  lastRunAt?: number | null
  /**
   * Set while the card is due but its chat is busy. The slot is NOT advanced: the
   * scheduler keeps retrying every poll until the chat is idle or the wait deadline
   * passes. null when nothing is waiting.
   */
  queuedSince?: number | null
  /**
   * CONFIG: the chat every scheduled fire is aimed at, or null for a card aimed at its
   * project instead, where each fire opens a fresh chat in projectId.
   *
   * NOT `instanceId`. `instanceId` is RUNTIME: the chat that is working or last worked
   * this card, stamped by whatever run happened most recently. They point in opposite
   * directions. Collapse them and a scheduled card silently re-points itself at whatever
   * chat last ran it, then fires into a stranger's session at 3am.
   */
  targetInstanceId?: string | null
  /**
   * Silent mode. A silent card runs exactly as a normal one but its fires never SURFACE:
   * the chat is not pulled into the grid, does not glow, and does not take the bright
   * "scheduled" status. It is still in the sidebar, run history and activity panel.
   */
  silent?: boolean
  /**
   * The description IS the message: no kickoff template, no title heading, no comments
   * block, no image prefix. A second bypass alongside the slash-command passthrough,
   * carried by every card migrated out of the routines table so existing routine cards
   * send byte-identical text to what they sent before the merge.
   */
  rawPrompt?: boolean
  /**
   * Send the card's comments to the chat as context when it starts. null = AUTO: on for a
   * plain task, off for a card with a schedule (a routine is a fixed instruction, and notes
   * about past runs should not feed the next one). Ignored when the card sends verbatim.
   */
  sendComments?: boolean | null

  // ── Run settings. null/undefined means INHERIT THE GLOBAL DEFAULT, not "off". ──
  // A null is unset. The card must never freeze today's global default into its row:
  // change the default in Settings and every unset card follows it.
  /** Model id, e.g. 'claude-haiku-4-5-20251001'. Unset = the global defaultModel. */
  model?: string | null
  /** Unset = the global defaultEffort. */
  effort?: EffortLevel | null
  /** Unset = whatever the global flags say. */
  permissionMode?: PermissionMode | null
  maxBudgetUsd?: number | null
  fallbackModel?: string | null
  /** Rides the managed CLI settings file, not an argv flag. */
  outputStyle?: string | null
  /** Rides the managed CLI settings file, not an argv flag. */
  language?: string | null
}

export interface TaskComment {
  id: string
  taskId: string
  author: string
  body: string
  createdAt: number
}

export interface TaskHistoryEntry {
  action: 'created' | 'moved' | 'blocked' | 'unblocked' | 'edited' | 'completed'
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

// === SKILL INVENTORY (deterministic disk scan, no model call) ===

/** Where a skill was found. Determines how it is invoked and who can see it. */
export type SkillSource = 'personal' | 'project' | 'plugin' | 'command'

export interface ScannedSkill {
  /** `name:` from the frontmatter, falling back to the directory name. */
  name: string
  /** The directory (or file) name, which is what the invocation is built from. */
  slug: string
  description: string
  argumentHint?: string
  /** `user-invocable: false` skills exist but cannot be typed as a slash command. */
  userInvocable: boolean
  source: SkillSource
  /** 'Personal', the project's display name, or the plugin's name. */
  scope: string
  /** What you type to run it, e.g. `/review` or `/telegram:access`. */
  invocation: string
  /** Absolute path to the SKILL.md (or the .md, for commands). */
  path: string
  bytes: number
  mtime: number
}

export interface SkillInventory {
  skills: ScannedSkill[]
  scannedAt: number
  roots: {
    personal: string
    commands: string
    plugins: string
    projects: string[]
  }
  /** True: the CLI's compiled-in skills are not reachable from disk and are absent. */
  excludesBuiltIns: boolean
}

// === MCP SERVER DISCOVERY ===

export interface McpServerInfo {
  name: string
  type: string
  source: string    // 'global' | 'project:<dir>'
  command?: string
}

// === SETTINGS ===

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'dontAsk' | 'auto' | 'bypassPermissions'
export type EffortLevel = 'low' | 'medium' | 'high' | 'max' | 'xhigh'
export type AgentModel = 'haiku' | 'sonnet' | 'sonnet-5' | 'opus' | 'opus-5' | 'opus-5-5' | 'opus-4-6' | 'opus-4-7' | 'opus-4-8' | 'fable' | 'fable-5' | 'fable-5-1' | 'default'

export interface AppSettings {
  globalFlags: string[]
  idleTimeoutSeconds: number
  notifications: boolean
  startWithOS: boolean
  rootFolder: string
  usagePollMinutes: number
  theme: 'light' | 'dark' | 'system'
  port: number
  permissionMode?: PermissionMode
  permissionCycleModes?: PermissionMode[]
  maxBudgetUsd?: number
  fallbackModel?: AgentModel
  disableCache?: boolean
  promptCache1h?: boolean
  // Auto-resend "Try Again" when a normal chat turn fails with a transient server error
  // (rate limit / overload - never the user's usage limit). Default on. See claude-process.ts.
  autoRetryOnRateLimit?: boolean
  // Context-compaction PostToolUse hook: trim large tool outputs before they enter context.
  // Default ON (absent = enabled); only an explicit false opts out. See server hook-injector.ts.
  contextCompactionHook?: boolean
  // When compaction is on: lossless (default true) skips the lossy head/tail elision of big outputs.
  compactionLossless?: boolean
  maxTokens?: number
  userName?: string
  userEmoji?: string
  columnLabels?: Partial<Record<PipelineColumn, string>>
  animationsEnabled?: boolean
  soundsEnabled?: boolean
  animationTier?: 0 | 1 | 2 | 3 | 4
  soundTier?: 0 | 1 | 2 | 3 | 4
  namingTheme?: string  // deprecated - use namingThemes
  namingThemes?: string[]
  // How new chats are named: 'random' = client-side word pool (namingThemes);
  // 'ai' = a 2-3 word Haiku title from the first message, with random words as the
  // fallback when no Anthropic API key is set or the call fails. Key is stored
  // server-side (encrypted) via /settings/anthropic-key, never in this object.
  namingMode?: 'random' | 'ai'
  // When closing a session, summarize its last messages with Haiku and file the summary
  // on the linked task. 'tasks' = only sessions that were started from a pipeline task,
  // 'all' = every session, 'off' = never. Shares the same stored Anthropic key as
  // namingMode: 'ai'. Default 'tasks'.
  sessionSummaryMode?: 'all' | 'tasks' | 'off'
  maxConcurrentProcesses?: number
  /** Enforce maxConcurrentProcesses. Off (absent) by default: the cap was never enforced before. */
  maxConcurrentLimitOn?: boolean
  maxGridTiles?: number        // hard cap on grid tiles open at once (default 12)
  maxGridColumns?: number      // max columns the grid lays tiles into (default 6, for ultrawide)
  // Ultra Compact Mode: one switch, every density change at once. The horizontal top bar
  // becomes a 32px vertical rail on the right, each tile's header/run-status/task-count
  // merge into a single strip, the task list collapses to its live row, and the grid's
  // own padding and gaps tighten. Buys back roughly 245px of transcript per tile in a
  // 2-row grid. The rail is deliberately always visible: it is the way back out.
  ultraCompact?: boolean
  // Width cap (px) of a maximized chat tile, so text keeps a readable line length
  // on ultrawide monitors instead of running the full screen. 0 = no cap (full width).
  chatReadingWidth?: number    // default 1200
  verbosity?: VerbosityLevel
  customCommands?: Array<{ name: string; command: string; description: string }>
  /** Unset (or null, which the settings route deletes) = the app default in constants. */
  defaultModel?: AgentModel | null
  defaultEffort?: EffortLevel | null
  /** Prompt template used when starting an instance from a pipeline task.
   *  Placeholders: {{title}}, {{description}}, {{comments}} */
  taskKickoffTemplate?: string
  // Show the Claude plan-limits widget (sidebar). Display only - never enforced.
  showPlanLimits?: boolean

  // === Claude CLI settings (the /config surface, reachable headlessly) ===
  // These are NOT OrcStrator behaviours: each one is a real key the `claude` CLI reads,
  // handed to the spawn as a managed `--settings` file. Anything /config exposes that only
  // means something to the CLI's own terminal UI (theme, spinner tips, transcript view mode,
  // auto-updates) is deliberately absent, because OrcStrator draws its own UI: dead knobs.
  /** Output style name: 'Default' | 'Concise' | 'Proactive' | 'Explanatory' | 'Learning',
   *  or the name of a custom style in ~/.claude/output-styles. Changes the system prompt,
   *  so it applies from the NEXT turn and costs one prompt-cache rewrite when changed. */
  outputStyle?: string
  /** Preferred language for Claude's replies, e.g. "spanish", "japanese". Empty = English default. */
  language?: string
  /** Auto-compact window handed to `--autocompact`: 'auto', or a token budget between
   *  100k and 1M ('200k', '500k'). Undefined leaves OrcStrator's own 80% threshold alone. */
  autocompact?: string

  // === Permission rules (also CLI settings, but a big enough surface to group) ===
  // Both blocks ride in the same managed `--settings` file, which is the CLI's `flagSettings`
  // source. Rules are kept per source and unioned, so these ADD to whatever is already in
  // ~/.claude/settings.json and the repo's .claude; they never replace them.
  /** Deterministic allow rules in the CLI's own pattern syntax, e.g. `Bash(gh pr merge:*)`.
   *  Matched BEFORE the auto-mode classifier is consulted, so a matching call never reaches
   *  it. Glob, not plain prefix: `Bash(git push:*)` also covers `git push --force`, so
   *  narrowing a broad allow is the deny list's job. */
  /** Plain-English grants turned on app-wide, by id. Expanded at spawn, not copied into
   *  permissionAllowRules, so improving a bundle reaches everyone. */
  permissionBundles?: PermissionBundleId[]
  /** Add the destructive fence: deny rewriting or deleting already-pushed history, and deny
   *  deleting the folders the OS needs. Default ON. Turning it off is what makes "allow
   *  everything" mean everything, which is the only honest way to offer that button. */
  blockDestructive?: boolean
  permissionAllowRules?: string[]
  /** Deterministic deny rules, same syntax. Beat allow rules. */
  permissionDenyRules?: string[]
  /** Deterministic ASK rules, same syntax. A match STOPS the turn and raises the Allow/Deny
   *  banner instead of deciding, and the tool then runs unchanged if approved.
   *
   *  This is the only rule kind that gates without the agent ever seeing a refusal, which is
   *  why it exists. A deny hands the agent "Permission ... has been denied", the agent
   *  narrates a workaround and carries on, and any grant made afterwards arrives on work
   *  that is already done a different way. An ask never gets that far.
   *
   *  Measured against the real CLI 2.1.263: an ask rule in
   *  this managed file raises `can_use_tool` even under Auto mode, it BEATS an allow rule for
   *  the same command, and a `deny` for the same command BEATS it. So anything that should
   *  gate rather than block has to live here and NOT in the deny list. */
  permissionAskRules?: string[]
  /** Auto-mode classifier rules, in plain English rather than patterns. Only read in Auto
   *  mode, and only from user, flag and managed settings: the CLI explicitly ignores an
   *  `autoMode` block in a repo's own settings files, a repo being attacker-controllable.
   *  OrcStrator's managed file is the flag source, so these reach the CLI.
   *
   *  Advisory in practice. Tested against the real CLI, none of these three keys
   *  changed a verdict: an allow did not get `git push origin HEAD:main` through, and a
   *  hard_deny did not block a command the classifier already liked. Anything that must hold
   *  belongs in permissionAllowRules / permissionDenyRules, which are deterministic. */
  autoModeAllow?: string[]
  /** Classifier rules that make the call ask rather than proceed. */
  autoModeSoftDeny?: string[]
  /** Classifier rules that refuse outright. */
  autoModeHardDeny?: string[]
  /** The scope the last "Allow always" was saved at, so the picker opens where it was left.
   *  A preference, not a rule: an unreadable or missing value falls back to 'app', which is what
   *  both buttons did before the picker existed. */
  lastPermissionScope?: PermissionScope
}

// === USAGE MONITORING (Claude plan limits via OAuth usage API) ===

// 'model:<name>' covers per-model weekly limits from the API's `limits` array
// (e.g. 'model:fable') so new scoped models show up without a type change.
export type UsageBucketKey = 'session' | 'weekly' | 'extra' | `model:${string}`

export interface UsageBucket {
  key: UsageBucketKey
  label: string    // "Session" | "Weekly" | "Fable" | "Extra"
  pct: number      // 0-100, one decimal
  reset: string    // countdown like "2d 7h" / "45m" / "" when unknown
  resetsAt?: string // raw ISO timestamp from the API, when present
}

export interface UsageData {
  connected: boolean
  buckets: UsageBucket[]
  lastError?: string
  lastUpdated?: number
  /** Where the token came from: the app's own OAuth flow, or the Claude CLI's
   *  local credentials (zero-setup; follows whatever account `claude login` used). */
  source?: 'oauth' | 'cli'
}

// === ACCOUNT PROFILE ===

export interface AccountProfile {
  messagesSent: number
  tokensSent: number
  tokensReceived: number
  tasksDone: number
}

// === SESSION FILES ===

export interface SessionFile {
  sessionId: string
  instanceId?: string
  instanceName?: string
  folderId?: string
  folderName?: string
  folderEmoji?: string
  mtime: number
  /** File size on disk. Some transcripts here run past 300 MB. */
  sizeBytes?: number
  /** The ~/.claude/projects slug the file sits under, shown when no chat owns the session. */
  project?: string
  /** A sub-agent run spawned by another session. Hidden from the list unless asked for. */
  isSubagent?: boolean
  /** For a sub-agent: the session that spawned it. */
  parentSessionId?: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  lineCount: number
}

// === SCHEDULED TASKS ===
// A schedule is a property of a pipeline card, not an entity of its own. The
// `routines` table was merged into `pipeline_tasks` in migration047: one entity,
// one board, one lifecycle, one run history. See PipelineTask's schedule block.
//
// Still distinct from ScheduledWakeup, which is agent-initiated and one-shot.

/**
 * 'every' N minutes on a window-anchored grid, 'times' a list of clock times, 'once'.
 *
 * The old 'interval' / 'daily' / 'weekly' were converted by migration048 and are rejected
 * by the validator afterwards. There is no dual-read period on purpose: a row that still
 * said 'interval' would be firing on a grid nothing on screen describes.
 */
export type TaskScheduleKind = 'every' | 'times' | 'once'

/**
 * One row of the Task Activity panel: a scheduled fire that happened, is happening, or is
 * armed. Merged on the server from task_runs and scheduled_wakeups, newest first, so a
 * silent card (which never surfaces in the grid) is still findable.
 */
export interface ActivityEntry {
  id: string
  /**
   * 'routine' still means "the scheduler started this turn", sourced from the card's own
   * schedule rather than from a row in a table that no longer exists. The token is
   * deliberately unchanged: it is the same concept, it is load-bearing for the grid, and
   * renaming it would have to move every reference in surface.ts and turn-origins.ts
   * together for no behavioural gain.
   */
  kind: 'routine' | 'wakeup'
  /** Card title, or the wake-up's reason (falling back to its prompt). */
  name: string
  /** The scheduled card this run belongs to. null for a wake-up. */
  taskId: string | null
  instanceId: string | null
  instanceName: string | null
  folderId: string | null
  /** Run start, or the wake-up's fire time (scheduled time while still pending). */
  startedAt: number
  finishedAt: number | null
  /** scheduled fire: running | ok | error | skipped. wakeup: pending | fired | cancelled. */
  status: string
  error: string | null
  costUsd: number
  /** Whether that card is silent, so the panel can say why nothing surfaced. */
  silent: boolean
}

/**
 * 'interrupted' is NOT a failure. A run cut short because the server restarted says
 * nothing about whether the card works, so it must never count towards the
 * consecutive-failure ceiling that disarms a card. Before it existed such a run was
 * recorded as 'error', and three restarts in a row switched a healthy routine off.
 */
export type TaskRunStatus = 'running' | 'ok' | 'error' | 'skipped' | 'interrupted'

/** A scheduled fire, or the user pressing Run now. Manual runs skip the budget check. */
export type TaskRunKind = 'scheduled' | 'manual'

/**
 * One run of a task. Written by the scheduler on every fire (and by a manual run-now),
 * so every card gains a run history; before the merge only routines had one.
 */
export interface TaskRun {
  id: string
  taskId: string
  /** The chat the run landed on. null on a skip recorded before any chat was resolved. */
  instanceId: string | null
  startedAt: number
  finishedAt: number | null
  /** running | ok | error | skipped | interrupted. See TaskRunStatus: interrupted is not a failure. */
  status: TaskRunStatus
  error: string | null
  costUsd: number
  inputTokens: number
  outputTokens: number
  /** What the run did, from the close summary of its chat. null until the chat is closed. */
  summary: string | null
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
  /** can_use_tool requests each chat is blocked on right now, oldest first. Absent from servers
   *  that predate the permission banner. */
  pendingPermissions?: Record<string, PermissionRequestData[]>
}
