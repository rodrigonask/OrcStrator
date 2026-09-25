import type { TurnOrigin } from '@orcstrator/shared'

// ─────────────────────────────────────────────────────────────────────────────
// Every way a Claude CHAT TURN can start in this server, and whether it surfaces.
//
// The rule: when tasks start running, they have to appear in the user's window.
// Any turn that begins WITHOUT the user clicking has to pull its chat into the grid, glow
// once, and hold a bright status until the user looks at it. Any turn the user started,
// and any continuation of a turn already accounted for, must stay quiet.
//
// The executable decision is the switch inside sendMessage (claude-process.ts). Two
// things keep it honest, and both are compile errors rather than good intentions:
//
//   1. `origin` is a REQUIRED field of SendMessageOpts, so a new CALLER cannot start a
//      turn without saying what kind it is.
//   2. That switch ends in `const unhandled: never = origin`, and the table below is a
//      Record keyed by TurnOrigin, so a new ORIGIN breaks the build in both places until
//      someone decides whether it surfaces. Verified, not assumed: adding one member to
//      the union produced `TS2322: Type '"probe"' is not assignable to type 'never'`.
//
// Not covered, deliberately: command-registry's skill pass-through and CLI subcommand
// proxy spawn `claude` directly, and compactInstance runs a pre-turn /compact. None of
// them is a turn in a chat, none of them shows in the transcript, and all three are
// things the user typed. If one ever becomes a chat turn it has to come through sendMessage.
// ─────────────────────────────────────────────────────────────────────────────

/** What the surfacing switch does with each origin, and why. */
export type SurfacingRule =
  | 'always'        // pulls its chat into the grid every time
  | 'unless-ui'     // surfaces unless the request declared startedBy: 'user'
  | 'never'

interface OriginSpec {
  surfaces: SurfacingRule
  /** Who triggers it, and where the call lives. */
  note: string
}

/**
 * Keyed by TurnOrigin, so this table cannot fall behind the union: leave a member out and
 * it does not compile. This is a "living check" in a form the
 * compiler reads rather than a comment that can quietly go stale.
 */
export const TURN_ORIGIN_TABLE: Record<TurnOrigin, OriginSpec> = {
  user: { surfaces: 'never', note: 'composer send, /answer-question, decide-plan and idle /btw, all through routes/instances.ts /send. It is the user; they are already looking at it.' },
  routine: { surfaces: 'always', note: 'routine scheduler tick or Run now (services/routine-scheduler.ts).' },
  wakeup: { surfaces: 'always', note: 'ScheduleWakeup fire (services/wakeup-scheduler.ts).' },
  task: { surfaces: 'always', note: 'pipeline card Start, clicked OR over HTTP (services/task-runner.ts). The server cannot tell the two apart and must not try.' },
  retry: { surfaces: 'never', note: 'auto-retry after a retryable error (services/claude-process.ts). A continuation: a second surfaced_at would re-glow a chat that already surfaced.' },
  keepalive: { surfaces: 'never', note: 'cache keep-warm ping (services/cache-advisor.ts). Fires on a timer against every keep_warm chat, so surfacing it would glow half the grid every cache TTL.' },
  btw: { surfaces: 'never', note: 'queued "by the way" note flushed on turn exit (claude-process.ts, routes/instances.ts). The user\'s own note, delivered late.' },
  'agent-edit': { surfaces: 'unless-ui', note: 'agent edit-session interview (routes/agents.ts). The UI opens the chat it just made; an HTTP caller leaves it running off-screen.' },
  summary: { surfaces: 'unless-ui', note: 'session summary request (routes/sessions.ts). Same rule as agent-edit.' },
  command: { surfaces: 'never', note: 'NO CALLER TODAY. A slash command reaches sendMessage through the /send route, so it arrives as user. Kept as a named seat: if a slash command ever starts a turn directly, it lands here and the choice is visible rather than inherited. Do NOT reach for this origin to quieten an autonomous start.' },
}

/** Every origin, derived from the table so the two can never disagree. */
export const TURN_ORIGINS = Object.keys(TURN_ORIGIN_TABLE) as TurnOrigin[]

export function isTurnOrigin(value: unknown): value is TurnOrigin {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TURN_ORIGIN_TABLE, value)
}

/** For the one log line that says what kind of turn just started and whether it showed itself. */
export function describeOrigin(origin: TurnOrigin): string {
  return `${origin}/${TURN_ORIGIN_TABLE[origin].surfaces}`
}
