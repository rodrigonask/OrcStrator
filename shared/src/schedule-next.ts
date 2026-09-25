// ─────────────────────────────────────────────────────────────────────────────
// When a scheduled card next wants to fire.
//
// ONE function, called by BOTH the server's poll loop and the modal's "next 5 runs"
// preview. That is not a tidiness preference, it is the whole point of the file: a
// preview computed by a second implementation is a list of times that never happen,
// and nobody finds out until the routine has been quietly firing at the wrong hour
// for a week.
//
// Two cadences:
//   'every'  value = minutes. Candidates are window-open + k * N, while <= window close.
//   'times'  value = a comma-separated list of 'HH:MM'.
//   'once'   value = 'YYYY-MM-DDTHH:MM'. Returned AS-IS even when it is in the past,
//            so a late reminder is delivered late rather than lost.
//
// THE ANCHOR (read this before changing anything below):
//   'every' is anchored on the WINDOW OPEN, never on "N minutes after the last fire".
//   With no window that anchor is midnight, so "every 300" fires 00:00, 05:00, 10:00,
//   15:00, 20:00 and starts again at midnight. The 4-hour gap once a day is deliberate
//   and accepted: a fixed grid is a promise the screen can make, and now+N is not (it
//   drifts by the poll delay on every fire and re-anchors on every restart).
//
// THE ZONE:
//   Every wall-clock value is resolved in the CARD's zone, never the server's. A
//   Tokyo-zoned card returns the same instant whether the process runs with
//   TZ=Asia/Tokyo or TZ=America/Denver. Nothing in this file calls a local
//   Date getter: local time enters exactly once, through computerZone().
// ─────────────────────────────────────────────────────────────────────────────

/** The cadences a card can carry. 'daily' and 'weekly' collapsed into 'times' in migration048. */
export type ScheduleKind = 'every' | 'times' | 'once'

/** What computeNextRun needs off a card. Column names are snake_case in the DB; this is the shape both sides build. */
export interface ScheduleSpec {
  kind: string
  value: string
  /** Date.getDay() numbers as 'D,D,D', ascending and unique. null = every day. */
  days?: string | null
  /** 'HH:MM-HH:MM' on 'every' only. null = the whole day. end <= start means overnight. */
  window?: string | null
  /** IANA zone name. null = computer time (whatever this machine is set to right now). */
  tz?: string | null
  /** 'YYYY-MM-DD', inclusive, read in the card's zone. null = no end date. */
  until?: string | null
}

const MS_PER_MINUTE = 60_000
const MS_PER_DAY = 86_400_000

export const MIN_EVERY_MINUTES = 1
/**
 * 1439 minutes, one minute short of a day, and NOT one week.
 *
 * The grid restarts at every window opening, so a cadence longer than its window fires
 * exactly once per opening. With no window the window is 00:00 to 23:59, which makes 1439
 * the longest cadence that can still fire twice in a day. Accepting 10080 and calling it
 * "every 7 days" stored a number with no meaning and a promise that was never kept: it
 * fired every night at midnight. Anything a day or longer is "at times" with a days
 * filter, which says what it does.
 */
export const MAX_EVERY_MINUTES = 1439
/** More than this many times on one card is a list nobody can read, and a form nobody can fill. */
export const MAX_TIMES_PER_DAY = 24

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const ONCE_RE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/

// ── Zone arithmetic ─────────────────────────────────────────────────────────
// Built on Intl.DateTimeFormat offset probing so there is no dependency to keep
// current with the tz database: the one the JS engine already ships is the one used.

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(zone)
  if (!f) {
    // hourCycle 'h23' rather than hour12:false: the latter still returns "24" for
    // midnight on some engines, which would push the computed offset a day out.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formatterCache.set(zone, f)
  }
  return f
}

/**
 * What each zone is CALLED on screen. "America/Los_Angeles" is a database key with a slash
 * and an underscore in it, and the reader is a founder picking where a routine should
 * run, not somebody who has met the tz database. The stored value is always the IANA name;
 * only the label changes.
 */
export const TIMEZONE_LABELS: Record<string, string> = {
  'America/Los_Angeles': 'Los Angeles',
  'America/Denver': 'Denver',
  'America/Chicago': 'Chicago',
  'America/New_York': 'New York',
  'America/Sao_Paulo': 'Sao Paulo',
  'UTC': 'UTC',
  'Europe/London': 'London',
  'Europe/Lisbon': 'Lisbon',
  'Europe/Madrid': 'Madrid',
  'Europe/Paris': 'Paris',
  'Europe/Berlin': 'Berlin',
  'Europe/Athens': 'Athens',
  'Africa/Johannesburg': 'Johannesburg',
  'Asia/Dubai': 'Dubai',
  'Asia/Kolkata': 'India',
  'Asia/Singapore': 'Singapore',
  'Asia/Tokyo': 'Tokyo',
  'Australia/Sydney': 'Sydney',
  'Pacific/Auckland': 'Auckland',
}

/**
 * A zone as a place name. Falls back to the last segment of the IANA name with its
 * underscores opened up, so a zone that is not on the short list still reads as a city
 * ("Asia/Kathmandu" becomes "Kathmandu") rather than as a path.
 */
export function zoneLabel(zone: string): string {
  const known = TIMEZONE_LABELS[zone]
  if (known) return known
  const tail = zone.split('/').pop() ?? zone
  return tail.replace(/_/g, ' ')
}

/**
 * The zones offered in the modal's dropdown, on top of "Computer time" and whatever the
 * card already carries. A short list on purpose: the full IANA database is 400 entries of
 * which nobody wants to scroll past Antarctica/Vostok, and a card can still hold any valid
 * name that arrives from the API. Ordered roughly west to east.
 */
export const COMMON_TIMEZONES: readonly string[] = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'UTC',
  'Europe/London',
  'Europe/Lisbon',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Athens',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
]

/** The zone this computer is set to, read fresh every time. A laptop that flies abroad follows it. */
export function computerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** True when the engine recognises the name, so a typo cannot silently become UTC. */
export function isValidZone(zone: string): boolean {
  if (!zone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export interface ZoneParts {
  year: number
  month: number // 1..12
  day: number
  hour: number
  minute: number
  second: number
}

function partsInZone(ts: number, zone: string): ZoneParts {
  const parts = formatterFor(zone).formatToParts(new Date(ts))
  const read = (type: string): number => {
    const p = parts.find(x => x.type === type)
    return p ? Number(p.value) : 0
  }
  return {
    year: read('year'), month: read('month'), day: read('day'),
    hour: read('hour'), minute: read('minute'), second: read('second'),
  }
}

/**
 * How far the zone is ahead of UTC at this instant, in ms. Positive east of Greenwich.
 * Derived by formatting the instant in the zone and reading the result back as if it
 * were UTC: the difference IS the offset, including whichever side of a DST change
 * the instant falls on.
 */
function zoneOffsetMs(ts: number, zone: string): number {
  const p = partsInZone(ts, zone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(ts / 1000) * 1000
}

/** A civil date with no time and no zone: the thing a day filter and an until date are about. */
export interface CivilDay {
  year: number
  month: number // 1..12
  day: number
}

/** The calendar day `ts` falls on, as read by a clock in `zone`. */
export function civilDayInZone(ts: number, zone: string): CivilDay {
  const p = partsInZone(ts, zone)
  return { year: p.year, month: p.month, day: p.day }
}

/** The same civil day, `offset` days later (or earlier). Month and year roll correctly. */
export function addDays(day: CivilDay, offset: number): CivilDay {
  const t = Date.UTC(day.year, day.month - 1, day.day) + offset * MS_PER_DAY
  const d = new Date(t)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** Date.getDay() convention: 0 = Sunday. Computed from the civil date, never from local time. */
export function weekdayOf(day: CivilDay): number {
  return new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay()
}

/** -1, 0 or 1, comparing two civil days. */
export function compareDays(a: CivilDay, b: CivilDay): number {
  if (a.year !== b.year) return a.year < b.year ? -1 : 1
  if (a.month !== b.month) return a.month < b.month ? -1 : 1
  if (a.day !== b.day) return a.day < b.day ? -1 : 1
  return 0
}

/**
 * The EXACT instant a zone's UTC offset changes, between two instants whose offsets are
 * known to differ. Bisected to the millisecond rather than to the second: this is the
 * value a routine inside a spring-forward gap fires at, and a slot carrying 438 stray
 * milliseconds is a slot that does not equal the one the preview computed. About 28
 * probes, and only ever on the rare gap path.
 */
function findTransition(lo: number, hi: number, zone: string, loOffset: number): number {
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (zoneOffsetMs(mid, zone) === loOffset) lo = mid
    else hi = mid
  }
  return hi
}

/**
 * Turn a wall-clock reading in a zone into an instant.
 *
 * Two DST cases, both deliberate and both table-tested on Europe/London:
 *
 *   Spring forward, the GAP. 01:30 on 2026-03-29 does not exist in London: the clocks
 *   jump 01:00 to 02:00. Neither candidate offset round-trips, so the answer is the
 *   first instant AFTER the gap, i.e. the transition itself (02:00 BST). A routine set
 *   for 01:30 fires once, at the moment 01:30 would have been reached.
 *
 *   Fall back, the OVERLAP. 01:30 on 2026-10-25 happens twice in London. Both
 *   candidates round-trip, and the FIRST one wins, so the routine fires once, on the
 *   earlier pass. Taking the later one instead would delay it an hour with nothing on
 *   screen explaining why.
 */
export function wallToEpoch(day: CivilDay, hour: number, minute: number, zone: string): number {
  // The wall reading, held as if it were UTC. Subtracting the true offset gives the instant.
  const asIfUtc = Date.UTC(day.year, day.month - 1, day.day, hour, minute, 0, 0)
  const offsetBefore = zoneOffsetMs(asIfUtc - MS_PER_DAY, zone)
  const offsetAfter = zoneOffsetMs(asIfUtc + MS_PER_DAY, zone)

  const candidates = offsetBefore === offsetAfter
    ? [asIfUtc - offsetBefore]
    : [asIfUtc - offsetBefore, asIfUtc - offsetAfter]
  // A candidate is real only when the zone actually reads that wall time at it.
  const valid = candidates.filter(c => zoneOffsetMs(c, zone) === asIfUtc - c)

  if (valid.length > 0) return Math.min(...valid)
  // Neither round-trips: the wall time is inside a spring-forward gap. The first
  // instant after the gap is the transition.
  return findTransition(asIfUtc - MS_PER_DAY, asIfUtc + MS_PER_DAY, zone, offsetBefore)
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/** 'HH:MM' -> [hour, minute], or null. Strict: a single-digit hour is not accepted here. */
export function parseClock(value: string): [number, number] | null {
  const m = CLOCK_RE.exec(value)
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** '0,2,3' -> [0,2,3]. null/'' -> every day. Returns null when the list is malformed or empty. */
export function parseDays(value: string | null | undefined): number[] | null {
  if (value == null || value === '') return [0, 1, 2, 3, 4, 5, 6]
  if (!/^[0-6](,[0-6])*$/.test(value)) return null
  const days = value.split(',').map(Number)
  for (let i = 1; i < days.length; i++) if (days[i] <= days[i - 1]) return null
  return days
}

/** De-duplicate, sort and join a day list into the canonical stored form. '' when nothing survives. */
export function formatDays(days: Iterable<number>): string {
  const clean = [...new Set([...days].filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
  return clean.join(',')
}

export interface ParsedWindow {
  startHour: number
  startMinute: number
  endHour: number
  endMinute: number
  /** end <= start: the window closes on the following day. */
  overnight: boolean
}

/**
 * How many minutes a window stays open, counting the end minute itself. An overnight
 * window wraps, so 22:00 to 06:00 is 480 minutes and not a negative number.
 *
 * This is what decides whether a cadence can fit inside its window more than once, which
 * is the difference between "every 5 hours" and "once a day at 11:00". See describeSchedule.
 */
export function windowLengthMinutes(value: string | null | undefined): number | null {
  const win = parseWindow(value)
  if (!win) return null
  const startMin = win.startHour * 60 + win.startMinute
  const endMin = win.endHour * 60 + win.endMinute
  return win.overnight ? (1440 - startMin) + endMin : endMin - startMin
}

/**
 * True when the cadence is too long to fit inside its window twice, so the card fires
 * exactly ONCE per opening, at the window open, however large the number is.
 *
 * This is a consequence of anchoring on the window open (D4) rather than on the last fire,
 * and it is a trap worth naming: "every 2 days" with no window has a 1439-minute window
 * (00:00 to 23:59), so it fires every day at midnight, not every other day. The pill and
 * the modal hint both say the EFFECT rather than the number, because a card that says
 * "every 2 days" and fires daily is a card nobody can trust again.
 */
export function firesOncePerOpening(spec: ScheduleSpec): boolean {
  if (spec.kind !== 'every') return false
  const minutes = Number(spec.value)
  const length = windowLengthMinutes(spec.window)
  if (!Number.isFinite(minutes) || length == null) return false
  return minutes > length
}

/** 'HH:MM-HH:MM' -> a window. null/'' is the whole day. Returns null when malformed. */
export function parseWindow(value: string | null | undefined): ParsedWindow | null {
  const raw = value == null || value === '' ? '00:00-23:59' : value
  const halves = raw.split('-')
  if (halves.length !== 2) return null
  const start = parseClock(halves[0])
  const end = parseClock(halves[1])
  if (!start || !end) return null
  const startMin = start[0] * 60 + start[1]
  const endMin = end[0] * 60 + end[1]
  return {
    startHour: start[0], startMinute: start[1],
    endHour: end[0], endMinute: end[1],
    overnight: endMin <= startMin,
  }
}

/** 'HH:MM,HH:MM' -> minutes-since-midnight, ascending and unique. null when malformed or empty. */
export function parseTimes(value: string): Array<[number, number]> | null {
  const raw = value.split(',').map(s => s.trim()).filter(Boolean)
  if (raw.length === 0 || raw.length > MAX_TIMES_PER_DAY) return null
  const out: Array<[number, number]> = []
  for (const item of raw) {
    const c = parseClock(item)
    if (!c) return null
    out.push(c)
  }
  out.sort((a, b) => (a[0] * 60 + a[1]) - (b[0] * 60 + b[1]))
  for (let i = 1; i < out.length; i++) {
    if (out[i][0] === out[i - 1][0] && out[i][1] === out[i - 1][1]) return null
  }
  return out
}

/** Normalise a typed time list into the stored form: sorted, zero-padded, comma separated. */
export function formatTimes(times: Iterable<string>): string {
  const parsed = parseTimes([...times].join(','))
  if (!parsed) return ''
  return parsed.map(([h, m]) => `${pad2(h)}:${pad2(m)}`).join(',')
}

/** 'YYYY-MM-DD' -> a civil day, rejecting calendar overflow ('2026-02-30'). null when malformed. */
export function parseUntil(value: string | null | undefined): CivilDay | null {
  if (value == null || value === '') return null
  const m = DATE_RE.exec(value)
  if (!m) return null
  const [y, mo, d] = m.slice(1).map(Number)
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
  return { year: y, month: mo, day: d }
}

/** 'YYYY-MM-DDTHH:MM' -> a civil day plus a clock, rejecting calendar overflow. */
export function parseOnce(value: string): { day: CivilDay; hour: number; minute: number } | null {
  const m = ONCE_RE.exec(value)
  if (!m) return null
  const day = parseUntil(`${m[1]}-${m[2]}-${m[3]}`)
  if (!day) return null
  return { day, hour: Number(m[4]), minute: Number(m[5]) }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Everything wrong with a schedule, as one sentence a non-coder can act on, or null.
 * The server validates with this and the modal disables Save with the same text, so a
 * schedule cannot be rejected for a reason the form never showed.
 */
export function validateScheduleSpec(spec: ScheduleSpec): string | null {
  const { kind } = spec
  if (kind == null || kind === '') {
    // Reached when a caller sends scheduleDays or scheduleWindow on a card that has no
    // schedule at all. "Unknown cadence undefined" is a stack trace with the words
    // rearranged; this says which field is missing and what to put in it.
    return 'This card has no schedule to change. Set how often it runs first: "every", "times" or "once".'
  }
  if (kind !== 'every' && kind !== 'times' && kind !== 'once') {
    return `"${kind}" is not a cadence. Use "every" (so many minutes), "times" (a list of clock times) or "once".`
  }

  if (spec.tz != null && spec.tz !== '' && !isValidZone(spec.tz)) {
    return `"${spec.tz}" is not a timezone this computer recognises.`
  }

  if (spec.days != null && spec.days !== '') {
    if (parseDays(spec.days) === null) {
      return 'Days must be a list like 1,3,5 with each day named once, in order (0 is Sunday).'
    }
  } else if (spec.days === '') {
    return 'Pick at least one day, or leave every day on.'
  }

  if (spec.until != null && spec.until !== '' && parseUntil(spec.until) === null) {
    return 'The end date must be a real calendar date, written as YYYY-MM-DD.'
  }

  if (kind === 'once') {
    if (parseOnce(spec.value) === null) {
      return 'A one-off needs a real date and time, written as YYYY-MM-DDTHH:MM.'
    }
    return null
  }

  if (kind === 'times') {
    if (spec.window != null && spec.window !== '') {
      return 'An active window only applies to "every N minutes". Remove it, or switch the cadence.'
    }
    if (parseTimes(spec.value) === null) {
      return `Times must be a list of clock times like 11:00, 19:00 - at least one, at most ${MAX_TIMES_PER_DAY}, none repeated.`
    }
    return null
  }

  // every
  const minutes = Number(spec.value)
  if (!Number.isFinite(minutes) || !Number.isInteger(minutes)) {
    return 'How often must be a whole number of minutes.'
  }
  if (minutes < MIN_EVERY_MINUTES) {
    return 'How often must be at least 1 minute.'
  }
  if (minutes > MAX_EVERY_MINUTES) {
    return 'How often cannot be a day or longer, because the schedule restarts each day. Use "at set times" with the days you want instead.'
  }
  if (spec.window != null && spec.window !== '') {
    const win = parseWindow(spec.window)
    if (win === null) return 'The active window must be two clock times, like 11:00 to 19:00.'
    // Equal start and end is the one window shape nobody means. It reads as "at 11:00",
    // and it silently became a 24-hour overnight window firing every cadence step around
    // the clock: 24 Claude processes a day from a card that looked like it asked for one.
    if (win.startHour === win.endHour && win.startMinute === win.endMinute) {
      return 'The active window starts and ends at the same time. For a single run at that time, use "at set times" instead.'
    }
  }
  return null
}

// ── The next run ────────────────────────────────────────────────────────────

/**
 * The next instant this schedule wants to fire, strictly after `now`. null when it
 * never will again (past its end date, or an invalid schedule).
 *
 * 'once' is the exception and returns its fixed instant even when that instant is in
 * the past, because a reminder delivered late still does its job and a reminder
 * dropped does not. The caller fires it on the next poll.
 */
export function computeNextRun(spec: ScheduleSpec, now: number = Date.now()): number | null {
  if (validateScheduleSpec(spec) !== null) return null
  const zone = spec.tz && spec.tz !== '' ? spec.tz : computerZone()
  const until = parseUntil(spec.until)

  if (spec.kind === 'once') {
    const once = parseOnce(spec.value)
    if (!once) return null
    return wallToEpoch(once.day, once.hour, once.minute, zone)
  }

  const days = parseDays(spec.days)
  if (!days) return null
  const today = civilDayInZone(now, zone)

  if (spec.kind === 'times') {
    const times = parseTimes(spec.value)
    if (!times) return null
    for (let offset = 0; offset <= 7; offset++) {
      const day = addDays(today, offset)
      if (until && compareDays(day, until) > 0) return null
      if (!days.includes(weekdayOf(day))) continue
      for (const [hh, mm] of times) {
        const candidate = wallToEpoch(day, hh, mm, zone)
        if (candidate > now) return candidate
      }
    }
    return null
  }

  // every
  const stepMs = Number(spec.value) * MS_PER_MINUTE
  const win = parseWindow(spec.window)
  if (!win) return null
  // offset -1 first: an overnight window that opened yesterday is still open now, and
  // the days filter is about the day the window OPENS, not the day a candidate lands on.
  for (let offset = -1; offset <= 7; offset++) {
    const day = addDays(today, offset)
    if (until && compareDays(day, until) > 0) return null
    if (!days.includes(weekdayOf(day))) continue
    const open = wallToEpoch(day, win.startHour, win.startMinute, zone)
    const closeDay = win.overnight ? addDays(day, 1) : day
    const close = wallToEpoch(closeDay, win.endHour, win.endMinute, zone) + MS_PER_MINUTE - 1
    // Window end is INCLUSIVE at the exact minute: "11:00 to 19:00, every 4 hours"
    // includes 19:00, which is what anybody reading that sentence expects.
    for (let candidate = open; candidate <= close; candidate += stepMs) {
      if (candidate > now) return candidate
    }
  }
  return null
}

/**
 * Is `now` inside one of this card's active windows?
 *
 * Asked by the catch-up rule: a missed slot on an 'every' card is only worth running late
 * while the card is still allowed to run at all, because the whole point of a window is
 * that it does not run outside it.
 *
 * This has to be answered DIRECTLY rather than inferred from the next candidate. The first
 * attempt asked "is the next run less than one cadence away?", which is false for the last
 * slot of any window whose close is not itself a slot: on the acceptance schedule (every 5
 * hours, 11:00 to 19:00) the slots are 11:00 and 16:00, so from 16:05 the next candidate is
 * TOMORROW at 11:00, and a 16:00 slot missed by five minutes was dropped with "the active
 * window has closed since" while the window had three more hours to run.
 *
 * Always true for a card with no window, on a day the days filter allows: the window is
 * then the whole day.
 *
 * A 'times' card goes through the same test, and the early return used to skip it. It cannot
 * carry a window (validation refuses one), so its window IS the whole day, but it can carry a
 * DAYS filter and this gate is the only place a late run is ever measured against one. Two
 * cards set to the same weekdays got opposite answers: a missed Friday 23:30 slot on an
 * 'every' card was refused on Saturday morning and on a 'times' card was run, on a day the
 * user had switched the card off for. computeNextRun would have told either of them Saturday
 * was off; only this function disagreed. 'once' still returns early, because a one-off has no
 * days and a reminder delivered late still does its job.
 *
 * THE CLOSE IS INCLUSIVE THROUGH THE END OF ITS MINUTE, not at its first instant. Everything
 * else in this engine works at minute precision, slots are minute-aligned and windows are
 * written HH:MM, but `now` is a millisecond clock. Comparing the two directly meant a card
 * with NO window, whose default window is 00:00 to 23:59, was outside its own hours for the
 * last 59 seconds of every day: a run missed and evaluated in that sliver was skipped with
 * "the hours this card is allowed to run in have closed since", on a card that has no hours
 * restriction at all.
 */
export function isInsideActiveWindow(spec: ScheduleSpec, now: number = Date.now()): boolean {
  if (spec.kind === 'once') return true
  const zone = spec.tz && spec.tz !== '' ? spec.tz : computerZone()
  const days = parseDays(spec.days)
  if (!days) return false
  const today = civilDayInZone(now, zone)

  // NO WINDOW MEANS NO WINDOW, not a window that runs 00:00 to 23:59.
  //
  // Borrowing parseWindow's whole-day default was convenient and wrong, because a synthetic
  // close is still a close and it can be landed on the wrong side of. wallToEpoch resolves an
  // ambiguous wall time to its FIRST pass, so in a zone that puts its clocks back at MIDNIGHT
  // the hour 23:00 to 23:59 happens twice and the synthetic close lands in the first pass:
  // the entire repeated hour sits after it. A card that was never given any hours was then
  // told, for a full hour once a year in Santiago, Asuncion and Godthab, that its hours had
  // closed. The 59-second version of this same mistake was fixed by widening the close; this
  // one is sixty times wider and widening will not reach it.
  //
  // A 'times' card takes this path too, always: validation refuses it a window, so the only
  // thing this function has to decide for it is whether today is a day it is allowed to run.

  if (spec.window == null || spec.window === '') return days.includes(weekdayOf(today))

  const win = parseWindow(spec.window)
  if (!win) return false
  // -1 as well as 0: an overnight window that opened yesterday is still open now, and the
  // days filter is about the day it OPENED.
  for (let offset = -1; offset <= 0; offset++) {
    const day = addDays(today, offset)
    if (!days.includes(weekdayOf(day))) continue
    const open = wallToEpoch(day, win.startHour, win.startMinute, zone)
    const closeDay = win.overnight ? addDays(day, 1) : day
    const close = wallToEpoch(closeDay, win.endHour, win.endMinute, zone) + MS_PER_MINUTE - 1
    if (now >= open && now <= close) return true
  }
  return false
}

/**
 * The next `count` runs, each computed from the one before it by the SAME function the
 * scheduler calls. Stops early when the schedule ends. This is what the modal previews,
 * so the preview cannot drift from the engine: there is no second implementation to drift.
 */
export function nextRuns(spec: ScheduleSpec, count = 5, now: number = Date.now()): number[] {
  const out: number[] = []
  let cursor = now
  for (let i = 0; i < count; i++) {
    const next = computeNextRun(spec, cursor)
    if (next == null) break
    out.push(next)
    // A 'once' has exactly one run, and it can be in the past, so stepping from it
    // would loop forever on the same instant.
    if (spec.kind === 'once') break
    cursor = next
  }
  return out
}

// ── How a schedule reads on screen ──────────────────────────────────────────
// Every string below is a sentence, not a spec. No cron, no abbreviations that need
// decoding, units spelled out. The board pill, the modal and the hover title all read
// from here, so a routine never describes itself two different ways.

/** Indexed by Date.getDay(): 0 = Sunday. */
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
/** Monday first, Sunday last: how a week is read, not how Date.getDay() numbers it. */
export const DAY_DISPLAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0]

/** "every 5 hours", "every 30 minutes", "every 2 days". */
export function describeEvery(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return `every ${minutes} minutes`
  if (minutes < 60) return `every ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  if (minutes % 1440 === 0) {
    const days = minutes / 1440
    return days === 1 ? 'every day' : `every ${days} days`
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return `every ${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }
  return `every ${minutes} minutes`
}

/** "on Tue, Wed, Thu, Fri, Sun", "on weekdays", or '' when every day is on. */
export function describeDays(days: string | null | undefined): string {
  const parsed = parseDays(days)
  if (!parsed || parsed.length === 7) return ''
  const set = new Set(parsed)
  if (parsed.length === 5 && [1, 2, 3, 4, 5].every(d => set.has(d))) return 'on weekdays'
  if (parsed.length === 2 && set.has(0) && set.has(6)) return 'at weekends'
  if (parsed.length === 1) return `every ${DAY_LONG[parsed[0]]}`
  return `on ${DAY_DISPLAY_ORDER.filter(d => set.has(d)).map(d => DAY_SHORT[d]).join(', ')}`
}

/** "at 11:00 and 19:00", "at 09:00", "at 08:00, 12:00 and 18:00". */
export function describeTimes(value: string): string {
  const times = parseTimes(value)
  if (!times) return `at ${value}`
  const clocks = times.map(([h, m]) => `${pad2(h)}:${pad2(m)}`)
  if (clocks.length === 1) return `at ${clocks[0]}`
  return `at ${clocks.slice(0, -1).join(', ')} and ${clocks[clocks.length - 1]}`
}

/** "11:00 to 19:00", "22:00 to 06:00 overnight", or '' for the whole day. */
export function describeWindow(value: string | null | undefined): string {
  if (value == null || value === '') return ''
  const win = parseWindow(value)
  if (!win) return value
  const text = `${pad2(win.startHour)}:${pad2(win.startMinute)} to ${pad2(win.endHour)}:${pad2(win.endMinute)}`
  return win.overnight ? `${text} overnight` : text
}

/** "11:35 on Fri 7 Aug". Rendered in a NAMED zone, so it never borrows the process's own. */
export function formatInZone(ts: number, zone: string, opts: { withYear?: boolean } = {}): string {
  const p = partsInZone(ts, zone)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const weekday = DAY_SHORT[weekdayOf({ year: p.year, month: p.month, day: p.day })]
  const base = `${pad2(p.hour)}:${pad2(p.minute)} on ${weekday} ${p.day} ${months[p.month - 1]}`
  return opts.withYear ? `${base} ${p.year}` : base
}

/**
 * The one-line sentence for a schedule: "every 5 hours, 11:00 to 19:00, on Tue, Wed,
 * Thu, Fri, Sun". The zone is named only when it differs from this computer's, because
 * naming it always turns every ordinary routine into a line with jargon on the end.
 */
export function describeSchedule(spec: ScheduleSpec, opts: { computerZone?: string } = {}): string {
  const here = opts.computerZone ?? computerZone()
  const parts: string[] = []

  if (spec.kind === 'once') {
    const once = parseOnce(spec.value)
    const zone = spec.tz && spec.tz !== '' ? spec.tz : here
    if (!once) return spec.value
    const at = formatInZone(wallToEpoch(once.day, once.hour, once.minute, zone), zone)
    return `once, ${at}${zone === here ? '' : ` (${zoneLabel(zone)} time)`}`
  }

  if (spec.kind === 'times') {
    parts.push(describeTimes(spec.value))
  } else if (firesOncePerOpening(spec)) {
    // THE CADENCE DOES NOT FIT ITS WINDOW, so the card fires exactly once per opening
    // however large the number is. Say what it DOES, never what the number says: a pill
    // reading "every 7 days" on a card that fires every night at midnight is worse than
    // no pill at all, because it is believed.
    const win = parseWindow(spec.window)
    const openAt = win ? `${pad2(win.startHour)}:${pad2(win.startMinute)}` : '00:00'
    parts.push(`at ${openAt}`)
  } else {
    parts.push(describeEvery(Number(spec.value)))
    const win = describeWindow(spec.window)
    if (win) parts.push(win)
  }

  const days = describeDays(spec.days)
  if (days) parts.push(days)

  const zone = spec.tz && spec.tz !== '' ? spec.tz : null
  let text = parts.join(', ')
  if (zone && zone !== here) text += ` (${zoneLabel(zone)} time)`
  const until = parseUntil(spec.until)
  if (until) text += `, until ${formatInZone(wallToEpoch(until, 12, 0, zone ?? here), zone ?? here, { withYear: true }).replace(/^\d{2}:\d{2} on /, '')}`
  return text
}
