import { useState, useCallback, useMemo, useEffect, useRef, useImperativeHandle } from 'react'
import type { PipelineTask, TaskScheduleKind, EffortLevel, PermissionMode } from '@shared/types'
import { WEEKDAY_ORDER, WEEKDAY_SHORT, parseOnceValue } from '@shared/routine-schedule'
import {
  nextRuns, parseTimes, parseDays, formatTimes, computerZone, formatInZone,
  describeSchedule, validateScheduleSpec, windowLengthMinutes, describeEvery,
  COMMON_TIMEZONES, zoneLabel,
  type ScheduleSpec,
} from '@shared/schedule-next'
import { useInstances } from '../../context/InstancesContext'
import { MODELS, EFFORT_LEVELS, CARD_PERMISSION_MODES } from '../../utils/modelOptions'

// ─────────────────────────────────────────────────────────────────────────────
// EVERY SETTING A CARD CARRIES, IN ONE COMPONENT, MOUNTED IN BOTH PLACES.
//
// This used to live inside CreateTaskModal, which meant the only way to reach a saved
// card's model or its schedule was to open the detail panel and then open a SECOND dialog
// on top of it. Worse, that second dialog was handed the board's lightweight copy of the
// card, where the run settings are not present at all: every field read as unset, and
// saving wrote those unset values back over the real ones.
//
// So the fields moved here, and both surfaces mount them: the create modal, and the task
// detail panel inline. The panel is now the whole story of a card in one scroll.
//
// The parent owns the Save button and asks for a payload through the ref, rather than
// holding forty pieces of state it does not otherwise care about.
// ─────────────────────────────────────────────────────────────────────────────

type WhenMode = 'now' | 'once' | 'repeating'
/** Two cadences that compose, where there used to be three that did not. */
type RepeatKind = 'every' | 'times'

/**
 * Minutes and hours, and deliberately NOT days.
 *
 * "Every N" is anchored on the active window open and the grid restarts at every opening,
 * so with no window the longest cadence that can fire twice in a day is 1439 minutes. Offer
 * a "days" unit and "every 7 days" silently becomes every night at midnight: seven times the
 * fires and seven times the spend, with the card still claiming it runs weekly. Anything a
 * day or longer is "At set times" with the Days filter, which says what it does.
 */
type EveryUnit = 'minutes' | 'hours'

/** How a repeating card stops: never on its own, on a date, or after a count. */
type EndMode = 'never' | 'until' | 'after'

/** How many minutes one of each unit is. The row always stores minutes. */
const UNIT_MINUTES: Record<EveryUnit, number> = { minutes: 1, hours: 60 }

/** The longest cadence that can fire more than once inside a full day, 00:00 to 23:59. */
const MAX_EVERY_IN_A_DAY = 1439

const pad2 = (n: number) => String(n).padStart(2, '0')

/** `datetime-local` wants 'YYYY-MM-DDTHH:MM' in local time, which toISOString will not give. */
function toLocalDateTimeValue(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** The stored day list, or null for "every day". A malformed value reads as every day. */
function parseDaysList(value: string | null | undefined): number[] | null {
  if (value == null || value === '') return null
  const parsed = parseDays(value)
  return parsed && parsed.length < 7 ? parsed : null
}

/** 'HH:MM-HH:MM' -> the two halves, or null when there is no window. */
function parseWindowValue(value: string | null | undefined): [string, string] | null {
  if (value == null || value === '') return null
  const halves = value.split('-')
  return halves.length === 2 ? [halves[0], halves[1]] : null
}

/**
 * The time to pre-fill when "Add another time" is clicked: an hour after the latest one
 * already in the list, wrapping at midnight. Appending a constant meant the second click
 * added a duplicate and the form immediately showed an error the user had not caused.
 */
function nextFreeTime(existing: string[]): string {
  const minutes = existing
    .map(t => { const c = /^(\d{2}):(\d{2})$/.exec(t); return c ? Number(c[1]) * 60 + Number(c[2]) : null })
    .filter((m): m is number => m != null)
  const latest = minutes.length > 0 ? Math.max(...minutes) : 11 * 60
  const next = (latest + 60) % 1440
  return `${pad2(Math.floor(next / 60))}:${pad2(next % 60)}`
}

/**
 * The schedule half of the payload. `scheduleKind: null` is what clears a schedule, and
 * it has to be SENT rather than omitted: an omitted field leaves the column alone, which
 * on an edit would silently keep a schedule the user just switched back to Now.
 */
interface SchedulePayload {
  scheduleKind: TaskScheduleKind | null
  scheduleValue: string | null
  scheduleEnabled: boolean
  scheduleDays: string | null
  scheduleWindow: string | null
  scheduleTz: string | null
  scheduleUntil: string | null
  scheduleMaxRuns: number | null
  catchupPolicy: 'late' | 'skip'
}

/**
 * The schedule AND the run settings, which is everything on a card that is neither its
 * identity nor its place on the board.
 *
 * Every run setting is sent on every save, null included, because null is a value here:
 * it means "inherit the app default". That is also why the form must never be mounted
 * against a card whose settings were not loaded — see `task` below.
 */
export interface TaskSettingsPayload extends SchedulePayload {
  targetInstanceId: string | null
  silent: boolean
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
  maxBudgetUsd: number | null
  budgetCapUsd: number | null
  autoCompact: boolean
  autoClose: boolean
  maxRunMinutes: number | null
  disarmAfterFailures: number
  fallbackModel: string | null
  outputStyle: string | null
  language: string | null
}

export interface TaskSettingsHandle {
  /** The settings half of a save body, or the first thing wrong with it. */
  build: () => TaskSettingsPayload | { error: string }
}

interface TaskSettingsProps {
  ref?: React.Ref<TaskSettingsHandle>
  /**
   * The card being edited, or undefined when creating one.
   *
   * MUST be the full row, not the board's lightweight copy. The light list omits every
   * run setting, so mounting against one reads model, effort, permissions and the rest
   * as unset and the next save writes those blanks back. Callers load the card with
   * rest.getTask first.
   */
  task?: PipelineTask
  /** The project the card will live in. Drives the target-chat list. */
  projectId: string
  /** Fired when the user changes something, so the parent can enable its Save button. */
  onDirty?: () => void
}

export function TaskSettings({ ref, task, projectId, onDirty }: TaskSettingsProps) {
  const { folders, instances } = useInstances()
  const editing = !!task

  // ── When ──────────────────────────────────────────────────────────────────
  const [when, setWhen] = useState<WhenMode>(
    !task?.scheduleKind ? 'now' : task.scheduleKind === 'once' ? 'once' : 'repeating'
  )
  const [repeatKind, setRepeatKind] = useState<RepeatKind>(
    task?.scheduleKind === 'times' ? 'times' : 'every'
  )
  // "Every N" is stored in minutes and shown in whatever unit reads best: 300 minutes is
  // "5 hours" on screen and "300" in the row. A number nobody has to divide in their head.
  const initialEveryMinutes = task?.scheduleKind === 'every' ? Number(task.scheduleValue || '60') : 60
  const initialUnit: EveryUnit = initialEveryMinutes % 60 === 0 ? 'hours' : 'minutes'
  const [everyUnit, setEveryUnit] = useState<EveryUnit>(initialUnit)
  const [everyCount, setEveryCount] = useState(String(initialEveryMinutes / UNIT_MINUTES[initialUnit]))

  const initialTimes = task?.scheduleKind === 'times' ? parseTimes(task.scheduleValue || '') : null
  const [times, setTimes] = useState<string[]>(
    initialTimes ? initialTimes.map(([h, m]) => `${pad2(h)}:${pad2(m)}`) : ['09:00']
  )

  // Days. An empty selection is not a state the form can reach: "every day" is its own
  // toggle, so a day list is either off entirely or has at least one day in it.
  const initialDays = parseDaysList(task?.scheduleDays)
  const [everyDay, setEveryDay] = useState(initialDays === null)
  const [days, setDays] = useState<number[]>(initialDays ?? [1, 2, 3, 4, 5])

  const initialWindow = parseWindowValue(task?.scheduleWindow)
  const [windowOn, setWindowOn] = useState(initialWindow !== null)
  const [windowStart, setWindowStart] = useState(initialWindow?.[0] ?? '09:00')
  const [windowEnd, setWindowEnd] = useState(initialWindow?.[1] ?? '17:00')

  // '' is COMPUTER TIME, and computer time is the default: a routine follows the laptop
  // rather than being pinned to the zone it happened to be created in.
  const [timezone, setTimezone] = useState(task?.scheduleTz || '')

  const [onceAt, setOnceAt] = useState(
    task?.scheduleKind === 'once' && task.scheduleValue
      ? task.scheduleValue
      : toLocalDateTimeValue(Date.now() + 60 * 60 * 1000)
  )
  const [scheduleEnabled, setScheduleEnabled] = useState(task?.scheduleEnabled ?? true)

  // ── Run settings. Empty string means UNSET, which means inherit the app default. ──
  const [model, setModel] = useState(task?.model || '')
  const [effort, setEffort] = useState(task?.effort || '')
  const [permissionMode, setPermissionMode] = useState(task?.permissionMode || '')

  // ── Ends. Null on both means "runs until I switch it off", which is the default. ──
  const [endMode, setEndMode] = useState<EndMode>(
    task?.scheduleUntil ? 'until' : task?.scheduleMaxRuns != null ? 'after' : 'never'
  )
  const [untilDate, setUntilDate] = useState(task?.scheduleUntil || '')
  const [maxRuns, setMaxRuns] = useState(task?.scheduleMaxRuns != null ? String(task.scheduleMaxRuns) : '10')
  const [catchupPolicy, setCatchupPolicy] = useState<'late' | 'skip'>(task?.catchupPolicy === 'skip' ? 'skip' : 'late')

  // ── Advanced ──────────────────────────────────────────────────────────────
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [maxRunMinutes, setMaxRunMinutes] = useState(task?.maxRunMinutes != null ? String(task.maxRunMinutes) : '')
  const [disarmAfterFailures, setDisarmAfterFailures] = useState(String(task?.disarmAfterFailures ?? 3))
  const [maxBudgetUsd, setMaxBudgetUsd] = useState(task?.maxBudgetUsd != null ? String(task.maxBudgetUsd) : '')
  // Empty, not zero, and empty means no cap at all. A card saved without opening Advanced
  // must reach the database with budget_cap_usd NULL: a default of 0 would read as "a cap of
  // nothing" and switch every new card off on its first run.
  const [budgetCapUsd, setBudgetCapUsd] = useState(task?.budgetCapUsd != null ? String(task.budgetCapUsd) : '')
  const [autoCompact, setAutoCompact] = useState(task?.autoCompact ?? false)
  const [autoClose, setAutoClose] = useState(task?.autoClose ?? false)
  const [fallbackModel, setFallbackModel] = useState(task?.fallbackModel || '')
  const [outputStyle, setOutputStyle] = useState(task?.outputStyle || '')
  const [language, setLanguage] = useState(task?.language || '')
  const [silent, setSilent] = useState(task?.silent ?? false)
  const [targetInstanceId, setTargetInstanceId] = useState(task?.targetInstanceId || '')

  const projectChats = useMemo(
    () => instances.filter(i => i.folderId === projectId),
    [instances, projectId]
  )

  // Retargeting the card at another project makes its pinned chat meaningless: that chat
  // lives in the project the card just left. Cleared on the CHANGE, not on the first
  // render, or editing a card would drop the pin it arrived with.
  const firstProjectRef = useRef(projectId)
  useEffect(() => {
    if (firstProjectRef.current === projectId) return
    firstProjectRef.current = projectId
    setTargetInstanceId('')
  }, [projectId])

  const buildSchedule = useCallback((): SchedulePayload | { error: string } => {
    const cleared: SchedulePayload = {
      scheduleKind: null, scheduleValue: null, scheduleEnabled: false,
      scheduleDays: null, scheduleWindow: null, scheduleTz: null,
      scheduleUntil: null, scheduleMaxRuns: null, catchupPolicy: 'late',
    }
    if (when === 'now') return cleared
    if (when === 'once') {
      if (!parseOnceValue(onceAt)) return { error: 'Pick a date and time' }
      // scheduleTz stays NULL, deliberately. The Timezone control only renders for a
      // repeating card, and the once field is labelled "local", so carrying a zone over
      // from a schedule the card used to have would fire the reminder at a wall time the
      // form never showed. A one-off means local, and says so.
      return { ...cleared, scheduleKind: 'once', scheduleValue: onceAt, scheduleEnabled }
    }

    // Days are stored ascending and unique, so sort here rather than relying on the order
    // the chips happened to be clicked in.
    const dayList = everyDay ? null : [...days].sort((a, b) => a - b).join(',')
    if (!everyDay && days.length === 0) return { error: 'Pick at least one day, or switch Days back to every day.' }

    let value: string
    let windowValue: string | null = null
    if (repeatKind === 'every') {
      const count = Number(everyCount)
      if (!Number.isInteger(count) || count <= 0) return { error: 'How often must be a whole number bigger than zero.' }
      const minutes = count * UNIT_MINUTES[everyUnit]
      // The grid restarts at every window opening, so a cadence longer than a day can only
      // ever fire once a day. Saying no here, with the alternative named, beats saving a
      // card that claims to run weekly and runs nightly.
      if (minutes > MAX_EVERY_IN_A_DAY) {
        return { error: 'A repeat is counted within one day, so the longest it can be is 23 hours 59 minutes. To run once a day or less often, use "At set times" and tick the days.' }
      }
      value = String(minutes)
      windowValue = windowOn ? `${windowStart}-${windowEnd}` : null
    } else {
      value = formatTimes(times)
      if (!value) return { error: 'Add at least one time, and do not repeat one.' }
    }

    const spec: ScheduleSpec = {
      kind: repeatKind, value, days: dayList, window: windowValue, tz: timezone || null,
    }
    // Validate with the SAME function the server validates with, so Save cannot be
    // rejected for a reason the form never showed.
    const err = validateScheduleSpec(spec)
    if (err) return { error: err }

    // The end condition. Only ONE of the two can be set, because the switch is a switch:
    // a card that ends both on a date and after a count is two rules to reason about and
    // nobody asked for it.
    let until: string | null = null
    let runs: number | null = null
    if (endMode === 'until') {
      if (!untilDate) return { error: 'Pick the date it should stop on, or set Ends back to never.' }
      until = untilDate
    } else if (endMode === 'after') {
      const n = Number(maxRuns)
      if (!Number.isInteger(n) || n < 1) return { error: 'Stop after a whole number of runs, at least one.' }
      runs = n
    }

    return {
      scheduleKind: repeatKind,
      scheduleValue: value,
      scheduleEnabled,
      scheduleDays: dayList,
      scheduleWindow: windowValue,
      scheduleTz: timezone || null,
      scheduleUntil: until,
      scheduleMaxRuns: runs,
      catchupPolicy,
    }
  }, [when, repeatKind, onceAt, everyCount, everyUnit, times, everyDay, days, windowOn, windowStart, windowEnd, timezone, scheduleEnabled, endMode, untilDate, maxRuns, catchupPolicy])

  const build = useCallback((): TaskSettingsPayload | { error: string } => {
    const schedule = buildSchedule()
    if ('error' in schedule) return schedule

    const budget = maxBudgetUsd.trim() ? Number(maxBudgetUsd) : null
    if (budget != null && (!Number.isFinite(budget) || budget <= 0)) {
      return { error: 'Budget cap must be a positive number of dollars' }
    }
    const weekly = budgetCapUsd.trim() ? Number(budgetCapUsd) : null
    // A floor of one cent, not just "greater than zero". A cap of $0.000000001 is accepted by
    // the column and reads as "$0.0000" everywhere it is shown, which is a limit nobody can
    // see and the scheduler's own rounding slack is larger than.
    if (weekly != null && (!Number.isFinite(weekly) || weekly < 0.01)) {
      return { error: 'The weekly spending limit must be at least $0.01, or empty for no limit' }
    }

    // An empty string is UNSET, and unset means inherit the app-wide default. It is sent as
    // null rather than omitted so that clearing a setting on an edit actually clears it.
    return {
      ...schedule,
      targetInstanceId: targetInstanceId || null,
      silent,
      model: model || null,
      effort: (effort || null) as EffortLevel | null,
      permissionMode: (permissionMode || null) as PermissionMode | null,
      maxBudgetUsd: budget,
      budgetCapUsd: weekly,
      autoCompact,
      autoClose,
      maxRunMinutes: maxRunMinutes.trim() ? Number(maxRunMinutes) : null,
      disarmAfterFailures: disarmAfterFailures.trim() === '' ? 3 : Number(disarmAfterFailures),
      fallbackModel: fallbackModel || null,
      outputStyle: outputStyle || null,
      language: language || null,
    }
  }, [
    buildSchedule, targetInstanceId, silent, model, effort, permissionMode, maxBudgetUsd,
    budgetCapUsd, autoCompact, autoClose, maxRunMinutes, disarmAfterFailures,
    fallbackModel, outputStyle, language,
  ])

  useImperativeHandle(ref, () => ({ build }), [build])

  // ── The next 5 runs ───────────────────────────────────────────────────────
  // Computed by the SAME function the scheduler fires on, from the fields as they are
  // right now. A preview built by a second implementation is a list of times that never
  // happen, and nobody finds out until the routine has been firing at the wrong hour for
  // a week. Rendered in computer time; the card's zone is named when it differs.
  const here = computerZone()
  const preview = useMemo(() => {
    if (when === 'now') return null
    const built = buildSchedule()
    if ('error' in built) return { error: built.error, runs: [] as string[], text: '' }
    const spec: ScheduleSpec = {
      kind: built.scheduleKind as string,
      value: built.scheduleValue as string,
      days: built.scheduleDays,
      window: built.scheduleWindow,
      tz: built.scheduleTz,
      until: built.scheduleUntil,
    }
    return {
      error: null as string | null,
      runs: nextRuns(spec, 5, Date.now()).map(ts => formatInZone(ts, here)),
      text: describeSchedule(spec, { computerZone: here }),
    }
  }, [when, buildSchedule, here])

  /**
   * The whole day's fire times, listed, for a cadence with no hours limit.
   *
   * "Every 5 hours" counted from midnight is 00:00, 05:00, 10:00, 15:00, 20:00, and then
   * four hours to midnight rather than five. Describing that in words ("anchored on
   * midnight") explains nothing to the person it surprises. Showing the times does.
   */
  const midnightGridNote = useMemo(() => {
    if (windowOn) return ''
    const minutes = Number(everyCount) * UNIT_MINUTES[everyUnit]
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > MAX_EVERY_IN_A_DAY) return ''
    const slots: string[] = []
    for (let m = 0; m <= 1439 && slots.length <= 8; m += minutes) {
      slots.push(`${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`)
    }
    const shown = slots.length > 8 ? `${slots.slice(0, 8).join(', ')} and so on` : slots.join(', ')
    const last = slots.length > 0 ? slots[slots.length - 1] : '00:00'
    const tail = slots.length > 8
      ? 'The count starts again at midnight each day.'
      : `Then it starts again at midnight, so the gap from ${last} to 00:00 is shorter than the rest.`
    return `Counted from midnight, so every day it runs at ${shown}. ${tail} Tick the box below to count from a different hour instead.`
  }, [windowOn, everyCount, everyUnit])

  // The cadence does not fit inside the active window, so the card fires once per opening
  // rather than at the interval the number suggests. Named on screen, next to the window
  // that causes it, because the preview alone leaves the user to spot it.
  const cadenceExceedsWindow = useMemo(() => {
    if (when !== 'repeating' || repeatKind !== 'every' || !windowOn) return false
    const minutes = Number(everyCount) * UNIT_MINUTES[everyUnit]
    const length = windowLengthMinutes(`${windowStart}-${windowEnd}`)
    return Number.isFinite(minutes) && length != null && minutes > length
  }, [when, repeatKind, windowOn, everyCount, everyUnit, windowStart, windowEnd])

  /**
   * WHY THIS CARD IS SWITCHED OFF, said in the one place that can switch it back on.
   *
   * The pill's hover text tells the user to "open the card and arm it again once the cause is
   * fixed", and without this the card they open would say nothing at all: just an unticked Armed
   * box with a caption describing a manual pause. The state is what the scheduler decided
   * on its own while nobody was watching, so it has to be repeated where the decision gets
   * reversed.
   */
  const stoppedNotice = useMemo(() => {
    if (!editing || !task) return null
    if (task.scheduleState === 'failed') {
      const n = task.consecutiveFailures ?? 0
      return `This card switched itself off after failing ${n} time${n === 1 ? '' : 's'} in a row. Tick Armed to try it again: the count starts from zero.`
    }
    if (task.scheduleState === 'finished') {
      const n = task.runCount ?? 0
      return task.scheduleMaxRuns != null
        ? `This card has finished: ${n} of its ${task.scheduleMaxRuns} runs are done. Tick Armed to run it again from the start.`
        : `This card has finished: it reached its end date after ${n} run${n === 1 ? '' : 's'}. Give it a later end date to run it again.`
    }
    if (task.scheduleState === 'over_budget') {
      // Two different situations wearing one state. Armed, it is skipping and will sort
      // itself out. Switched off, the user did that on purpose and the card is waiting for
      // them, so telling them it is "still armed" is simply untrue.
      return task.scheduleEnabled
        ? 'Runs are being skipped because this card has hit its spending limit for the last 7 days. The schedule is still armed and starts again on its own as that spend ages out: there is nothing to do.'
        : 'This card went over its spending limit for the last 7 days and you switched it off. Tick Armed whenever you want it back. The limit is counted over the last 7 days, so it clears itself as that spend ages out.'
    }
    return null
  }, [editing, task])

  // The chat this card is pinned to, gone since it was pinned. Said plainly in the form
  // rather than thrown as a 400 on save: this was the bug that made a pinned daily card
  // uneditable, and the card is not broken, it just has nowhere to fire but its project.
  const pinnedChatMissing = !!task?.targetInstanceId && !instances.some(i => i.id === task.targetInstanceId)
  const pinnedProjectName = useMemo(() => {
    const f = folders.find(x => x.id === projectId)
    return f ? (f.displayName || f.name) : 'this project'
  }, [folders, projectId])

  const oncePassed = when === 'once' && scheduleEnabled
    && (parseOnceValue(onceAt)?.getTime() ?? Infinity) <= Date.now()

  // Every control routes its change through here, so a parent that wants to know whether
  // anything was touched does not have to diff forty fields to find out.
  const touch = onDirty ?? (() => {})
  const on = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); touch() }

  return (
    <>
      {/* ── When ──────────────────────────────────────────────────────── */}
      <div className="form-group">
        <label className="form-label">When</label>
        <div className="when-switch" role="group" aria-label="When this task runs">
          {([
            ['now', 'When I start it'],
            ['once', 'Once at'],
            ['repeating', 'Repeating'],
          ] as Array<[WhenMode, string]>).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`when-switch-btn${when === id ? ' is-active' : ''}`}
              aria-pressed={when === id}
              onClick={() => on(setWhen)(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {when === 'once' && (
        <div className="form-group">
          <label className="form-label">Date and time (computer time)</label>
          <input
            className="form-input"
            type="datetime-local"
            value={onceAt}
            onChange={e => on(setOnceAt)(e.target.value)}
          />
        </div>
      )}

      {when === 'repeating' && (
        <>
          <div className="form-group">
            <label className="form-label">How often</label>
            <div className="when-switch" role="group" aria-label="How often this task runs">
              {([
                ['every', 'Every'],
                ['times', 'At set times'],
              ] as Array<[RepeatKind, string]>).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`when-switch-btn${repeatKind === id ? ' is-active' : ''}`}
                  aria-pressed={repeatKind === id}
                  onClick={() => on(setRepeatKind)(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {repeatKind === 'every' ? (
            <>
            <div className="form-row">
              <div className="form-group" style={{ flex: '0 0 96px', minWidth: 0 }}>
                <label className="form-label">Run every</label>
                <input
                  className="form-input"
                  style={{ width: '100%', minWidth: 0 }}
                  type="number"
                  min={1}
                  value={everyCount}
                  onChange={e => on(setEveryCount)(e.target.value)}
                />
              </div>
              <div className="form-group" style={{ flex: '1 1 0', minWidth: 0 }}>
                <label className="form-label">&nbsp;</label>
                <select
                  className="form-select"
                  style={{ width: '100%', minWidth: 0 }}
                  value={everyUnit}
                  onChange={e => on(setEveryUnit)(e.target.value as EveryUnit)}
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
              </div>
            </div>
            {/* THE MIDNIGHT ANCHOR, said out loud.
                With no hours limit the count starts at midnight and starts again at
                midnight, so "every 5 hours" is 00:00, 05:00, 10:00, 15:00, 20:00 and
                then a FOUR hour gap. A founder who reads "every 5 hours", sees 20:00
                followed by 00:00 in the preview and is told nothing concludes the
                scheduler is broken. The times are LISTED rather than described,
                because the list is what makes the gap obvious and expected.
                Rendered only when there is no hours limit, since with one the count
                starts at the window open and the note would be wrong as well as empty.
                Its OWN height is reserved, so changing the cadence number cannot make
                it wrap and push the rest of the form down a line. */}
            {!windowOn && <div className="schedule-hint schedule-hint--anchor">{midnightGridNote}</div>}
            </>
          ) : (
            <div className="form-group">
              <label className="form-label">At these times</label>
              <div className="schedule-time-list">
                {times.map((t, i) => (
                  <div key={i} className="schedule-time-row">
                    <input
                      className="form-input"
                      type="time"
                      value={t}
                      onChange={e => { const v = e.target.value; setTimes(prev => prev.map((x, j) => j === i ? v : x)); touch() }}
                    />
                    <button
                      type="button"
                      className="schedule-time-remove"
                      aria-label={`Remove ${t}`}
                      disabled={times.length <= 1}
                      onClick={() => { setTimes(prev => prev.filter((_, j) => j !== i)); touch() }}
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="schedule-add-time"
                onClick={() => { setTimes(prev => [...prev, nextFreeTime(prev)]); touch() }}
              >
                + Add another time
              </button>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Days</label>
            <label className="schedule-inline-check">
              <input type="checkbox" checked={everyDay} onChange={e => on(setEveryDay)(e.target.checked)} />
              Every day
            </label>
            {!everyDay && (
              <div className="weekday-chips" role="group" aria-label="Days of the week">
                {WEEKDAY_ORDER.map(d => {
                  const active = days.includes(d)
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`weekday-chip${active ? ' active' : ''}`}
                      aria-pressed={active}
                      onClick={() => { setDays(prev => active ? prev.filter(x => x !== d) : [...prev, d]); touch() }}
                    >
                      {WEEKDAY_SHORT[d]}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {repeatKind === 'every' && (
            <div className="form-group">
              <label className="form-label">Only between these hours</label>
              <label className="schedule-inline-check">
                <input type="checkbox" checked={windowOn} onChange={e => on(setWindowOn)(e.target.checked)} />
                Limit runs to part of the day
              </label>
              {windowOn && (
                <>
                  <div className="schedule-window-row">
                    <input
                      className="form-input"
                      type="time"
                      value={windowStart}
                      onChange={e => on(setWindowStart)(e.target.value)}
                      aria-label="Window opens"
                    />
                    <span className="schedule-window-to">to</span>
                    <input
                      className="form-input"
                      type="time"
                      value={windowEnd}
                      onChange={e => on(setWindowEnd)(e.target.value)}
                      aria-label="Window closes"
                    />
                  </div>
                  <div className="schedule-hint schedule-hint--window">
                    {/* The overnight case has to be said out loud: an end before the start
                        is a window that closes tomorrow, not an error, and nobody guesses
                        that from two time inputs. */}
                    {windowEnd <= windowStart
                      ? `Runs from ${windowStart} until ${windowEnd} the next day. The days ticked above are the days it starts on.`
                      : `First run at ${windowStart}, then every ${describeEvery(Number(everyCount) * UNIT_MINUTES[everyUnit]).replace(/^every /, '')}, and none after ${windowEnd}.`}
                    {cadenceExceedsWindow && ` That is shorter than ${describeEvery(Number(everyCount) * UNIT_MINUTES[everyUnit]).replace(/^every /, '')}, so it runs once each time the window opens, at ${windowStart}.`}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Timezone</label>
            <select
              className="form-select"
              value={timezone}
              onChange={e => on(setTimezone)(e.target.value)}
            >
              <option value="">Computer time ({zoneLabel(here)})</option>
              {/* A card can already carry a zone that is not on the short list, and
                  losing it on the next save would move every fire time silently. */}
              {(COMMON_TIMEZONES.includes(timezone) || !timezone ? COMMON_TIMEZONES : [timezone, ...COMMON_TIMEZONES])
                .map(tz => <option key={tz} value={tz}>{zoneLabel(tz)}</option>)}
            </select>
            <div className="schedule-hint">
              Computer time follows this laptop wherever it is. Pick a timezone to pin the
              hours to one place instead.
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Ends</label>
            <div className="when-switch" role="group" aria-label="When this schedule stops">
              {([
                ['never', 'Never'],
                ['until', 'On a date'],
                ['after', 'After so many runs'],
              ] as Array<[EndMode, string]>).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`when-switch-btn${endMode === id ? ' is-active' : ''}`}
                  aria-pressed={endMode === id}
                  onClick={() => on(setEndMode)(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="schedule-hint schedule-hint--ends">
              {endMode === 'never' && 'It keeps running until you switch it off.'}
              {endMode === 'until' && (
                <span className="schedule-inline-field">
                  Last day it runs:
                  <input
                    className="form-input"
                    type="date"
                    value={untilDate}
                    onChange={e => on(setUntilDate)(e.target.value)}
                    aria-label="Last day it runs"
                  />
                  <span>that day included</span>
                </span>
              )}
              {endMode === 'after' && (
                <span className="schedule-inline-field">
                  <input
                    className="form-input"
                    type="number"
                    min={1}
                    value={maxRuns}
                    onChange={e => on(setMaxRuns)(e.target.value)}
                    aria-label="Number of runs before it stops"
                  />
                  <span>{editing && (task?.runCount ?? 0) > 0
                    ? `runs in total, ${task?.runCount} done so far`
                    : 'runs, then it stops'}</span>
                </span>
              )}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">If a run is missed</label>
            <div className="when-switch" role="group" aria-label="What to do with a missed run">
              {([
                ['late', 'Run it late'],
                ['skip', 'Skip it'],
              ] as Array<['late' | 'skip', string]>).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`when-switch-btn${catchupPolicy === id ? ' is-active' : ''}`}
                  aria-pressed={catchupPolicy === id}
                  onClick={() => on(setCatchupPolicy)(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="schedule-hint schedule-hint--missed">
              {catchupPolicy === 'late'
                ? 'If this computer was off or asleep when a run was due, it runs once things are back, unless the next run is already due or its hours have closed.'
                : 'If this computer was off or asleep when a run was due, that run is skipped and it waits for the next one.'}
            </div>
          </div>
        </>
      )}

      {/* ── Next 5 runs ────────────────────────────────────────────────────
          Fixed height for five rows so the panel does not jump a centimetre every
          time a day chip is clicked. */}
      {when !== 'now' && preview && (
        <div className="form-group">
          <label className="form-label">
            {when === 'once'
              ? 'When it runs'
              : timezone && timezone !== here
                ? `Next 5 runs, shown in your time (${zoneLabel(here)})`
                : 'Next 5 runs'}
          </label>
          <div className="schedule-preview">
            {preview.error ? (
              <div className="schedule-preview-empty">{preview.error}</div>
            ) : preview.runs.length === 0 ? (
              <div className="schedule-preview-empty">This schedule has no runs left.</div>
            ) : (
              Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="schedule-preview-row">{preview.runs[i] ?? ''}</div>
              ))
            )}
          </div>
          <div className="schedule-describe">{!preview.error ? preview.text : ''}</div>
        </div>
      )}

      {stoppedNotice && (
        <div className="schedule-notice">{stoppedNotice}</div>
      )}

      {pinnedChatMissing && (
        <div className="schedule-notice">
          The chat this card was pinned to has been closed. Saving will open a fresh chat
          in {pinnedProjectName} on every run instead.
        </div>
      )}

      {when !== 'now' && (
        <div className="form-group">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: 'var(--font-mono)', cursor: 'pointer' }}>
            <input type="checkbox" checked={scheduleEnabled} onChange={e => on(setScheduleEnabled)(e.target.checked)} />
            Armed
            <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-sans)', fontSize: 11 }}>
              uncheck to pause it: the schedule is kept and nothing fires
            </span>
          </label>
        </div>
      )}

      {oncePassed && (
        <div style={{ fontSize: 11, color: 'var(--warning, #fbbf24)', fontFamily: 'var(--font-mono)', marginTop: -6, marginBottom: 10 }}>
          This time has already passed. Saving fires it within about 30 seconds.
        </div>
      )}

      {/* ── Run settings. "App default" is the empty value everywhere: it means the card
          carries nothing of its own and follows Settings, today and after Settings
          changes. It is not the same as picking today's default by hand. ── */}
      <div className="form-row">
        <div className="form-group" style={{ flex: '1 1 0', minWidth: 0 }}>
          <label className="form-label">Model</label>
          <select className="form-select" style={{ width: '100%', minWidth: 0 }} value={model} onChange={e => on(setModel)(e.target.value)}>
            <option value="">App default</option>
            {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ flex: '1 1 0', minWidth: 0 }}>
          <label className="form-label">Effort</label>
          <select className="form-select" style={{ width: '100%', minWidth: 0 }} value={effort} onChange={e => on(setEffort)(e.target.value as EffortLevel)}>
            <option value="">App default</option>
            {EFFORT_LEVELS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ flex: '1 1 0', minWidth: 0 }}>
          <label className="form-label">Permissions</label>
          <select className="form-select" style={{ width: '100%', minWidth: 0 }} value={permissionMode} onChange={e => on(setPermissionMode)(e.target.value as PermissionMode)}>
            <option value="">App default</option>
            {CARD_PERMISSION_MODES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
      </div>

      {/* ── Advanced. Everything here is real and saved; it is folded away because it is
          rarely touched, not because it is unfinished. ── */}
      <div className="form-group">
        <button
          type="button"
          className="advanced-toggle"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced(v => !v)}
        >
          {showAdvanced ? '▾' : '▸'} Advanced
        </button>
      </div>

      {showAdvanced && (
        <>
          <div className="form-row">
            <div className="form-group" style={{ flex: '1 1 0', minWidth: 0 }}>
              <label className="form-label">Spend limit per run (dollars)</label>
              <input
                className="form-input"
                style={{ width: '100%', minWidth: 0 }}
                type="number"
                min={0}
                step="0.5"
                placeholder="none"
                value={maxBudgetUsd}
                onChange={e => on(setMaxBudgetUsd)(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ flex: '1 1 0', minWidth: 0 }}>
              <label className="form-label">Stop a run after (minutes)</label>
              <input
                className="form-input"
                style={{ width: '100%', minWidth: 0 }}
                type="number"
                min={1}
                placeholder="no limit"
                value={maxRunMinutes}
                onChange={e => on(setMaxRunMinutes)(e.target.value)}
              />
              <div className="schedule-hint">A run stopped this way counts as a failure.</div>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group" style={{ flex: '1 1 0', minWidth: 0 }}>
              <label className="form-label">Spending limit per week (dollars)</label>
              <input
                className="form-input"
                style={{ width: '100%', minWidth: 0 }}
                type="number"
                min={0.01}
                step="1"
                placeholder="no limit"
                value={budgetCapUsd}
                onChange={e => on(setBudgetCapUsd)(e.target.value)}
              />
              <div className="schedule-hint">
                {budgetCapUsd.trim()
                  ? 'Counted over the last 7 days, rolling. Scheduled runs are skipped once it is passed, and start again on their own as that spend ages out: the card is not switched off. Run now is never blocked, but what it spends counts.'
                  : 'Leave empty for no limit. A limit is counted over the last 7 days and pauses scheduled runs instead of switching the card off.'}
              </div>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group" style={{ flex: '1 1 0', minWidth: 0 }}>
              <label className="form-label">Switch off after this many failures in a row</label>
              <input
                className="form-input"
                style={{ width: '100%', minWidth: 0 }}
                type="number"
                min={0}
                value={disarmAfterFailures}
                onChange={e => on(setDisarmAfterFailures)(e.target.value)}
              />
              <div className="schedule-hint">
                {disarmAfterFailures.trim() === '0'
                  ? 'Zero means never switch it off. It will keep trying however often it fails.'
                  : 'Use 0 to mean never switch it off.'}
              </div>
            </div>
            <div className="form-group" style={{ flex: '1 1 0', minWidth: 0 }}>
              <label className="form-label">Fallback model</label>
              <select className="form-select" style={{ width: '100%', minWidth: 0 }} value={fallbackModel} onChange={e => on(setFallbackModel)(e.target.value)}>
                <option value="">None</option>
                {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
          </div>

          {/* AFTER EACH RUN. Both of these are about the chat a scheduled card leaves
              behind, which is the thing that quietly fills up when a card runs nightly
              for a month. Worded as what happens rather than as what it is called:
              "auto-compact" means nothing to somebody who has not read the CLI docs. */}
          <div className="form-group">
            <label className="form-label">After each run</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: 'var(--font-mono)', cursor: 'pointer' }}>
              <input type="checkbox" checked={autoCompact} onChange={e => on(setAutoCompact)(e.target.checked)} />
              Summarise the chat to keep it small
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: 'var(--font-mono)', cursor: 'pointer', marginTop: 6 }}>
              <input type="checkbox" checked={autoClose} onChange={e => on(setAutoClose)(e.target.checked)} />
              Close the chat when the run finishes
            </label>
            <div className="schedule-hint">
              {autoClose
                ? autoCompact
                  ? 'The chat is summarised first, then closed. The next run opens a fresh chat that still remembers this one, so the card keeps its thread without keeping a tab open.'
                  : 'The next run opens a fresh chat that still remembers this one, so the card keeps its thread without keeping a tab open.'
                : autoCompact
                  ? 'Keeps a long-running chat from growing without end. The chat stays open.'
                  : 'A scheduled card leaves its chat open by default, which is what you want while you are watching it and not what you want after a month of nightly runs.'}
            </div>
          </div>

          <div className="form-row">
            <div className="form-group" style={{ flex: '1 1 0', minWidth: 0 }}>
              <label className="form-label">Output style</label>
              <input
                className="form-input"
                style={{ width: '100%', minWidth: 0 }}
                placeholder="App default"
                value={outputStyle}
                onChange={e => on(setOutputStyle)(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ flex: '1 1 0', minWidth: 0 }}>
              <label className="form-label">Language</label>
              <input
                className="form-input"
                style={{ width: '100%', minWidth: 0 }}
                placeholder="App default"
                value={language}
                onChange={e => on(setLanguage)(e.target.value)}
              />
            </div>
          </div>

          {/* The chat a SCHEDULED fire is aimed at. Not the chat that last worked the
              card: those are two different things and the card keeps both. */}
          <div className="form-group">
            <label className="form-label">Target chat</label>
            <select
              className="form-select"
              value={targetInstanceId}
              onChange={e => on(setTargetInstanceId)(e.target.value)}
            >
              <option value="">New chat each run</option>
              {projectChats.map(i => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
            {!targetInstanceId && when !== 'now' && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', lineHeight: 1.5, marginTop: 4 }}>
                Every run opens its own fresh chat in this project.
              </div>
            )}
          </div>

          {/* How a fire shows itself. Normal: the chat pops into the grid, glows once,
              and holds a bright status until read. Silent: it runs, and that is all;
              find it in the sidebar or in Activity. */}
          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: 'var(--font-mono)', cursor: 'pointer' }}>
              <input type="checkbox" checked={silent} onChange={e => on(setSilent)(e.target.checked)} />
              Silent
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-sans)', fontSize: 11 }}>
                runs without showing up in the grid
              </span>
            </label>
          </div>
        </>
      )}
    </>
  )
}
