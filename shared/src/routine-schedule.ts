// Formatting helpers for a scheduled card: the instant it fired, how long until the next
// one, and the weekday names the day picker draws.
//
// THE SCHEDULE ITSELF IS NOT DESCRIBED HERE ANY MORE. That moved to schedule-next.ts with
// migration048, and this file was cut down to what is genuinely still used, because what
// was left behind was actively dangerous: `describeRoutineSchedule` took a plain string
// for the kind, knew only interval/daily/weekly, and fell through to printing the raw
// value for anything else. After the migration it silently rendered "Routine · 300" where
// it meant "every 5 hours, 11:00 to 19:00, on Tue, Wed, Thu, Fri, Sun", and the type
// checker could not see it, because a string is a string. Ten other exports here had zero
// callers and every one of them was the same trap waiting for the next reader. They are
// gone. There is exactly one place a schedule turns into a sentence now, and it is
// describeSchedule in schedule-next.ts.
//
// Text rules (24h HH:MM, short English month, day without a leading zero):
//   fired    Fired · 11:25 on Sep 9      (", 2027" appended only when the year differs)
//   next     next run in 23 h 52 min / next run in 12 min / due now

export interface FiredDescription {
  label: 'Fired'
  text: string
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Indexed by Date.getDay(): 0 = Sunday. */
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Display order for a day list: Monday first, Sunday last. Values are Date.getDay(). */
export const WEEKDAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0]

const ONCE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "11:35 on Aug 7", with ", 2027" only when the year is not the current one. */
function fmtInstant(d: Date, now: Date): string {
  const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())} on ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`
}

/** A timestamp as "11:25 on Sep 9" (year appended when it differs from now). */
export function formatInstant(ts: number, opts: { now?: number } = {}): string {
  return fmtInstant(new Date(ts), new Date(opts.now ?? Date.now()))
}

/**
 * 'YYYY-MM-DDTHH:MM' (what datetime-local emits) -> local Date, or null if malformed.
 *
 * Deliberately LOCAL, unlike everything in schedule-next.ts: this is the modal reading back
 * the value its own `datetime-local` input produced, which is a local wall-clock reading by
 * definition. The card's zone is applied by the engine, not here.
 */
export function parseOnceValue(value: string): Date | null {
  const m = ONCE_RE.exec(value)
  if (!m) return null
  const [y, mo, d, hh, mm] = m.slice(1).map(Number)
  return new Date(y, mo - 1, d, hh, mm, 0, 0)
}

/** The badge for a one-off that has already fired (enabled=false, lastRunAt set). */
export function describeFiredOnce(lastRunAt: number | null | undefined, opts: { now?: number } = {}): FiredDescription {
  if (lastRunAt == null) return { label: 'Fired', text: 'at an unknown time' }
  return { label: 'Fired', text: fmtInstant(new Date(lastRunAt), new Date(opts.now ?? Date.now())) }
}

/**
 * Text for an armed routine: "next run in 23 hours 52 minutes", "next run in 12 minutes",
 * "next run in 3 days 4 hours", or "due now" once the slot has passed. null when nothing
 * is armed.
 *
 * Units are spelled out rather than abbreviated. This string is the board pill, read at a
 * glance by somebody who does not write code, and "3 d 4 h" is a puzzle where "3 days
 * 4 hours" is a sentence. The pill reserves a fixed width for it (see
 * .task-schedule-badge--routine), because the text shortens as the countdown runs down and
 * a pill that changes width every minute makes the whole card row twitch.
 */
export function describeNextRun(nextRunAt: number | null | undefined, now = Date.now()): string | null {
  if (nextRunAt == null) return null
  const diff = nextRunAt - now
  if (diff <= 0) return 'due now'
  const totalMin = Math.floor(diff / 60_000)
  if (totalMin < 1) return 'next run in under a minute'
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  if (days > 0) return `next run in ${unit(days, 'day')} ${unit(hours, 'hour')}`
  if (hours > 0) return `next run in ${unit(hours, 'hour')} ${unit(mins, 'minute')}`
  return `next run in ${unit(mins, 'minute')}`
}
