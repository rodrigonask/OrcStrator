import type { PipelineTask } from '@shared/types'
import { describeNextRun, formatInstant } from '@shared/routine-schedule'
import { describeSchedule, type ScheduleSpec } from '@shared/schedule-next'

// What a scheduled card says about itself on the board.
//
// This replaces utils/routineBoard.ts, which existed only to fake a board column for an
// entity that had none. A scheduled card has a real column now, so the bucketing is gone
// and only the PILL survives: the one line that says when this thing next runs, or why it
// is not going to.

export interface SchedulePill {
  /** Short text on the pill itself. */
  label: string
  /** Longer explanation for the title attribute. */
  title: string
  /** Drives the pill colour. */
  /** Matches the .task-schedule-badge--* classes that already exist in styles.css. */
  tone: 'routine' | 'paused' | 'fired' | 'failed'
}

/** A card the scheduler will act on. An ordinary card has no scheduleKind at all. */
export function isScheduled(task: PipelineTask): boolean {
  return !!task.scheduleKind
}

/**
 * A one-off that fired and switched itself off. That is completion, not a user choice, and
 * it is why such a card sits in Done rather than back in Backlog.
 */
export function isFiredOnce(task: PipelineTask): boolean {
  return task.scheduleKind === 'once' && !task.scheduleEnabled && task.lastRunAt != null
}

/** The schedule fields off a card, in the shape the shared engine reads. */
export function specOf(task: PipelineTask): ScheduleSpec {
  return {
    kind: task.scheduleKind as string,
    value: task.scheduleValue as string,
    days: task.scheduleDays ?? null,
    window: task.scheduleWindow ?? null,
    tz: task.scheduleTz ?? null,
    until: task.scheduleUntil ?? null,
  }
}

/**
 * A card in a state the board has to EXPLAIN rather than just show a next-run time for.
 *
 * These are the only three, and each is a decision the scheduler made on its own while
 * nobody was watching: it ran out of runs, it broke too many times, or it hit its spending
 * ceiling. Two of them are red, because they mean the card has stopped and a human has to
 * do something. "Finished" is not red: finishing is what it was asked to do.
 */
export function isInTrouble(task: PipelineTask): boolean {
  // A CARD THE USER PARKED IS NOT IN TROUBLE. An over-budget card needs nothing from anybody:
  // it clears itself as its own spend ages out of the rolling week. The dot is there because
  // it is RUNNING and quietly skipping, which is worth knowing. Switch it off and that stops
  // being true, and the dot became a permanent mark on a card the user had deliberately
  // parked, with no way to clear it except arming the card again.
  //
  // 'failed' keeps its dot when disarmed, and the difference is who did the disarming: the
  // scheduler switched that one off, and the whole point of the dot is to say so.
  if (task.scheduleState === 'over_budget') return !!task.scheduleEnabled
  return task.scheduleState === 'failed'
}

/** Every card across every project that needs the red dot. Drives both nav rails. */
export function cardsInTrouble(tasks: PipelineTask[]): PipelineTask[] {
  return tasks.filter(isInTrouble)
}

export function schedulePill(task: PipelineTask): SchedulePill | null {
  if (!task.scheduleKind || !task.scheduleValue) return null

  const every = describeSchedule(specOf(task))

  // THE STATE PILLS COME FIRST. A card that has failed three times is also, technically,
  // a paused card with a schedule, and saying "Paused" would hide the only fact that
  // matters about it. What the scheduler decided outranks what the card is configured as.
  if (task.scheduleState === 'failed') {
    const n = task.consecutiveFailures ?? 0
    // A count of zero is not "it failed no times". It is a card the scheduler stopped for a
    // reason that is not a run failure at all: its project folder is gone, or its schedule
    // cannot be computed. Saying "Failed 0 times" there is nonsense on exactly the card
    // somebody is trying to understand.
    if (n === 0) {
      return {
        label: 'Stopped',
        tone: 'failed',
        title: `${every}. The scheduler switched this card off because it could not run it. Open it to see what it is missing: usually its project folder or its chat is gone.`,
      }
    }
    return {
      label: `Failed ${n} time${n === 1 ? '' : 's'}, switched off`,
      tone: 'failed',
      title: `${every}. It failed ${n} time${n === 1 ? '' : 's'} in a row, so it was switched off. Open the card and arm it again once the cause is fixed.`,
    }
  }

  if (task.scheduleState === 'over_budget') {
    const cap = task.budgetCapUsd
    const limit = cap != null ? `its $${cap.toFixed(2)} limit` : 'its spending limit'
    // "STILL ARMED" IS ONLY TRUE WHILE IT IS.
    //
    // The state is cleared by the poll loop, which only looks at armed cards, and disarming
    // by hand deliberately does not clear it (a failed card must not lose its record just for
    // being switched off). Put together: "this is costing too much, I will switch it off for
    // now" is the most natural reaction to this pill, and it was the one action that made the
    // pill permanently wrong. It kept saying the schedule was still armed, kept the red dot in
    // both rails for a card the user had deliberately parked, and nothing could ever clear it,
    // because the only code that clears it needs the card armed. Re-arming was the only way
    // out, which is the opposite of what the user was trying to do.
    if (!task.scheduleEnabled) {
      return {
        label: 'Over budget, paused',
        tone: 'failed',
        title: `${every}. It went over ${limit} for the last 7 days and you switched it off. Arm it again whenever you want it back: the limit is counted over the last 7 days, so it clears itself as that spend ages out.`,
      }
    }
    return {
      label: 'Over budget',
      tone: 'failed',
      title: `${every}. It has hit ${limit} for the last 7 days, so runs are being skipped until that spend ages out. The schedule is still armed and needs nothing from you.`,
    }
  }

  if (task.scheduleState === 'finished') {
    const n = task.runCount ?? 0
    return {
      label: n > 0 ? `Finished, ${n} run${n === 1 ? '' : 's'}` : 'Finished',
      tone: 'fired',
      // "used all N of its runs", not "done all N": the counter moves when a slot is
      // consumed, so a card whose every run failed still reaches its limit. Saying it had
      // "done" them would be a straight lie on exactly the card somebody is investigating.
      title: task.scheduleMaxRuns != null
        ? `${every}. It has used all ${n} of its runs and switched itself off.`
        : `${every}. It reached its end date after ${n} run${n === 1 ? '' : 's'} and switched itself off.`,
    }
  }

  if (isFiredOnce(task)) {
    return {
      label: 'Fired',
      tone: 'fired',
      title: task.lastRunAt != null
        ? `Fired ${formatInstant(task.lastRunAt)}. One-offs switch themselves off after firing.`
        : 'Fired',
    }
  }

  if (!task.scheduleEnabled) {
    return {
      label: 'Paused',
      tone: 'paused',
      title: `${every}, currently paused. Edit the card and arm it to start it again.`,
    }
  }

  // A card that is due but waiting on a busy chat keeps its slot rather than advancing it,
  // so next_run_at is in the past and describeNextRun would read as overdue. Say what is
  // actually happening instead.
  if (task.queuedSince != null) {
    return {
      label: 'Waiting',
      tone: 'routine',
      title: `${every}. Due now, but its chat is busy, so the run is waiting rather than being skipped.`,
    }
  }

  const next = describeNextRun(task.nextRunAt)
  return {
    label: next ?? every,
    tone: 'routine',
    // describeNextRun already returns a whole phrase ("next run in 1 h 31 min", "due now"),
    // so prefixing it with "Next run" produced "Next run next run in 1 h 31 min". Capitalise
    // the phrase instead of introducing it.
    title: next ? `${every}. ${next[0].toUpperCase()}${next.slice(1)}.` : `${every}. No next run armed.`,
  }
}
