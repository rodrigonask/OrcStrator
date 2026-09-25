import crypto from 'crypto'
import fs from 'fs'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { processRegistry } from './process-registry.js'
import { setSurfaceSilent } from './surface.js'
import { releaseLocksForInstance } from './file-locks.js'
import { buildTurnFlags, applyTaskCliSettings } from './turn-flags.js'
import { buildKickoffPrompt, loadComments, sendsVerbatim, hasPrompt, NO_PROMPT_MESSAGE } from './kickoff-prompt.js'
import * as taskManager from './task-manager.js'
import { formatInstant, computeNextRun, validateScheduleSpec, describeSchedule, describeEvery, isInsideActiveWindow } from '@orcstrator/shared'
import type { TaskRun, TaskScheduleKind, ScheduleSpec } from '@orcstrator/shared'

// ─────────────────────────────────────────────────────────────────────────────
// Task scheduler: pipeline cards that carry a schedule, fired on a chat instance
// ("every 5 hours between 11:00 and 19:00 on Tue Wed Thu Fri and Sun", "at 11:00 and
// 19:00 on weekdays", or "once at this date and time").
//
// This was routine-scheduler.ts until migration047 merged the `routines` table into
// `pipeline_tasks`. The engine is the SAME engine: the query moved from one table to
// another and the column names changed, but every invariant below was carried across
// literally, comments included, because each of them cost a bug to find.
//
// NOT to be confused with:
//   - wakeup-scheduler.ts: agent-initiated one-shot self-wakeups (ScheduleWakeup tool)
// The two stay separate on purpose: different owners, different lifecycles.
//
// Design: DB-backed (pipeline_tasks + task_runs), single 30s poll loop (simpler and
// more robust than per-card timers given daily schedules and clock changes), timers
// effectively re-armed at boot since next_run_at lives in the DB. claude-process is
// imported lazily at fire time (same pattern as wakeup-scheduler) to avoid circular
// imports; run completion/cost is captured via the onTurnComplete subscription
// claude-process exposes.
//
// TWO IDENTITY COLUMNS, NEVER ONE (read this before touching anything below):
//   target_instance_id is CONFIG: the chat to fire AT, null meaning a fresh chat per run.
//   instance_id        is RUNTIME: the chat that is working, or last worked, this card.
//   On the old routines table a single instance_id meant the first. On a task it has
//   always meant the second. Same name, opposite direction. Collapse them and a
//   scheduled card silently re-points itself at whatever chat last ran it, then fires
//   into a stranger's session at 3am. Nothing in this file reads instance_id.
//
// THE ONE RULE (read this too):
//   Advancing the schedule and firing the card are the same event. A slot is consumed
//   only when a run row is written for it, or when a skip is recorded for it, or when
//   the user edits the schedule. It is NEVER advanced because the instance happened to
//   be busy, and NEVER advanced at boot merely because it is in the past. Both of those
//   used to happen, and both silently destroyed date-pinned reminders while every log
//   line looked healthy.
// ─────────────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000

// The old fixed 24-hour catch-up ceiling lived here. It is gone: freshness is decided by
// the card's OWN cadence now (see catchUpDecision), because 24 hours means "seven slots
// ago" to a 3-hourly card and "not yet due again" to a weekly one. The per-card
// catchup_policy column replaces it.

/**
 * A spawn that fails (missing cwd, missing binary) leaves the instance row at
 * process_state 'spawning' with no pid and nothing tracked, forever. A real spawn
 * passes through that exact state for milliseconds. Seeing it there across two
 * polls means it is a ghost, not a chat, and a reminder must not wait on a ghost.
 */
const STRANDED_SPAWN_MS = 60_000

/**
 * How long a due recurring card keeps retrying a busy instance before it gives up on that
 * slot (one visible 'skipped' row, then the next occurrence). A 'once' card never gives up:
 * it stays "waiting for chat" until it can fire. Env-overridable so the expiry path can be
 * exercised without waiting an hour.
 */
const QUEUE_WAIT_OVERRIDE = Number(process.env.ORCSTRATOR_ROUTINE_QUEUE_WAIT_MS)
export const MAX_QUEUE_WAIT_MS = Number.isFinite(QUEUE_WAIT_OVERRIDE) && QUEUE_WAIT_OVERRIDE > 0
  ? QUEUE_WAIT_OVERRIDE
  : 60 * 60 * 1000

// Mirrors task-runner's MAX_INSTANCE_NAME_CHARS (not exported there) so a replacement chat
// spawned for an orphaned card gets the same width budget a task-started one does. It
// spends part of that budget on the fire time (see spawnFireInstance).
const MAX_INSTANCE_NAME_CHARS = 40

/** The columns the scheduler reads off a card. Deliberately NOT the whole task row. */
export interface ScheduledTaskRow {
  id: string
  title: string
  /** CONFIG. null = aimed at the project: every fire opens its own fresh chat there. */
  target_instance_id: string | null
  project_id: string | null
  description: string
  schedule_kind: string
  schedule_value: string
  /** Date.getDay() numbers 'D,D,D'. null = every day. */
  schedule_days: string | null
  /** 'HH:MM-HH:MM' on 'every' only. null = the whole day. end <= start = overnight. */
  schedule_window: string | null
  /** IANA zone. null = computer time, read fresh at every computation. */
  schedule_tz: string | null
  /** 'YYYY-MM-DD', inclusive, in the card's zone. */
  schedule_until: string | null
  schedule_max_runs: number | null
  run_count: number
  catchup_policy: string
  consecutive_failures: number
  disarm_after_failures: number
  max_run_minutes: number | null
  budget_cap_usd: number | null
  auto_compact: number
  auto_close: number
  resume_session_id: string | null
  /** null | 'finished' | 'failed' | 'over_budget' */
  schedule_state: string | null
  schedule_enabled: number
  /** 1 = silent: fires never surface (no tile, no glow, no bright status). */
  silent: number
  /** 1 = the description IS the message: no template, no heading, no comments block. */
  raw_prompt: number
  last_run_at: number | null
  next_run_at: number | null
  queued_since: number | null
  column: string
  model: string | null
  effort: string | null
  permission_mode: string | null
  max_budget_usd: number | null
  fallback_model: string | null
  output_style: string | null
  language: string | null
}

export interface TaskRunRow {
  id: string
  task_id: string
  instance_id: string | null
  started_at: number
  finished_at: number | null
  status: string
  error: string | null
  cost_usd: number
  input_tokens: number
  output_tokens: number
}

export function rowToRun(r: TaskRunRow): TaskRun {
  return {
    id: r.id,
    taskId: r.task_id,
    instanceId: r.instance_id ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status as TaskRun['status'],
    error: r.error,
    costUsd: r.cost_usd ?? 0,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
  }
}

// ── Schedule parsing / next-run computation ─────────────────────────────────
//
// ALL OF IT LIVES IN shared/src/schedule-next.ts, and that is the point.
//
// The modal's "next 5 runs" preview calls the same exported function this scheduler
// calls, with the same inputs. A preview computed by a second implementation is a list
// of times that never happen, and nobody finds out until the routine has been quietly
// firing at the wrong hour for a week.
//
// Supported kinds (migration048 converted the old interval/daily/weekly rows):
//   'every'  value = minutes. Anchored on the ACTIVE WINDOW OPEN, never on now + N.
//   'times'  value = a comma-separated list of 'HH:MM'.
//   'once'   value = 'YYYY-MM-DDTHH:MM', fires exactly once, late if it has to.
// Days, active window (overnight allowed) and timezone apply on top; see ScheduleSpec.

/** The schedule fields off a card, in the shape the shared engine reads. */
export function specOf(task: {
  schedule_kind: string; schedule_value: string
  schedule_days?: string | null; schedule_window?: string | null
  schedule_tz?: string | null; schedule_until?: string | null
}): ScheduleSpec {
  return {
    kind: task.schedule_kind,
    value: task.schedule_value,
    days: task.schedule_days ?? null,
    window: task.schedule_window ?? null,
    tz: task.schedule_tz ?? null,
    until: task.schedule_until ?? null,
  }
}

/**
 * Everything wrong with a schedule as one sentence, or null. The route turns it into a
 * 400 and the modal shows the same text, so a schedule can never be rejected for a
 * reason the form did not show.
 */
export function validateSchedule(spec: ScheduleSpec): string | null {
  return validateScheduleSpec(spec)
}

/**
 * When the schedule next wants to fire, measured from `now`. null for an invalid
 * schedule, and null once the end date has gone by.
 *
 * 'once' returns its fixed instant AS-IS, even when that instant is already in the
 * past. That is deliberate and load-bearing: a past one-off is due immediately, so
 * it fires on the next poll instead of being postponed or lost.
 */
export function computeNextRunAt(spec: ScheduleSpec, now = Date.now()): number | null {
  return computeNextRun(spec, now)
}

// ── Engine state ────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null
let unsubscribeTurnComplete: (() => void) | null = null
// One in-flight scheduled run per instance. A second due card on the same instance
// waits (see queueOrExpire) rather than double-firing.
const activeRunByInstance = new Map<string, { runId: string; taskId: string }>()
// First time we saw an instance sitting at 'spawning' with no pid and no tracked process.
const spawningSeenAt = new Map<string, number>()

const SCHEDULED_COLUMNS = `
  id, title, target_instance_id, project_id, description,
  schedule_kind, schedule_value, schedule_enabled, silent, raw_prompt,
  schedule_days, schedule_window, schedule_tz, schedule_until, schedule_max_runs,
  run_count, catchup_policy, consecutive_failures, disarm_after_failures,
  max_run_minutes, budget_cap_usd, auto_compact, auto_close, resume_session_id,
  schedule_state,
  last_run_at, next_run_at, queued_since, "column" AS "column",
  model, effort, permission_mode, max_budget_usd, fallback_model, output_style, language
`

export function getScheduledTask(taskId: string): ScheduledTaskRow | undefined {
  return db.prepare(
    `SELECT ${SCHEDULED_COLUMNS} FROM pipeline_tasks WHERE id = ? AND schedule_kind IS NOT NULL`
  ).get(taskId) as ScheduledTaskRow | undefined
}

/**
 * The card changed: the board is the only place it lives, so the board hears about it.
 *
 * Rides the EXISTING `pipeline:updated` event rather than a new `task:updated` one. The
 * board, the all-projects view and the sidebar badges are already wired to that event and
 * refetch on it; a new event name would mean a card whose schedule advanced sat stale on
 * screen until something else happened to refresh it.
 */
function broadcastTaskUpdated(taskId: string): void {
  const task = taskManager.getTask(taskId)
  if (!task) return
  broadcastEvent({
    type: 'pipeline:updated',
    payload: { projectId: task.projectId, taskId, action: 'updated', newColumn: task.column },
  })
}

/**
 * Recompute + persist next_run_at from `now`, and clear any pending wait.
 *
 * This is the ONLY place the schedule advances, and it has exactly four legitimate
 * callers: a fire that just consumed its slot, a skip that was just recorded for the
 * slot, the PUT route after the user edited the schedule, and a manual run on an
 * interval card holding the next slot a full cadence out. Do not add a fifth.
 * In particular it must never run because an instance was busy, and never at boot
 * for a slot that is merely in the past.
 *
 * The skip caller passes `now`, except when the skipped slot was stale and a fresher missed
 * slot behind it is to be run late: then it passes the instant just before that slot, which
 * arms exactly that slot rather than jumping it (see catchUpDecision).
 */
export function rescheduleTask(taskId: string, now = Date.now(), exactly?: number): number | null {
  const row = getScheduledTask(taskId)
  if (!row) return null
  // `exactly` arms an instant the engine's grid would not have picked, and has exactly ONE
  // caller: the interval re-anchor in advanceSchedule, which needs "a full cadence from when
  // the user pressed Start" rather than the next point on a grid anchored hours earlier. The
  // caller proves the instant is legal (inside the window, on an allowed day, before the end
  // date) BEFORE passing it; everything downstream, including the zombie guard, is unchanged.
  const next = row.schedule_enabled ? (exactly ?? computeNextRunAt(specOf(row), now)) : null

  // A REPEATING CARD THAT IS STILL ARMED AND HAS NO NEXT RUN IS A ZOMBIE.
  //
  // It sits enabled forever with next_run_at NULL, so tick() (which selects on
  // next_run_at IS NOT NULL) never looks at it and the boot re-arm recomputes null again.
  // Nothing on the board explains it and no log line is written. The way in is an end date
  // that has gone by, which is exactly what schedule_until is for.
  //
  // So finishing is recorded rather than implied: switched off, state 'finished', and the
  // card settles into Done like any other completed work. A 'once' card is excluded because
  // it has its own disarm path and its slot is legitimately in the past until it fires.
  if (next == null && row.schedule_enabled && row.schedule_kind !== 'once') {
    db.prepare(
      "UPDATE pipeline_tasks SET next_run_at = NULL, queued_since = NULL, schedule_enabled = 0, schedule_state = 'finished', updated_at = ? WHERE id = ?"
    ).run(Date.now(), taskId)
    console.log(`[task-schedule] "${row.title}" has no run left (${describeSchedule(specOf(row))}); switched off and marked finished`)
    settleScheduledColumn(taskId)
    broadcastTaskUpdated(taskId)
    return null
  }

  db.prepare('UPDATE pipeline_tasks SET next_run_at = ?, queued_since = NULL, updated_at = ? WHERE id = ?')
    .run(next, Date.now(), taskId)
  return next
}

/**
 * A slot was consumed by a real fire, so the run counter moves and the end condition is
 * checked. Called by the fire path only: a skip is not a run, and neither is a manual
 * "run now" that did not consume the slot.
 *
 * The end condition is checked HERE rather than inside computeNextRun, because "I have run
 * five times" is a fact about history and the next-run function is a pure function of the
 * schedule. schedule_until is the other half and lives in the engine, since it can be
 * decided from the schedule alone.
 *
 * Returns true when the card has finished and must not be re-armed.
 */
function countRunAndCheckEnd(task: ScheduledTaskRow): boolean {
  const runCount = (task.run_count ?? 0) + 1
  db.prepare('UPDATE pipeline_tasks SET run_count = ? WHERE id = ?').run(runCount, task.id)
  const max = task.schedule_max_runs
  if (max == null || runCount < max) return false
  db.prepare(
    "UPDATE pipeline_tasks SET schedule_enabled = 0, next_run_at = NULL, queued_since = NULL, schedule_state = 'finished', updated_at = ? WHERE id = ?"
  ).run(Date.now(), task.id)
  console.log(`[task-schedule] "${task.title}" has run ${runCount} time(s), which is its limit; switched off and marked finished`)
  return true
}

/**
 * The card has just run. Spend the slot that run used, and arm the next one.
 *
 * A RUN IS A RUN, WHOEVER STARTED IT. This is the single place that decides it, for all
 * three ways a card can go: the scheduler's own fire, "Run now", and Start on the board.
 *
 * If only the first two reached this accounting, a daily card started by hand on the board
 * would run TWICE: the board's Start path would tell the scheduler nothing, and the day's
 * armed slot would still fire. The rule is that a card the user has already run does not
 * run itself again.
 *
 * What each kind does with the slot it just spent:
 *
 *  - 'every' RE-ANCHORS ON THE RUN: the next run is exactly one cadence from now. "Every 6
 *    hours" is a promise about how OFTEN, so a hand start at 12:10 means 18:10, full stop.
 *    This used to round UP to the next point on the standing grid, which is anchored on the
 *    window open (midnight by default) and so turned a 6-hour wait into a 12-hour one: the
 *    grid read 00:00 / 06:00 / 12:00 / 18:00, 18:10 missed the 18:00 point, and the card
 *    went to midnight. Preserving the grid is not worth losing a run over, and the window
 *    should start when the USER started it. The exact instant is only armed when the card
 *    is genuinely allowed to run then; outside its window or past its end date it falls back
 *    to the grid, so "11:00 to 19:00, every 5 hours" run at 14:55 still has no slot today.
 *  - 'times' SKIPS the armed occurrence. A daily 11:25 card started at 09:00 goes tomorrow.
 *    This is why the re-arm has to start FROM that occurrence rather than from now:
 *    computeNextRunAt is strict, so rescheduling from 09:00 hands back the same 11:25 and
 *    the card runs again two hours later. That was the bug.
 *  - 'once' is DONE. There is no later occurrence to skip, so it is switched off.
 *
 * A manual run counts against schedule_max_runs, because it is one of the runs the card was
 * asked for. The interval re-anchor is the sole exception, and deliberately so: it moves the
 * grid rather than spending a slot, so it must not move the counter or a card would finish
 * on runs that were never its own.
 */
function advanceSchedule(task: ScheduledTaskRow, now: number, opts: { manual: boolean; ranAs: string }): void {
  const spec = specOf(task)
  const isInterval = task.schedule_kind === 'every'
  const armed = task.next_run_at
  const cadenceMs = isInterval ? Number(task.schedule_value) * 60_000 : 0
  const reAnchors = opts.manual && isInterval && task.schedule_enabled === 1 && Number.isFinite(cadenceMs) && cadenceMs > 0
  // A manual run that happened BEFORE the armed occurrence is the run that occurrence was
  // for, so the re-arm has to step past it rather than recompute it.
  const skipsArmed = opts.manual && !isInterval && armed != null && armed > now
  // Every run spends its slot, except a re-anchored interval run whose slot was still in the
  // future: that one keeps run_count and the end condition untouched and only moves the
  // next run, so a hand start cannot finish a card on a run it never scheduled.
  const consumesSlot = !reAnchors || (armed != null && armed <= now)

  // Where the next run is measured from, and whether it is pinned to an exact instant.
  // The interval re-anchor pins; everything else asks the engine for its next grid point.
  let rearmFrom = skipsArmed ? armed : now
  let pinned: number | undefined
  if (reAnchors) {
    const target = now + cadenceMs
    rearmFrom = target - 1
    // Only pin an instant the card is actually allowed to run at. A window or an end date
    // that rules `target` out sends it back to the grid, which is the correct answer there.
    pinned = isInsideActiveWindow(spec, target) && computeNextRunAt(spec, rearmFrom) != null ? target : undefined
  }

  if (consumesSlot) {
    if (task.schedule_kind === 'once') {
      // A one-off has done its job: switch it off in the scheduler, not in the prompt.
      // No state: it is finished, not in trouble, and the Fired pill already says so.
      disarmTask(task.id, `one-off ${opts.manual ? 'started by hand' : 'fired'} (${opts.ranAs})`, null)
      return
    }
    // Not finished, so arm the next slot. countRunAndCheckEnd already switched the card
    // off and wrote schedule_state when the run limit was reached, and rescheduleTask
    // does the same for an end date that has gone by, so the two ends meet in one place:
    // whatever happens, a card that cannot run again is off, stated, and in Done.
    if (countRunAndCheckEnd(task)) return
    const next = rescheduleTask(task.id, rearmFrom, pinned)
    if (opts.manual && next != null) {
      console.log(
        `[task-schedule] "${task.title}" was run by hand, so its ${armed != null ? formatInstant(armed) : 'pending'} ` +
        `slot is spent; next run ${formatInstant(next)} (${describeSchedule(spec)})`
      )
    }
    return
  }

  const next = rescheduleTask(task.id, rearmFrom, pinned)
  if (next != null) {
    const why = pinned != null
      ? `a full ${describeEvery(Number(task.schedule_value)).replace(/^every /, '')} from the run`
      : 'the first slot its window allows'
    console.log(`[task-schedule] "${task.title}" was run by hand; next run ${formatInstant(next)}, ${why}`)
  }
}

/**
 * Switch a card off for a reason that is not "it finished".
 *
 * `state` defaults to 'failed' rather than null, because a card switched off with no state
 * is a card that just goes quiet: no pill explaining it, no red dot, nothing to find. That
 * is what happened to a card whose project folder had been deleted, which is precisely the
 * case somebody needs telling about. The one-off path passes null on purpose: a fired
 * one-off is not in trouble, it is done, and describeFiredOnce already draws it.
 *
 * THE FAILURE COUNTER IS ZEROED ALONG WITH IT, and that is not tidying up. Nothing that
 * reaches this function is a run failure: the real three-strikes disarm has its own UPDATE
 * inside recordRunOutcome. Every caller here is a card that could not be run at all, because
 * its chat is gone or its schedule no longer parses. But the pill reads the counter to
 * decide what to say, so a card carrying one old failure from a bad night last week, then
 * switched off because somebody deleted its chat, was drawn as "Failed 1 time, switched off"
 * with hover text telling the user it had failed once in a row against a ceiling of three.
 * That is self-contradictory, and it sends them hunting a prompt bug instead of the missing
 * chat. Zeroing the counter is what makes the "Stopped" pill reachable for the case it was
 * written for.
 */
function disarmTask(taskId: string, reason: string, state: 'failed' | null = 'failed'): void {
  db.prepare(
    'UPDATE pipeline_tasks SET schedule_enabled = 0, next_run_at = NULL, queued_since = NULL, schedule_state = ?, consecutive_failures = 0, updated_at = ? WHERE id = ?'
  ).run(state, Date.now(), taskId)
  console.log(`[task-schedule] Disarmed card ${taskId.slice(0, 8)}: ${reason}`)
  broadcastTaskUpdated(taskId)
}

/** Seven days, the window the cap is measured over. Rolling, not calendar: see budgetDecision. */
const BUDGET_WINDOW_MS = 7 * 24 * 60 * 60_000

/**
 * Two dollar amounts, shown with just enough precision to be different.
 *
 * Money is two decimal places, and for a real cap ($5, $20) that is the end of it. But the
 * skip message puts the spend and the cap side by side, and at two places a card that had
 * spent $0.0135 against a $0.01 cap read "over budget: $0.01 of $0.01", which says the card
 * is exactly ON its limit while claiming it is over. A sentence that contradicts itself is
 * worse than an ugly one, so the precision grows until the two numbers differ, up to four
 * places. Equal amounts are left alone: a card that really did land on its cap should say so.
 */
/** One amount, at the precision it needs to not read as zero. */
function fmtUsdFixed(n: number): string {
  for (let dp = 2; dp <= 4; dp++) {
    if (Number(n.toFixed(dp)) !== 0 || n === 0) return `$${n.toFixed(dp)}`
  }
  return `$${n.toFixed(4)}`
}

function fmtUsdPair(spent: number, cap: number): { spent: string; cap: string } | null {
  for (let dp = 2; dp <= 4; dp++) {
    const a = spent.toFixed(dp)
    const b = cap.toFixed(dp)
    if (a !== b || spent === cap) return { spent: `$${a}`, cap: `$${b}` }
  }
  // Still indistinguishable at four places, and not equal. Rather than print two numbers
  // that read as the same number, the caller says it with one. Growing the precision
  // further would be worse: "over budget: $5.00000001 of $5.00000000" is arithmetic, not a
  // sentence, and the difference it is straining to show does not matter to anybody.
  return null
}

/**
 * Has this card spent its weekly allowance? Returns the reason to skip, or null to go ahead.
 *
 * The window is ROLLING, not the calendar week, and that is the useful shape: a cap exists to
 * stop a card quietly costing more than the user meant, and a calendar week hands a runaway
 * card a full fresh allowance at midnight on Sunday no matter what it did on Saturday. Rolling
 * means the card resumes gradually as its own old spend ages out, which is also why this state
 * needs no human to clear it.
 *
 * MANUAL RUNS COUNT TOWARD IT BUT ARE NOT STOPPED BY IT, and the asymmetry is deliberate.
 *
 * They count because this is about money: a dollar spent by pressing Run now is spent exactly
 * the same as one spent at 3am, and a cap that ignored half the spending would not be a cap.
 * That is why the sum below has no `kind` filter, unlike the failure ledger, which is about
 * whether the SCHEDULE works and so excludes them.
 *
 * They are not stopped because this gate lives in tick(), and runTaskNow goes straight to
 * fireTask. That is the behaviour I want, not an oversight. Run now is the user sitting there
 * and pressing a button, and the moment they most need it is exactly when a card has just
 * gone over budget and they are trying to work out why and make it cheaper. Blocking it would
 * leave them with a card they cannot even test until the week rolls forward. The cap exists
 * to stop UNATTENDED spend; an attended dollar is a decision, not an accident.
 *
 * The cost of the fork: somebody could hold a card over its cap by hand indefinitely. They
 * would be doing it one deliberate click at a time, watching the pill go red as they did.
 *
 * Runs still in flight count at whatever they have recorded so far, which is usually zero: a
 * run's cost lands when it finishes. That is the right way round. Refusing to start a slot
 * because a run that has cost nothing yet MIGHT go over would block on a guess.
 */
function budgetDecision(task: ScheduledTaskRow, now: number): { reason: string; spent: number } | null {
  const cap = task.budget_cap_usd
  if (cap == null || !(cap > 0)) return null
  const row = db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM task_runs WHERE task_id = ? AND started_at >= ?'
  ).get(task.id, now - BUDGET_WINDOW_MS) as { spent: number }
  const spent = row?.spent ?? 0
  // A HAIR OVER IS NOT OVER. `spent` is a SUM of floats, so a card that has spent exactly
  // its cap in decimal terms arrives here holding something like 0.30000000000000004
  // against a cap of 0.3. Blocking on that is blocking on binary floating point, and the
  // message it produced said "$0.3000 of $0.3000", which is a sentence that argues with
  // itself. A hundredth of a cent of slack is far below anything that could matter and far
  // above the dust any realistic sum accumulates.
  const DUST = 0.0001
  if (spent < cap + DUST) return null
  const shown = fmtUsdPair(spent, cap)
  const amounts = shown
    ? `${shown.spent} of ${shown.cap}`
    // Different numbers that render the same. Saying it once is honest; saying it twice is not.
    : `its ${fmtUsdFixed(cap)} limit`
  return {
    spent,
    reason: `over budget: ${amounts} in the last 7 days, so this run was skipped. It will start running again as that spend ages out.`,
  }
}

/**
 * Write schedule_state without touching anything else.
 *
 * Separate from disarmTask on purpose: 'over_budget' is the one state that leaves the card
 * ARMED, and reusing the disarm path for it would switch off a card the user never has to
 * think about again. Writing NULL is how the state clears once the card fires cleanly.
 */
function setScheduleState(taskId: string, state: 'over_budget' | null): void {
  const current = db.prepare('SELECT schedule_state FROM pipeline_tasks WHERE id = ?').get(taskId) as { schedule_state: string | null } | undefined
  if (!current || current.schedule_state === state) return
  db.prepare('UPDATE pipeline_tasks SET schedule_state = ?, updated_at = ? WHERE id = ?').run(state, Date.now(), taskId)
}

function recordSkippedRun(task: ScheduledTaskRow, error: string): void {
  const runId = crypto.randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO task_runs (id, task_id, instance_id, started_at, finished_at, status, error, kind)
    VALUES (?, ?, ?, ?, ?, 'skipped', ?, 'scheduled')
  `).run(runId, task.id, task.target_instance_id, now, now, error)
  const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as TaskRunRow
  broadcastEvent({ type: 'task:run-finished', payload: rowToRun(run) })
}

/**
 * A scheduled fire refused because the card has nothing to send.
 *
 * A FAILED RUN, NOT A SKIP, and that is the whole difference. A skip is the schedule doing
 * its job (busy chat, over budget, missed slot) and touches nothing. A card with no prompt is
 * broken and stays broken every slot until somebody writes one, so it goes through the
 * failure ledger like any other broken run: counted, switched off at its ceiling, painted red.
 * Recorded as a skip it would sit there armed and quiet for ever.
 *
 * The slot is consumed, because a run row was written for it (THE ONE RULE). Left in place,
 * the next poll would refuse the same slot thirty seconds later, and a card set never to
 * disarm would write a failed run twice a minute. A one-off has no next slot to move to, so
 * it is switched off as failed instead, with its count kept so the pill says why. Ticking
 * Armed once the prompt is written fires it straight away, since its instant is in the past.
 */
function recordNoPromptFailure(task: ScheduledTaskRow, now: number): void {
  const runId = crypto.randomUUID()
  db.prepare(`
    INSERT INTO task_runs (id, task_id, instance_id, started_at, finished_at, status, error, kind)
    VALUES (?, ?, ?, ?, ?, 'error', ?, 'scheduled')
  `).run(runId, task.id, task.target_instance_id, now, now, NO_PROMPT_MESSAGE)
  const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as TaskRunRow
  broadcastEvent({ type: 'task:run-finished', payload: rowToRun(run) })
  console.warn(`[task-schedule] "${task.title}" is due but has no prompt; recorded as a failed run and nothing was started`)
  recordRunOutcome(task.id, 'error', 'scheduled')

  // The ledger may have just switched it off at its ceiling, in which case it is done here.
  const after = getScheduledTask(task.id)
  if (!after?.schedule_enabled) return
  if (after.schedule_kind === 'once') {
    db.prepare(
      "UPDATE pipeline_tasks SET schedule_enabled = 0, next_run_at = NULL, queued_since = NULL, schedule_state = 'failed', updated_at = ? WHERE id = ?"
    ).run(Date.now(), task.id)
  } else {
    rescheduleTask(task.id, now)
  }
  broadcastTaskUpdated(task.id)
}

function fmtLate(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 120) return `${mins} min`
  const hours = Math.round(ms / 3_600_000)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`
}

/**
 * The instance is busy and this is a scheduled (not manual) fire. Keep the slot:
 * leave next_run_at where it is so the next poll retries, and stamp queued_since
 * the first time so the wait is bounded and visible. A recurring card that has
 * waited longer than MAX_QUEUE_WAIT_MS gives the slot up loudly (one 'skipped' row,
 * then its next occurrence). A 'once' card keeps waiting for as long as it takes.
 */
function queueOrExpire(task: ScheduledTaskRow, instanceId: string, now: number): { ok: false; reason: string } {
  const short = instanceId.slice(0, 8)
  if (task.queued_since == null) {
    db.prepare('UPDATE pipeline_tasks SET queued_since = ? WHERE id = ?').run(now, task.id)
    console.log(`[task-schedule] "${task.title}" is due but instance ${short} is busy; keeping the slot and waiting`)
    broadcastTaskUpdated(task.id)
    return { ok: false, reason: 'instance-busy' }
  }
  const waited = now - task.queued_since
  if (task.schedule_kind !== 'once' && waited > MAX_QUEUE_WAIT_MS) {
    recordSkippedRun(task, `instance stayed busy for ${fmtLate(waited)}, this run was skipped`)
    rescheduleTask(task.id, now)
    broadcastTaskUpdated(task.id)
    console.warn(`[task-schedule] "${task.title}" waited ${fmtLate(waited)} on busy instance ${short}; skipped, next slot armed`)
  }
  return { ok: false, reason: 'instance-busy' }
}

/** The columns the fire path reads from an instance row. */
interface FireTarget {
  id: string
  cwd: string
  session_id: string | null
  process_state: string
  process_pid: number | null
}

function getFireTarget(instanceId: string): FireTarget | undefined {
  return db.prepare('SELECT id, cwd, session_id, process_state, process_pid FROM instances WHERE id = ?')
    .get(instanceId) as FireTarget | undefined
}

/**
 * A run of this card still in flight, on whatever instance it landed on. Read from the
 * per-instance map (its values already carry the task id), so finalizeRun clears it
 * with nothing extra to leak. Needed because a fresh instance per fallback fire means the
 * per-instance map alone can never block a second fire of the SAME card: a short
 * interval on a dead target would otherwise spawn a new instance every poll and run
 * concurrently with itself.
 */
function inFlightRun(taskId: string): { instanceId: string; runId: string } | undefined {
  for (const [instanceId, active] of activeRunByInstance) {
    if (active.taskId === taskId) return { instanceId, runId: active.runId }
  }
  return undefined
}

/**
 * Spawn a fresh, disposable instance in the card's own project and let the fire continue
 * against it. Same INSERT shape and the same instance:created broadcast as
 * task-runner.startTask, so the new tab shows up in the sidebar and the grid exactly like a
 * task-started one does.
 *
 * Two ways in, one behaviour: the card never had a target chat (target_instance_id is null,
 * because the user aimed it at the project instead), or it had one and that chat has since
 * been closed. Both mean there is no chat to fire on, so both open one here.
 *
 * Deliberately NOT written back to target_instance_id: the card stays owned by its project
 * and every later fire gets its own fresh instance too. Rebinding it would tie the card to a
 * tab nobody asked for, and closing that tab would orphan it all over again. This is also
 * exactly the write that would collapse the two identity columns into one, so it is doubly
 * not done.
 *
 * Fails, with the reason for the run history and the reason for the log, when there is
 * nowhere to open a chat: project_id is null, the folder row has been removed, or the
 * folder's directory is no longer on disk. The caller keeps the disarm-on-fire behaviour in
 * every one of those cases.
 *
 * Synchronous on purpose, including the disk check: tick() does not await fireTask, so
 * an await anywhere before the slot is consumed would let the next poll re-select this
 * card and fire it twice.
 */
type ReplacementResult =
  | { ok: true; instance: FireTarget }
  | { ok: false; skipReason: string; logReason: string }

function spawnFireInstance(task: ScheduledTaskRow): ReplacementResult {
  // Why there is no chat to fire on, said once and reused in every message below. An
  // orphaned card lost its chat; a project-targeted one never had one and is not broken.
  const orphaned = task.target_instance_id != null
  const why = orphaned ? 'its chat was closed and' : 'this card has no chat of its own and'
  const logWhy = orphaned
    ? `target instance ${task.target_instance_id!.slice(0, 8)} no longer exists`
    : 'card has no target_instance_id'
  // Skip reasons are read on the card, so they say chat and folder rather than instance
  // and row. The log reasons below stay technical: that reader has the ids to hand.
  const noFolder = `${why} the card has no folder to open one in, schedule switched off`
  if (!task.project_id) {
    return { ok: false, skipReason: noFolder, logReason: `${logWhy} and the card has no project_id` }
  }
  const folder = db.prepare('SELECT id, path, name FROM folders WHERE id = ?').get(task.project_id) as
    | { id: string; path: string; name: string | null } | undefined
  if (!folder) {
    return { ok: false, skipReason: noFolder, logReason: `${logWhy} and folder ${task.project_id.slice(0, 8)} is gone` }
  }
  if (!fs.existsSync(folder.path)) {
    return {
      ok: false,
      skipReason: `${why} there is no folder on disk to open a new chat in, schedule switched off`,
      logReason: `${logWhy} and folder path ${folder.path} is missing on disk`,
    }
  }

  // Name the fresh chat after the card AND the moment it fired. The card name alone
  // stacked identically named chats in the sidebar, one per day for a daily card, with
  // nothing to tell yesterday's from today's. The time suffix is never truncated (it is the
  // part that distinguishes them); the card name gives up characters to make room.
  const instanceId = crypto.randomUUID()
  const suffix = ` · ${formatInstant(Date.now())}`
  const room = MAX_INSTANCE_NAME_CHARS - suffix.length
  const base = task.title.length > room
    ? task.title.slice(0, Math.max(1, room - 1)) + '…'
    : task.title
  const name = base + suffix
  // THE THREAD SURVIVES THE CHAT (D19).
  //
  // A card with auto_close on closes its chat after every run, so without this each night's
  // run would start from nothing and a routine whose whole value is "carry on from
  // yesterday" would have no yesterday. resume_session_id is the session the last run left
  // behind; stamping it here means the CLI resumes that conversation in the new chat, and
  // "what was the last thing I asked you?" gets a real answer. NULL for every other card,
  // which is a plain fresh chat exactly as before.
  //
  // ONLY WHILE THE CARD STILL CLOSES ITS CHATS. The close is the only thing that ever WRITES
  // this column, so a card that had the box ticked and then had it unticked keeps the last
  // id it wrote, for ever, and would stamp that one session onto every fresh chat from then
  // on. Those chats now stay open, so two, then three, then thirty live rows end up holding
  // the same session_id, and several lookups take the first row they find for a session
  // (opening a session, attributing its cost, rendering its task panel). Reading the column
  // only when auto_close is on makes it mean what it is for: the thread a closing card is
  // carrying between its own chats.
  const resumeSession = task.auto_close ? (task.resume_session_id ?? null) : null
  // surface_silent is stamped here, at birth, from the card's own flag: it is the one
  // fact the surface path reads at fire time, and a wake-up scheduled from inside this
  // chat inherits it for free (see surface.ts).
  db.prepare(`
    INSERT INTO instances (id, folder_id, name, cwd, session_id, state, agent_id, idle_restart_minutes, sort_order, created_at, surface_silent)
    VALUES (?, ?, ?, ?, ?, 'idle', NULL, 0, 9999, ?, ?)
  `).run(instanceId, folder.id, name, folder.path, resumeSession, Date.now(), task.silent ? 1 : 0)
  if (resumeSession) {
    console.log(`[task-schedule] "${task.title}": resuming session ${resumeSession.slice(0, 8)} from its last run in the new chat`)
  }
  const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId) as Record<string, unknown>
  broadcastEvent({
    type: 'instance:created',
    payload: {
      id: row.id, folderId: row.folder_id, name: row.name, cwd: row.cwd,
      sessionId: (row.session_id as string | null) ?? undefined, state: 'idle', agentId: undefined,
      idleRestartMinutes: 0, sortOrder: row.sort_order, createdAt: row.created_at,
    },
  })
  console.log(
    `[task-schedule] "${task.title}": ${orphaned ? `target instance ${task.target_instance_id!.slice(0, 8)} is gone` : 'is aimed at its project'}, ` +
    `spawned fresh instance ${instanceId.slice(0, 8)} in folder ${folder.name || folder.path}`
  )
  // Re-select so the shape is exactly what the fire path reads (process_state included).
  // The row was inserted a moment ago on this same connection, so it is there.
  return { ok: true, instance: getFireTarget(instanceId)! }
}

/**
 * Fire a scheduled card: persist the prompt as a user message (so the chat history is
 * coherent), create a task_runs row, move the card to In Progress, and spawn the turn via
 * sendMessage, mirroring how wakeup-scheduler.fire and the auto-retry path do it.
 */
async function fireTask(task: ScheduledTaskRow, opts: { manual?: boolean } = {}): Promise<{ ok: boolean; reason?: string; runId?: string }> {
  const now = Date.now()

  // The exact text the CLI will receive. Built by the SAME builder the manual start uses,
  // so a card cannot mean one thing when clicked and another at 3am. Both bypasses apply
  // here: raw_prompt (every migrated routine carries it) and the slash-command
  // passthrough, which is why a parked /goal fires as /goal on a scheduled run too.
  const fullTask = taskManager.getTask(task.id)
  const prompt = fullTask ? buildKickoffPrompt(fullTask, sendsVerbatim(fullTask) ? [] : loadComments(task.id)) : (task.description ?? '')

  // AN EMPTY PROMPT NEVER REACHES THE CLI, and this is checked before everything else.
  //
  // A raw_prompt card whose description has been blanked would otherwise fire anyway: the CLI
  // answers "Ready. What do you need?" and the run costs money for nothing. Asked here, ahead
  // of the in-flight test, the spawn, the persisted message and the move to In Progress, so a
  // refusal leaves no tab, no message and no card sitting in a column it never earned.
  //
  // Run now refuses and writes nothing, exactly like a busy chat: the user is looking at the
  // screen and gets the sentence. A scheduled fire is recorded as a failure (see
  // recordNoPromptFailure), because nobody is watching and the card is genuinely broken.
  if (!hasPrompt(prompt)) {
    if (opts.manual) {
      console.log(`[task-schedule] Run-now for "${task.title}" refused: the card has no prompt`)
      return { ok: false, reason: 'no-prompt' }
    }
    recordNoPromptFailure(task, now)
    return { ok: false, reason: 'no-prompt' }
  }

  // A run of this card still in flight: wait for it exactly as a busy instance is
  // waited for (slot kept, never advanced). Decided BEFORE the instance lookup and before
  // any spawn, so the fallback can never create an instance and then find it has nothing
  // to do, which would strand an empty tab.
  const inFlight = inFlightRun(task.id)
  if (inFlight) {
    if (opts.manual) {
      console.log(`[task-schedule] Run-now for "${task.title}" refused: run ${inFlight.runId.slice(0, 8)} still in flight on instance ${inFlight.instanceId.slice(0, 8)}`)
      return { ok: false, reason: 'instance-busy' }
    }
    return queueOrExpire(task, inFlight.instanceId, now)
  }

  // Resolve the instance this fire runs on: the card's own TARGET, or, when it has none
  // or that one is gone, a fresh instance in the card's project. That path then continues
  // down this same code: nothing below knows the target was swapped, and the slot accounting
  // is exactly what it is for a normal fire.
  //
  // Note this reads target_instance_id and never instance_id. instance_id is where the last
  // run happened to land, which is emphatically not where the next one should be aimed.
  let instance = task.target_instance_id ? getFireTarget(task.target_instance_id) : undefined
  if (!instance) {
    const fallback = spawnFireInstance(task)
    if (!fallback.ok) {
      // Nothing to fall back to: disarm the card instead of erroring forever, and leave
      // a visible trace in the run history, not only a console line.
      recordSkippedRun(task, fallback.skipReason)
      disarmTask(task.id, fallback.logReason)
      return { ok: false, reason: 'instance-deleted' }
    }
    instance = fallback.instance
  }

  // The instance that actually runs this fire: target_instance_id on the normal path, the
  // freshly spawned id when the card is aimed at a project or its chat is gone. Every row,
  // map key and event below uses it, so task_runs.instance_id records the instance that ran
  // and finalizeRun (keyed by the id handed to it) still lines up.
  const targetInstanceId = instance.id

  // Stranded spawn detection (see STRANDED_SPAWN_MS). Repair the row before deciding.
  const looksStranded = instance.process_state === 'spawning' && instance.process_pid == null && !processRegistry.isTracked(instance.id)
  let strandedSpawn = false
  if (looksStranded) {
    const since = spawningSeenAt.get(instance.id) ?? now
    spawningSeenAt.set(instance.id, since)
    strandedSpawn = now - since >= STRANDED_SPAWN_MS
  } else {
    spawningSeenAt.delete(instance.id)
  }
  if (strandedSpawn) {
    resetStrandedSpawn(instance.id)
    spawningSeenAt.delete(instance.id)
    console.warn(`[task-schedule] Instance ${instance.id.slice(0, 8)} sat at 'spawning' with no process for over ${STRANDED_SPAWN_MS / 1000}s; reset to idle so "${task.title}" can fire`)
  }

  // Busy means: the row says so, we already have a run in flight there, or the process
  // registry is tracking a live child (the row can lag the registry by a few hundred ms
  // while a user turn starts up, and firing into that gap would kill the user's turn).
  const busy = !strandedSpawn && (
    instance.process_state !== 'idle' || activeRunByInstance.has(instance.id) || processRegistry.isTracked(instance.id)
  )
  if (busy) {
    if (opts.manual) {
      // A manual "run now" reports back to the caller and does NOT start a wait:
      // the user is looking at the screen and can press it again.
      console.log(`[task-schedule] Run-now for "${task.title}" refused: instance ${instance.id.slice(0, 8)} busy`)
      return { ok: false, reason: 'instance-busy' }
    }
    return queueOrExpire(task, instance.id, now)
  }

  // Create the run row first so a crash mid-fire still leaves a trace.
  const runId = crypto.randomUUID()
  db.prepare(`
    INSERT INTO task_runs (id, task_id, instance_id, started_at, status, kind)
    VALUES (?, ?, ?, ?, 'running', ?)
  `).run(runId, task.id, targetInstanceId, now, opts.manual ? 'manual' : 'scheduled')
  activeRunByInstance.set(targetInstanceId, { runId, taskId: task.id })

  const late = task.next_run_at != null && !opts.manual ? now - task.next_run_at : 0
  console.log(
    `[task-schedule] Firing "${task.title}" (${describeSchedule(specOf(task))}) on instance ${instance.id.slice(0, 8)} (run ${runId.slice(0, 8)})` +
    (late > POLL_INTERVAL_MS * 2 ? `, ${fmtLate(late)} late` : '')
  )

  // instance_id (RUNTIME) is stamped to the chat this run landed on, so the card's
  // "Open chat" button points at the run you can actually read. target_instance_id
  // (CONFIG) is untouched: it is where the NEXT fire is aimed, and a fallback spawn
  // must not become the card's permanent home.
  db.prepare('UPDATE pipeline_tasks SET last_run_at = ?, queued_since = NULL, instance_id = ?, updated_at = ? WHERE id = ?')
    .run(now, targetInstanceId, now, task.id)
  db.prepare('UPDATE instances SET active_task_id = ? WHERE id = ?').run(task.id, targetInstanceId)
  // Which slot this run just spent, and when the card is next allowed to go, is decided in
  // ONE place for every way a card can be run. See advanceSchedule.
  advanceSchedule(task, now, { manual: opts.manual === true, ranAs: `run ${runId.slice(0, 8)}` })
  // The card is working now, so it sits in In Progress like any other started card. Where
  // it lands when the turn ends is decided in task-runner's turn-complete handler: Backlog
  // for a repeating card, Done for a fired one-off.
  if (task.column !== 'in_progress') {
    try { taskManager.moveTask(task.id, 'in_progress', 'orcstrator') } catch (err) {
      console.error(`[task-schedule] could not move "${task.title}" to in_progress:`, err)
    }
  }
  broadcastTaskUpdated(task.id)

  const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as TaskRunRow
  broadcastEvent({ type: 'task:run-started', payload: rowToRun(run) })

  // Persist + broadcast the prompt as a user message so it appears in the chat
  // exactly like a typed one (same pattern as the auto-retry path).
  const msgId = crypto.randomUUID()
  const content = [{ type: 'text', text: prompt }]
  try {
    db.prepare('INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(msgId, targetInstanceId, 'user', JSON.stringify(content), now)
    broadcastEvent({
      type: 'message:added',
      payload: { instanceId: targetInstanceId, message: { id: msgId, instanceId: targetInstanceId, role: 'user', content, createdAt: now } },
    })
  } catch { /* non-critical */ }

  // A card firing on an EXISTING chat re-stamps that chat's silence to match itself, so
  // toggling Silent on the card takes effect on the very next fire. Done HERE, once the
  // fire is real (past the busy and queue checks), so a fire that only got queued never
  // stamps anything. A freshly spawned chat was stamped at birth; this write is idempotent.
  setSurfaceSilent(targetInstanceId, !!task.silent)
  // Output style and language are not argv: they ride the managed --settings file, which is
  // built from the instance row at spawn. Stamp them before the spawn or they miss this turn.
  applyTaskCliSettings(targetInstanceId, task)

  // SURFACE the chat: pull it into the grid and owe it one glow. That decision now lives
  // inside sendMessage, keyed on `origin: 'routine'` below, so every autonomous path makes
  // it in the same place (see turn-origins.ts). It still lands at the same point in the
  // sequence: past the busy and queue checks, past the run row and the persisted prompt,
  // and immediately before the spawn. It happens on BOTH paths, the card's own chat and
  // a freshly spawned one. Note the spawn path also emitted instance:created above; the
  // client must not key any grid behaviour on that event, because an existing-chat fire
  // never emits it. No-op when the chat is silent.

  // Lazy import to avoid circular dependency between claude-process and this scheduler.
  const { sendMessage } = await import('./claude-process.js')
  try {
    await sendMessage({
      instanceId: targetInstanceId,
      text: prompt,
      cwd: instance.cwd,
      sessionId: instance.session_id ?? undefined,
      // THE BUG THIS REFACTOR EXISTS FOR. This call used to pass no flags at all, so a
      // scheduled run reached the CLI with no --model, no --effort and no permission flag,
      // and a 3am fire that tripped a prompt sat blocked behind a banner nobody was awake
      // to click. Same builder as the manual start now, so the two cannot drift again.
      flags: buildTurnFlags(task),
      origin: 'routine',
      taskId: task.id,
    })
    return { ok: true, runId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[task-schedule] sendMessage failed for card ${task.id}:`, err)
    finalizeRun(runId, targetInstanceId, 'error', { error: message })
    // Nothing ran, so nothing is "waiting on you". Taking the surface back is sendMessage's
    // job now, and it does it with the exact timestamp it wrote: an unqualified ackSurface
    // here would clear whatever surface happened to be on the chat, including an older one
    // from a fire the user has not looked at yet, whenever sendMessage throws before it surfaces.
    // Our own failed spawn must not leave the instance stranded at 'spawning'.
    resetStrandedSpawn(targetInstanceId)
    // The turn never started, so no turn-complete will arrive to move the card off In
    // Progress. Put it back where it came from here.
    db.prepare('UPDATE instances SET active_task_id = NULL WHERE id = ?').run(targetInstanceId)
    settleScheduledColumn(task.id)
    return { ok: false, reason: message, runId }
  }
}

/**
 * Where a scheduled card lands once its run is over: Backlog for a repeating card, because
 * it is standing work that will happen again, and Done for a one-off, which has finished.
 *
 * Called from task-runner's turn-complete handler (the one owner of a card's column) and
 * from the failed-spawn path above, where no turn-complete will ever arrive.
 */
export function settleScheduledColumn(taskId: string): void {
  const row = getScheduledTask(taskId)
  if (!row) return
  // A card that has run out of runs is finished work, not standing work, so it lands in
  // Done beside the one-offs rather than back in Backlog claiming a next slot it has not got.
  const finished = row.schedule_kind === 'once' || row.schedule_state === 'finished'
  const target = finished ? 'done' : 'backlog'
  if (row.column === target) return
  try {
    taskManager.moveTask(taskId, target, 'orcstrator')
  } catch (err) {
    console.error(`[task-schedule] could not settle card ${taskId.slice(0, 8)} into ${target}:`, err)
  }
}

/** True when this card's column is the scheduler's to decide, not task-runner's. */
export function isScheduledCard(taskId: string): boolean {
  return getScheduledTask(taskId) !== undefined
}

/**
 * A scheduled card was started BY HAND from the board. Account for it exactly as a fire is.
 *
 * task-runner's startTask builds the same prompt and spawns the same turn as a fire, but it
 * knew nothing about slots, so a hand start was invisible here: no run row, no last_run_at,
 * and above all no slot spent, so a daily card started by hand ran a second time when its
 * slot came round. The schedule is the scheduler's business, so
 * the Start path reports the run and this function does the accounting; see advanceSchedule
 * for what each schedule kind does with the slot.
 *
 * The run row is written and keyed into activeRunByInstance like a fire's, so the
 * turn-complete handler closes it out with its real cost and the card's history shows the
 * run that actually happened. Its kind is 'manual', which recordRunOutcome ignores for the
 * failure counter: a person watching their own run fail is not a card that needs disarming.
 *
 * Safe to call for any card and any instance. A card with no schedule returns immediately,
 * and so does one that is switched off, because a disarmed card has no slot to spend and
 * counting the run would push it toward a limit it is no longer running against.
 */
export function noteManualStart(taskId: string, instanceId: string): void {
  const task = getScheduledTask(taskId)
  if (!task) return

  const now = Date.now()
  // A run already tracked on this chat is a fire mid-flight on it. Do not overwrite its
  // entry or that run would never be finalized; the slot accounting below still happens.
  if (!activeRunByInstance.has(instanceId)) {
    const runId = crypto.randomUUID()
    db.prepare(`
      INSERT INTO task_runs (id, task_id, instance_id, started_at, status, kind)
      VALUES (?, ?, ?, ?, 'running', 'manual')
    `).run(runId, taskId, instanceId, now)
    activeRunByInstance.set(instanceId, { runId, taskId })
    const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as TaskRunRow
    broadcastEvent({ type: 'task:run-started', payload: rowToRun(run) })
  }

  db.prepare('UPDATE pipeline_tasks SET last_run_at = ?, queued_since = NULL, updated_at = ? WHERE id = ?')
    .run(now, now, taskId)
  if (task.schedule_enabled === 1) {
    advanceSchedule(task, now, { manual: true, ranAs: 'started from the board' })
  }
  broadcastTaskUpdated(taskId)
}

/** Put an instance whose spawn never produced a process back to idle. No-op otherwise. */
function resetStrandedSpawn(instanceId: string): void {
  const r = db.prepare(
    `UPDATE instances SET process_state = 'idle', state = 'idle', process_pid = NULL, version = version + 1
     WHERE id = ? AND process_state = 'spawning' AND process_pid IS NULL`
  ).run(instanceId)
  if (r.changes > 0) console.log(`[task-schedule] Reset instance ${instanceId.slice(0, 8)} from a stranded 'spawning' state to idle`)
}

/**
 * THE FAILURE LEDGER.
 *
 * A run that errored increments `consecutive_failures`; a run that finished increments
 * nothing and resets it to zero. Reaching `disarm_after_failures` switches the card off
 * and records WHY, so a card that has broken three times in a row stops burning a Claude
 * process every slot until somebody looks at it.
 *
 * What counts is deliberately narrow (D11). A spawn that failed, a process that exited
 * non-zero, a run killed for going over its budget or its maximum duration: those are the
 * card's own failures. A run cut short because the SERVER restarted is 'interrupted' and
 * touches nothing, because three restarts in a row would otherwise switch off a routine
 * that has never once failed. A skip is not a failure either: the card did not run, and
 * the reason is already written on the skipped row.
 */
function recordRunOutcome(taskId: string, status: 'ok' | 'error', kind: string): void {
  const row = getScheduledTask(taskId)
  if (!row) return

  // A MANUAL RUN IS NOT THE SCHEDULE'S FAULT, AND NOT ITS CREDIT EITHER.
  //
  // Run now exists for trying something out, which means trying something that does not
  // work yet. Three failed attempts at a prompt the user is still writing would have switched
  // the schedule off underneath them, and one lucky manual run would have wiped the record
  // of a schedule that genuinely fails every night. The ledger is about what the SCHEDULE
  // does on its own.
  if (kind === 'manual') return

  if (status === 'ok') {
    if (row.consecutive_failures > 0) {
      db.prepare('UPDATE pipeline_tasks SET consecutive_failures = 0 WHERE id = ?').run(taskId)
      console.log(`[task-schedule] "${row.title}" ran cleanly; failure count reset from ${row.consecutive_failures} to 0`)
      broadcastTaskUpdated(taskId)
    }
    return
  }

  const failures = (row.consecutive_failures ?? 0) + 1
  const ceiling = row.disarm_after_failures ?? 3
  db.prepare('UPDATE pipeline_tasks SET consecutive_failures = ? WHERE id = ?').run(failures, taskId)

  // A CARD THAT HAS ALREADY FINISHED STAYS FINISHED.
  //
  // A card with a run limit whose last run then fails reaches both endings at once: the
  // fire wrote 'finished', and this failure would overwrite it with 'failed'. Last writer
  // won, and because settleScheduledColumn only sends 'finished' cards to Done, the card
  // ended up sitting in Backlog looking like standing work while being painted red and
  // unable to ever run again. Finishing is the older and more specific fact, so it holds.
  if (row.schedule_state === 'finished') {
    console.log(`[task-schedule] "${row.title}" failed on its last run, but it had already finished its run limit; leaving it finished`)
    broadcastTaskUpdated(taskId)
    return
  }

  // 0 means never disarm, for somebody who would rather a card kept trying.
  if (ceiling > 0 && failures >= ceiling) {
    db.prepare(
      "UPDATE pipeline_tasks SET schedule_enabled = 0, next_run_at = NULL, queued_since = NULL, schedule_state = 'failed', updated_at = ? WHERE id = ?"
    ).run(Date.now(), taskId)
    console.warn(
      `[task-schedule] "${row.title}" has failed ${failures} time(s) in a row, which is its limit; ` +
      'switched off. Re-arm it from the card once the cause is fixed.'
    )
  } else {
    console.warn(`[task-schedule] "${row.title}" failed (${failures} of ${ceiling || 'unlimited'} before it is switched off)`)
  }
  broadcastTaskUpdated(taskId)
}

/**
 * Tidy up the chat after a scheduled run, if the card asked for it (D17, D18, D19).
 *
 * COMPACT FIRST, THEN CLOSE, and the order is not arbitrary. Compacting works by resuming
 * the session and sending /compact, so a closed chat cannot be compacted: reversing these
 * would make "both ticked" silently mean "close only". More than that, the compacted
 * summary is what the NEXT run resumes into, so compacting after the close would throw away
 * the thing the close was preserving.
 *
 * Both steps are best-effort and neither is allowed to fail the run. The run is already
 * finalized and its cost is already recorded by the time this starts; a chat that could not
 * be tidied is untidy, not broken, and turning that into a failure would count toward the
 * disarm ceiling and eventually switch off a card whose actual work succeeded every time.
 */
async function postRunHygiene(taskId: string, instanceId: string): Promise<void> {
  const task = getScheduledTask(taskId)
  if (!task) return
  if (!task.auto_compact && !task.auto_close) return

  // A CHAT THE CARD DID NOT OPEN IS NOT THE CARD'S TO THROW AWAY.
  //
  // "Close the chat when the run finishes" means the chat this run opened, not whichever
  // chat the run happened to land on. A card PINNED to a chat is pointed at a conversation
  // that exists independently of it, usually with the user's own history in it, and
  // `messages` is ON DELETE CASCADE from `instances`, so closing it takes that history with
  // it. The two settings are contradictory anyway: the pin says "always this chat" and the
  // close says "throw it away". The pin wins, because it is the one the user set by hand and
  // the one whose loss cannot be undone.
  //
  // This also replaces a block that used to NULL the pin after closing. That block compared
  // against a copy of the card read before the compact, which is an await of tens of seconds
  // on a real context, so a pin set or changed during it was either missed or wrongly wiped.
  // Not closing a pinned chat at all removes the question.
  const pinnedHere = task.target_instance_id === instanceId

  if (task.auto_compact) {
    try {
      const { compactInstance } = await import('./claude-process.js')
      const result = await compactInstance(instanceId)
      if (result.ok) {
        console.log(`[task-schedule] "${task.title}": summarised chat ${instanceId.slice(0, 8)} to keep it small`)
      } else {
        console.warn(`[task-schedule] "${task.title}": could not summarise chat ${instanceId.slice(0, 8)} (${result.error ?? 'no reason given'}); leaving it as it is`)
      }
    } catch (err) {
      console.warn(`[task-schedule] "${task.title}": summarising chat ${instanceId.slice(0, 8)} threw (${(err as Error).message}); leaving it as it is`)
    }
  }

  if (!task.auto_close) return

  if (pinnedHere) {
    console.log(
      `[task-schedule] "${task.title}" is pinned to chat ${instanceId.slice(0, 8)}, so it was not closed: ` +
      'the close is for a chat a run opens, not for one the card was aimed at by hand. Unpin it to have each run open and close its own.'
    )
    return
  }

  // IS ANYTHING USING THIS CHAT RIGHT NOW? Asked HERE, immediately before the kill, and not
  // at the top of the function.
  //
  // By the time this runs the CLI has exited, the run is out of activeRunByInstance and the
  // row says idle, so to every other part of the app the chat looks completely free. It IS
  // free: the user can open it and send a message, and the app will accept it and spawn a
  // turn. Meanwhile a kill and a DELETE were already scheduled against it several seconds
  // ago, behind a /compact. Without this test the app answered a user's message with 200 and
  // a live process and then, moments later, killed that turn and deleted the chat and every
  // message in it, with no explanation and nothing left to look at.
  //
  // Leaving the chat open is the right failure: an untidy chat costs a row, and the
  // alternative costs the user work they were in the middle of.
  const live = db.prepare('SELECT state, process_state FROM instances WHERE id = ?').get(instanceId) as
    | { state: string | null; process_state: string | null } | undefined
  if (!live) return
  if (processRegistry.isTracked(instanceId) || live.state === 'running' || live.process_state === 'running') {
    console.warn(
      `[task-schedule] "${task.title}": chat ${instanceId.slice(0, 8)} is busy again, so it was left open rather than closed. ` +
      'Something started using it while the run was being tidied up.'
    )
    return
  }

  // CAPTURE THE SESSION BEFORE THE ROW GOES, and read it fresh rather than from anything
  // held earlier: the session id is written when the CLI answers, which is after this card
  // was last selected. `messages` is ON DELETE CASCADE from `instances`, so everything
  // below the DELETE is gone and there is no second chance to look.
  const inst = db.prepare('SELECT session_id FROM instances WHERE id = ?').get(instanceId) as { session_id: string | null } | undefined
  if (!inst) return

  // KILL FIRST, AND BELIEVE THE ANSWER. enforceMaxRunDuration goes to some trouble not to
  // touch the row unless the kill was confirmed, because marking a live agent's row idle
  // hides it and throws away the pid needed to try again. Deleting the row outright is
  // strictly worse: a surviving process would be left billing with no row, no pid and no
  // handle to reach it by. An unconfirmed kill therefore leaves everything exactly as it is.
  const dead = await processRegistry.killProcess(instanceId)
  if (!dead && processRegistry.isTracked(instanceId)) {
    console.warn(
      `[task-schedule] "${task.title}": chat ${instanceId.slice(0, 8)} would not die, so it was NOT closed. ` +
      'Its row and pid are left alone so the process can still be found and stopped.'
    )
    return
  }

  if (inst.session_id) {
    db.prepare('UPDATE pipeline_tasks SET resume_session_id = ?, updated_at = ? WHERE id = ?').run(inst.session_id, Date.now(), taskId)
  } else {
    // No session means the CLI never got far enough to start one, so there is nothing to
    // carry forward. Keeping the PREVIOUS resume id is right: one run that died before it
    // said anything should not cost the card its whole thread.
    console.warn(`[task-schedule] "${task.title}": chat ${instanceId.slice(0, 8)} has no session to carry forward; keeping the one from the run before`)
  }

  db.prepare('DELETE FROM instances WHERE id = ?').run(instanceId)
  releaseLocksForInstance(instanceId)
  broadcastEvent({ type: 'instance:deleted', payload: { id: instanceId } })
  broadcastTaskUpdated(taskId)
  console.log(`[task-schedule] "${task.title}": closed chat ${instanceId.slice(0, 8)} now the run has finished`)
}

/**
 * What a run really cost, read off turn_costs rather than off the turn-complete handler.
 *
 * WHY THIS HAS TO EXIST, and it is not a fallback nicety. A run that is KILLED never reaches
 * the handler that knows what it cost: enforceMaxRunDuration finalizes it FIRST, on purpose,
 * so claude-process's own exit handler finds nothing left to settle and cannot overwrite the
 * real reason with "exited with code 1". The price of that ordering is that it finalized with
 * no cost at all, and `finalizeRun` writes `costUsd ?? 0`.
 *
 * budgetDecision sums task_runs.cost_usd. So max_run_minutes and the weekly cap were
 * defeating each other: the runaway run the first exists to stop contributed exactly $0.00 to
 * the second. Measured, not argued: a killed scratch run really sent 47794 input tokens and
 * cost $0.0250, the ledger recorded $0.000000, and the card fired again straight through a
 * cap it had already spent two and a half times over. The card with a duration limit is by
 * definition the card somebody worried would run away, which makes it the exact card whose
 * spend the cap could never see.
 *
 * turn_costs already holds the number, written eagerly by the stream parser as the turn runs,
 * so it survives a kill. The `created_at >= started_at` test is what keeps a previous turn on
 * the same chat from being counted as this run's.
 */
function spendSinceRunStarted(
  instanceId: string,
  runId: string
): { costUsd: number; inputTokens: number; outputTokens: number } | null {
  try {
    const runRow = db.prepare('SELECT started_at FROM task_runs WHERE id = ?').get(runId) as { started_at: number } | undefined
    if (!runRow) return null
    // SUM, not the latest row: a long turn that was killed can have written several.
    const row = db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS inTok, COALESCE(SUM(output_tokens), 0) AS outTok
       FROM turn_costs WHERE instance_id = ? AND created_at >= ?`
    ).get(instanceId, runRow.started_at) as { cost: number; inTok: number; outTok: number } | undefined
    if (!row) return null
    if (!row.cost && !row.inTok && !row.outTok) return null
    return { costUsd: row.cost ?? 0, inputTokens: row.inTok ?? 0, outputTokens: row.outTok ?? 0 }
  } catch {
    return null
  }
}

function finalizeRun(
  runId: string,
  instanceId: string,
  status: 'ok' | 'error',
  data: { error?: string; costUsd?: number; inputTokens?: number; outputTokens?: number } = {}
): void {
  activeRunByInstance.delete(instanceId)
  // `WHERE status = 'running'` means a second call for the same run changes nothing, and
  // `changes` is how we know which call was the real one. Without that test the ledger
  // would count one failure twice whenever the spawn-error path raced the turn-complete
  // path, and disarm a card two strikes early.
  const settled = db.prepare(`
    UPDATE task_runs
    SET finished_at = ?, status = ?, error = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?
    WHERE id = ? AND status = 'running'
  `).run(Date.now(), status, data.error ?? null, data.costUsd ?? 0, data.inputTokens ?? 0, data.outputTokens ?? 0, runId)
  const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as TaskRunRow | undefined
  if (run) broadcastEvent({ type: 'task:run-finished', payload: rowToRun(run) })
  if (settled.changes > 0 && run?.task_id) {
    recordRunOutcome(run.task_id, status, (run as TaskRunRow & { kind?: string }).kind ?? 'scheduled')
    // Only on the call that actually settled the run, so a spawn-error racing the
    // turn-complete path cannot compact and close the same chat twice. Not awaited: this
    // function is called from a synchronous turn-complete callback, and the caller must not
    // be made to wait on a /compact turn. Failures inside are logged, never rethrown.
    void postRunHygiene(run.task_id, instanceId).catch(err => {
      console.warn(`[task-schedule] tidying up after run ${runId.slice(0, 8)} failed: ${(err as Error).message}`)
    })
  }
}

/** Turn finished on an instance we fired: close out the run with cost/tokens. */
function handleTurnComplete(instanceId: string, tokens: { inputTokens: number; outputTokens: number; costUsd: number } | undefined, exitCode: number | null): void {
  const active = activeRunByInstance.get(instanceId)
  if (!active) return

  let costUsd = tokens?.costUsd ?? 0
  let inputTokens = tokens?.inputTokens ?? 0
  let outputTokens = tokens?.outputTokens ?? 0

  // Fallback: exit handler had no token data (e.g. result line lost). Use the
  // latest turn_costs row for this instance, which the stream handler persists eagerly.
  if (!tokens) {
    const spent = spendSinceRunStarted(instanceId, active.runId)
    if (spent) {
      costUsd = spent.costUsd
      inputTokens = spent.inputTokens
      outputTokens = spent.outputTokens
    }
  }

  // A NON-ZERO EXIT IS A FAILURE EVEN WHEN THE TURN PRODUCED TOKENS.
  //
  // This used to read `exitCode !== null && exitCode !== 0 && !tokens`, and the `!tokens`
  // was the hole. `--max-budget-usd` is enforced INSIDE the Claude CLI (turn-flags.ts is
  // the only thing that sets it; there is no server-side budget kill), so a run stopped for
  // going over budget emits its result line on the way out. Tokens present, exit non-zero,
  // and the run was recorded as 'ok' and RESET the failure counter. D11 names a budget kill
  // as a failure by definition, so the auto-disarm was blind to the single most likely
  // repeating failure, and a card alternating budget-kills with real failures could never
  // reach three strikes. A null exit code (killed by a signal) is a failure too, for the
  // same reason: the turn did not end, something ended it.
  const failed = exitCode !== 0
  const reason = exitCode === null
    ? 'the claude process was stopped before the turn finished'
    : `claude process exited with code ${exitCode}${tokens ? ' after producing a result, which usually means it stopped itself (budget or limit)' : ''}`
  finalizeRun(active.runId, instanceId, failed ? 'error' : 'ok', {
    error: failed ? reason : undefined,
    costUsd, inputTokens, outputTokens,
  })
  console.log(`[task-schedule] Run ${active.runId.slice(0, 8)} finished (${failed ? 'error' : 'ok'}) cost=$${costUsd.toFixed(4)}`)
}

// ── Poll loop ───────────────────────────────────────────────────────────────

/**
 * Should this late slot still fire, and if not, why not? (D9.)
 *
 * 'late' (the default) fires a missed slot only while it is still FRESH, and freshness is
 * defined by the card's own cadence rather than by a fixed 24 hours: a slot is stale once
 * the slot AFTER it has also gone by, because firing then would deliver yesterday's run at
 * the moment today's is already due. An 'every' card must additionally still be inside an
 * active window, since the whole point of a window is that the card does not run outside it.
 *
 * A stale slot is skipped, but that is not the end of the question: the most recent slot at
 * or before now is judged by the same two rules, and when it passes, `runLateAt` names it so
 * the tick runs that one late instead of jumping it (see runTick).
 *
 * 'skip' never fires a late slot at all, for work that is only worth doing on time.
 *
 * A 'once' card ignores all of this and always fires, however late: a reminder delivered
 * late still does its job and a reminder deleted does not.
 */
type CatchUpDecision =
  | { fire: true }
  | { fire: false; reason: string; runLateAt?: number }

/**
 * The most recent slot at or before `now`, given `known`, a slot already known to be at or
 * before it.
 *
 * BISECTED, NOT WALKED. The engine only answers "the first slot after t", so walking forward
 * costs one call per missed slot, all of them inside one synchronous tick: an every-minute card
 * left off for a week is 10,080 calls, measured at about two seconds of a blocked server. But
 * "the first slot after t is still at or before now" holds for every t below the answer and
 * fails for every t at or above it, so the answer can be bisected on t instead: about 30 calls
 * for a week and 35 for a year, whatever the cadence. It only ever asks the one engine, so it
 * cannot land on a slot the card never had.
 */
function latestSlotAtOrBefore(spec: ScheduleSpec, known: number, now: number): number {
  // Held throughout: `found` is the first slot after `lo` and is at or before now, and the
  // first slot after `hi` is not (it is later than now, or there is none).
  let lo = known - 1
  let hi = now
  let found = known
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2)
    const next = computeNextRunAt(spec, mid)
    if (next != null && next <= now) {
      lo = mid
      found = next
    } else {
      hi = mid
    }
  }
  return found
}

function catchUpDecision(task: ScheduledTaskRow, now: number): CatchUpDecision {
  if (task.schedule_kind === 'once') return { fire: true }
  const slot = task.next_run_at as number
  const late = now - slot
  // Two polls of slack: a slot reached a few seconds ago is not a "missed" slot at all.
  if (late <= POLL_INTERVAL_MS * 2) return { fire: true }

  if (task.catchup_policy === 'skip') {
    return { fire: false, reason: `missed by ${fmtLate(late)}, and this card is set to skip missed runs rather than run them late` }
  }

  // Has the NEXT slot after the missed one also gone by?
  //
  // `following == null` means there IS no run after this one, which happens in exactly two
  // ways and both mean the same thing: the end date has passed, or the schedule cannot be
  // computed at all. Reading null as "not stale" inverted it, and a card told to stop on
  // Friday would run once on Saturday if the laptop had been asleep across its last slot.
  const spec = specOf(task)
  const following = computeNextRunAt(spec, slot)
  if (following == null) {
    return { fire: false, reason: `missed by ${fmtLate(late)}, and this card has no runs left after it, so this run was skipped` }
  }
  if (now >= following) {
    // STALE, BUT THE MOST RECENT SLOT IT MISSED MAY NOT BE.
    //
    // This used to stop here, and the tick then armed the first slot after NOW, which jumps
    // every missed slot including the one this policy exists to run. Example: a daily
    // 11:25 card whose Sunday was missed comes up at 11:49 on Monday: Sunday is stale, so
    // Monday's 11:25, 24 minutes late and fresh by the rule above, would go with it and the
    // card would not run that day at all.
    //
    // The latest slot's own next slot is after now by construction, so it is fresh unless
    // there is no slot after it at all. It still has to pass the window test like any other.
    const latest = latestSlotAtOrBefore(spec, following, now)
    const allSkipped = latest === following
      ? 'this run and the one after it were skipped'
      : 'this run and every one missed after it were skipped'
    if (computeNextRunAt(spec, latest) == null) {
      return { fire: false, reason: `missed by ${fmtLate(late)}, and this card has no runs left after the ones it missed, so ${allSkipped}` }
    }
    if (!isInsideActiveWindow(spec, now)) {
      return { fire: false, reason: `missed by ${fmtLate(late)}, which is past the run after it, and the hours this card is allowed to run in have closed since, so ${allSkipped}` }
    }
    const olderSkipped = latest === following ? 'this run was skipped' : 'this run and the ones missed after it were skipped'
    const dueAgo = now - latest
    const latestRun = dueAgo <= POLL_INTERVAL_MS * 2
      ? 'due just now, is being run instead'
      : `due ${fmtLate(dueAgo)} ago, is being run late instead`
    return {
      fire: false,
      runLateAt: latest,
      reason: `missed by ${fmtLate(late)}, which is past the run after it, so ${olderSkipped}. The most recent one, ${latestRun}.`,
    }
  }

  // Still inside an active window? Asked directly, of the window itself.
  //
  // This used to ask "is the next candidate less than one cadence away?", which is a proxy
  // and a wrong one: for the last slot of any window whose close is not itself a slot, the
  // next candidate is TOMORROW'S opening. On the acceptance schedule (every 5 hours, 11:00
  // to 19:00) that meant a 16:00 slot missed by five minutes was dropped with "the active
  // window has closed since" while the window still had three hours left to run.
  if (!isInsideActiveWindow(specOf(task), now)) {
    return { fire: false, reason: `missed by ${fmtLate(late)} and the hours this card is allowed to run in have closed since, so this run was skipped` }
  }

  return { fire: true }
}

/**
 * Kill any in-flight run that has been going longer than its card allows (D13).
 *
 * The root PID is killed first and the kill is verified, because a half-killed Claude on
 * Windows leaves orphans that keep the instance marked busy and block every later slot.
 */
async function enforceMaxRunDuration(now: number): Promise<void> {
  for (const [instanceId, active] of [...activeRunByInstance]) {
    const task = getScheduledTask(active.taskId)
    if (!task?.max_run_minutes) continue
    const run = db.prepare('SELECT started_at FROM task_runs WHERE id = ?').get(active.runId) as { started_at: number } | undefined
    if (!run) continue
    const ranFor = now - run.started_at
    if (ranFor <= task.max_run_minutes * 60_000) continue

    console.warn(
      `[task-schedule] "${task.title}" has been running for ${fmtLate(ranFor)}, past its ${task.max_run_minutes} minute limit; killing it`
    )

    // FINALIZE FIRST, THEN KILL, and the order is the whole point.
    //
    // Killing the process makes it exit non-zero, which fires claude-process's own
    // turn-complete handler, which finalizes the run as "claude process exited with code
    // 1". That handler wins the race against an await, so finalizing afterwards found the
    // run already settled and left the card's history saying the process crashed when in
    // fact we stopped it on purpose. Writing the real reason first means the exit handler
    // finds nothing left to finalize (the run is no longer 'running' and the instance is
    // no longer in activeRunByInstance), so the ledger moves exactly once and the run says
    // what actually happened.
    // WITH WHAT IT SPENT ON THE WAY. Finalizing first is what stops the exit handler
    // overwriting the real reason, but that handler is also the one that knows the cost, so
    // finalizing without it recorded $0.00 for the single most expensive kind of run there
    // is: the one that ran so long it had to be stopped. The weekly cap sums this column, so
    // a card with a duration limit was invisible to its own budget. Read it off turn_costs,
    // which the stream parser writes as the turn runs and which therefore survives the kill.
    const spent = spendSinceRunStarted(instanceId, active.runId)
    finalizeRun(active.runId, instanceId, 'error', {
      error: `exceeded max run duration of ${task.max_run_minutes} minute(s), so the run was stopped`,
      costUsd: spent?.costUsd,
      inputTokens: spent?.inputTokens,
      outputTokens: spent?.outputTokens,
    })
    if (spent) {
      console.warn(`[task-schedule] "${task.title}": that run had already spent $${spent.costUsd.toFixed(4)}, which is counted against its weekly limit`)
    }
    // killProcess returns FALSE when the process survived every attempt, and its own
    // comment is explicit that the caller must not then mark the instance stopped, because
    // the agent is still running. Throwing that verdict away and clearing the row anyway
    // left a live Claude with its row saying idle and its pid nulled, which destroys the
    // only handle a later kill could use. Every subsequent slot of that card then sees the
    // registry still tracking it, waits an hour and skips, forever.
    let confirmedDead = false
    try {
      confirmedDead = await processRegistry.killProcess(instanceId)
    } catch (err) {
      console.error(`[task-schedule] kill failed for instance ${instanceId.slice(0, 8)}:`, err)
    }
    if (confirmedDead) {
      resetStrandedSpawn(instanceId)
      db.prepare("UPDATE instances SET process_state = 'idle', state = 'idle', process_pid = NULL, active_task_id = NULL WHERE id = ?").run(instanceId)
    } else {
      console.error(
        `[task-schedule] "${task.title}": the run was past its limit but the process would NOT die. ` +
        'The chat row is being left exactly as it is, because it is still running: marking it idle ' +
        'here would hide a live agent and throw away the pid needed to try again.'
      )
    }
    settleScheduledColumn(active.taskId)
    broadcastTaskUpdated(active.taskId)
  }
}

/**
 * Re-entrancy guard. tick() awaits a fire now, so two timer callbacks could otherwise
 * overlap and both pick the same head card off the same query.
 */
let ticking = false

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    await runTick()
  } finally {
    ticking = false
  }
}

async function runTick(): Promise<void> {
  const now = Date.now()
  void enforceMaxRunDuration(now).catch(err => console.error('[task-schedule] max-duration sweep error:', err))

  const due = db.prepare(
    `SELECT ${SCHEDULED_COLUMNS} FROM pipeline_tasks
     WHERE schedule_enabled = 1 AND schedule_kind IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ?
     ORDER BY next_run_at ASC, id ASC`
  ).all(now) as ScheduledTaskRow[]

  // ONE CARD IS CONSIDERED PER TICK, AND ONLY ONE (D16).
  //
  // The loop stops at the first card it acts on, whether that was a fire or a skip. Every
  // other due card is left completely alone: slot untouched, no skip row, no wait stamp,
  // no broadcast, exactly as D16 says. Thirty seconds later the next poll takes the oldest
  // of what is left, so cards take turns.
  //
  // Judging only the head card is the part that matters. Judging ALL of them each tick
  // meant a card that had not had its turn yet was tested for staleness anyway, found
  // stale (its next slot had arrived while it waited behind the others), and skipped with a
  // reason that blamed the schedule for the scheduler's own rate limit. Three cards on a
  // one-minute cadence left the third firing never and skipping forever, and fifty stale
  // cards produced two hundred DB writes and a hundred broadcasts in one synchronous tick.
  //
  // `ORDER BY next_run_at ASC, id ASC`: without the id tiebreaker, cards sharing a slot
  // were ordered by whatever SQLite's scan happened to give, so the same card could lose
  // every single tick.
  for (const head of due) {
    let task = head
    // A schedule that cannot be computed must not fire. A row edited by hand, or one the
    // migration could not convert, would otherwise run once on a slot from an engine that
    // no longer exists and print "every NaN minutes" into the log and the pill on its way.
    const invalid = validateSchedule(specOf(task))
    if (invalid) {
      recordSkippedRun(task, `this card's schedule is not valid (${invalid}) so it cannot run; switched off`)
      disarmTask(task.id, `invalid schedule: ${invalid}`)
      console.warn(`[task-schedule] "${task.title}" has an invalid schedule (${invalid}); switched off rather than fired`)
      break
    }

    const decision = catchUpDecision(task, now)
    // Set once a skip has been written for this card: the tick is spent on it whatever the
    // fire below then does, including declining because the chat is busy.
    let skippedMissed = false
    if (!decision.fire) {
      recordSkippedRun(task, decision.reason)
      if (decision.runLateAt == null) {
        rescheduleTask(task.id, now)
        broadcastTaskUpdated(task.id)
        console.warn(`[task-schedule] "${task.title}" ${decision.reason}; next slot armed`)
        break
      }
      // THE MISSED SLOTS ARE SKIPPED AND THE MOST RECENT ONE RUNS, IN THIS SAME TICK.
      //
      // Rescheduling from just before that slot arms exactly it, through the one writer, and
      // the card carries straight on down the ordinary fire path below, so the budget cap, a
      // busy chat and a missing prompt all treat it like any other due slot. Not left to the
      // next poll: thirty seconds queued behind other due cards is long enough for a short
      // cadence to go stale again and write a second skip.
      rescheduleTask(task.id, decision.runLateAt - 1)
      broadcastTaskUpdated(task.id)
      console.warn(`[task-schedule] "${task.title}" ${decision.reason}`)
      const armed = getScheduledTask(task.id)
      if (!armed) break
      task = armed
      skippedMissed = true
    }

    // THE WEEKLY SPEND CAP, CHECKED BEFORE ANYTHING IS SPAWNED (D14).
    //
    // Deliberately NOT a disarm. A card over its cap has done nothing wrong: it is a card
    // the user asked to run often and which costs what it costs. Switching it off would
    // mean noticing, remembering, and arming it again by hand next week, and the whole
    // point of a cap is that it needs no attention. So the slot is skipped, the card stays
    // armed, and the next slot is armed behind it. The window rolls forward on its own and
    // the card starts running again without anybody touching it, which is why the pill for
    // this state says "the schedule is still armed" where the failed one says the opposite.
    const budget = budgetDecision(task, now)
    if (budget) {
      recordSkippedRun(task, budget.reason)
      setScheduleState(task.id, 'over_budget')
      rescheduleTask(task.id, now)
      broadcastTaskUpdated(task.id)
      console.warn(`[task-schedule] "${task.title}" ${budget.reason}; next slot armed and the card left on`)
      break
    }
    // Under the cap again. This is the exact moment "no longer over budget" is known, which
    // is why the state is cleared here rather than after the run: a run that fails still
    // means the card is back inside its allowance, and leaving the red pill up until a
    // SUCCESSFUL run would have shown the wrong reason for the wrong problem.
    if (task.schedule_state === 'over_budget') {
      setScheduleState(task.id, null)
      broadcastTaskUpdated(task.id)
      console.log(`[task-schedule] "${task.title}" is back inside its weekly spending limit; running again`)
    }

    const late = now - (task.next_run_at as number)
    // A CARD THAT DECLINED TO FIRE DID NOT USE THE TICK'S ONE FIRE.
    //
    // fireTask returns without spawning anything when the chat is busy or a run of the same
    // card is still in flight. Treating that as the tick's fire let the oldest due card sit
    // at the head of the queue blocking every other card behind it, for up to the full
    // one-hour queue wait. So the result is awaited and the loop only stops once something
    // actually happened. It also means the "firing it late" line is printed AFTER the fire,
    // rather than announcing a fire that then did not occur: that line was being quoted as
    // proof a late run had happened.
    let fired = false
    try {
      const result = await fireTask(task)
      fired = result.ok
      if (fired && late > POLL_INTERVAL_MS * 2) {
        console.log(`[task-schedule] "${task.title}" was ${fmtLate(late)} late and still fresh, so it was run late (catch-up policy: ${task.catchup_policy})`)
      }
      // A card refused for having no prompt did not fire, but it WAS acted on: a failed run
      // was written and its slot moved on, exactly like a skip. D16 spends the tick on it.
      if (result.reason === 'no-prompt') fired = true
    } catch (err) {
      console.error(`[task-schedule] fire error for ${task.id}:`, err)
      // A throw is not a decline: something went wrong and this tick is spent on it.
      fired = true
    }
    if (fired || skippedMissed) break
  }
}

export function startTaskScheduler(): void {
  if (pollTimer) return

  // Boot re-arm: only cards with NO next_run_at (fresh migration, or armed while the
  // server was down) get a freshly computed occurrence. A past-due slot is deliberately
  // LEFT ALONE so the first poll can fire or skip it under the catch-up policy in tick().
  // Advancing it here is how reminders used to vanish.
  const enabled = db.prepare(
    `SELECT ${SCHEDULED_COLUMNS} FROM pipeline_tasks WHERE schedule_enabled = 1 AND schedule_kind IS NOT NULL`
  ).all() as ScheduledTaskRow[]
  const now = Date.now()
  let pastDue = 0
  let rearmed = 0
  for (const t of enabled) {
    if (t.next_run_at == null) {
      const next = rescheduleTask(t.id, now)
      rearmed++
      // Named individually, because this is the line that proves migration048's re-anchor
      // landed: every converted card comes back with NULL and gets its first slot on the
      // NEW grid here, not on the grid it was computed against before the migration.
      console.log(
        `[task-schedule] Re-armed "${t.title}" (${describeSchedule(specOf(t))}): ` +
        (next == null ? 'no next run' : `next run ${formatInstant(next)}`)
      )
    } else if (t.next_run_at <= now) pastDue++
  }
  if (rearmed > 0) {
    console.log(`[task-schedule] Re-armed ${rearmed} card(s) that had no slot (fresh migration, or armed while the server was down)`)
  }
  if (pastDue > 0) {
    console.log(`[task-schedule] ${pastDue} card(s) came due while the server was down; the first poll decides each one`)
  }

  // A wait on a busy instance belongs to the process that started it: dead instances
  // are reset to idle at boot (live ones are adopted) and the catch-up policy decides
  // every slot afresh. Clear stale stamps so a dead wait cannot masquerade as a live one.
  const stale = db.prepare(
    'UPDATE pipeline_tasks SET queued_since = NULL WHERE queued_since IS NOT NULL'
  ).run()
  if (stale.changes > 0) console.log(`[task-schedule] Cleared ${stale.changes} stale wait stamp(s) from before the restart`)

  // Orphaned 'running' run rows from a previous boot can never be finalized: mark them.
  //
  // 'interrupted', NOT 'error'. A run cut short because the server restarted says nothing
  // about whether the card works, so it must not touch consecutive_failures. Recorded as
  // 'error' (which is what this did) three restarts in a row would switch off a routine
  // that has never once failed, and the card would sit there saying "Failed 3 times" about
  // three deploys. Nothing below increments the ledger, which is the whole point.
  //
  // THE COST IS CARRIED ACROSS TOO. This used to leave cost_usd at its default of 0, and the
  // weekly cap sums that column, so a run that spent real money right up to the moment the
  // server went down contributed nothing to its card's budget. Same hole as the kill path,
  // same source for the answer: turn_costs is written by the stream parser as the turn goes,
  // so it is already on disk when the process dies. The correlated subquery only counts rows
  // written after the run started, which keeps an earlier turn on the same chat out of it.
  const orphaned = db.prepare(`
    UPDATE task_runs SET
      status = 'interrupted',
      error = 'the server restarted while this run was going',
      finished_at = ?,
      cost_usd = COALESCE((SELECT SUM(tc.cost_usd) FROM turn_costs tc
                            WHERE tc.instance_id = task_runs.instance_id AND tc.created_at >= task_runs.started_at), cost_usd),
      input_tokens = COALESCE((SELECT SUM(tc.input_tokens) FROM turn_costs tc
                            WHERE tc.instance_id = task_runs.instance_id AND tc.created_at >= task_runs.started_at), input_tokens),
      output_tokens = COALESCE((SELECT SUM(tc.output_tokens) FROM turn_costs tc
                            WHERE tc.instance_id = task_runs.instance_id AND tc.created_at >= task_runs.started_at), output_tokens)
    WHERE status = 'running'
  `).run(now)
  if (orphaned.changes > 0) {
    console.log(
      `[task-schedule] ${orphaned.changes} run(s) were cut short by the restart, marked interrupted. ` +
      'That is not a failure and does not count towards any card being switched off.'
    )
    // Every other status transition in this file broadcasts; this one did not, so a client
    // that survived the restart went on showing those runs as still running until somebody
    // reloaded the page.
    const swept = db.prepare("SELECT * FROM task_runs WHERE status = 'interrupted' AND finished_at = ?").all(now) as TaskRunRow[]
    for (const r of swept) broadcastEvent({ type: 'task:run-finished', payload: rowToRun(r) })
  }

  // A card left sitting in In Progress by a run that died with the server would never
  // leave it: its turn-complete is never coming. Settle each one now, the same way a
  // finished run would have.
  //
  // Deliberately NOT the `enabled` list. A card is switched off at FIRE time when that fire
  // is its last (a one-off, or the run that reaches its limit), so exactly the cards whose
  // final run was cut short by the restart are the ones missing from it, and they would
  // have sat in In Progress for ever.
  const stuck = db.prepare(
    `SELECT ${SCHEDULED_COLUMNS} FROM pipeline_tasks WHERE schedule_kind IS NOT NULL AND "column" = 'in_progress'`
  ).all() as ScheduledTaskRow[]
  for (const t of stuck) settleScheduledColumn(t.id)
  if (stuck.length > 0) {
    console.log(`[task-schedule] Settled ${stuck.length} card(s) left in In Progress by the restart`)
  }

  // Subscribe to turn completions for cost capture (lazy import avoids a static cycle).
  void import('./claude-process.js').then(mod => {
    unsubscribeTurnComplete = mod.onTurnComplete(handleTurnComplete)
  })

  pollTimer = setInterval(() => {
    void tick().catch(err => console.error('[task-schedule] tick error:', err))
  }, POLL_INTERVAL_MS)

  console.log(`[task-schedule] Task scheduler started: ${enabled.length} armed card(s), polling every ${POLL_INTERVAL_MS / 1000}s`)
}

export function stopTaskScheduler(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (unsubscribeTurnComplete) {
    unsubscribeTurnComplete()
    unsubscribeTurnComplete = null
  }
  activeRunByInstance.clear()
}

/** Manual "run now" from the UI: bypasses the due-check, keeps the schedule slot. */
export async function runTaskNow(taskId: string): Promise<{ ok: boolean; reason?: string; runId?: string }> {
  const row = getScheduledTask(taskId)
  if (!row) return { ok: false, reason: 'not-found' }
  return fireTask(row, { manual: true })
}

/** Re-export so callers do not need to know which module owns the kind union. */
export type { TaskScheduleKind }
