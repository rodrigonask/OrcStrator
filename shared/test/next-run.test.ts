// The next-run table test. Run it with:
//   npx tsx shared/test/next-run.test.ts
//
// A plain script rather than node:test, on purpose: `node --test` through tsx on
// Windows has to resolve the test file through a loader AND a path with a drive
// letter, and the combination is the flakiest part of the toolchain here. What this
// file has to do is print one PASS line per case and exit non-zero on any failure,
// which does not need a framework.
//
// Every case names the expected wall-clock reading, not an epoch number, because an
// epoch number in a diff tells you nothing about which hour moved.

import {
  computeNextRun, nextRuns, validateScheduleSpec, formatInZone, wallToEpoch,
  describeSchedule, firesOncePerOpening, windowLengthMinutes, computerZone, isInsideActiveWindow,
  type ScheduleSpec,
} from '../src/schedule-next.js'

const LONDON = 'Europe/London'
const SAO_PAULO = 'America/Sao_Paulo'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    failed++
    failures.push(`${name}  ${detail}`)
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

/** An instant from a wall-clock reading in a zone, so a case can be written the way it is read. */
function at(zone: string, iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(iso)
  if (!m) throw new Error(`bad test instant ${iso}`)
  return wallToEpoch(
    { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) },
    Number(m[4]), Number(m[5]), zone
  )
}

/** The next `n` runs rendered as wall-clock readings in `zone`, which is what a case asserts on. */
function runsAs(spec: ScheduleSpec, from: number, n: number, zone: string): string[] {
  return nextRuns(spec, n, from).map(ts => formatInZone(ts, zone))
}

function eqList(name: string, actual: string[], expected: string[]): void {
  const ok = actual.length === expected.length && actual.every((v, i) => v === expected[i])
  check(name, ok, ok ? `-> ${actual.join(' | ')}` : `\n      got      ${actual.join(' | ')}\n      expected ${expected.join(' | ')}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) every 300, window 11:00-19:00, days 0,2,3,4,5, from Tue 2026-09-15 10:00 London
// ─────────────────────────────────────────────────────────────────────────────
{
  const spec: ScheduleSpec = { kind: 'every', value: '300', window: '11:00-19:00', days: '0,2,3,4,5', tz: LONDON }
  eqList(
    'a) every 5h, 11:00-19:00, Tue Wed Thu Fri Sun (the acceptance schedule)',
    runsAs(spec, at(LONDON, '2026-09-15T10:00'), 5, LONDON),
    ['11:00 on Tue 15 Sep', '16:00 on Tue 15 Sep', '11:00 on Wed 16 Sep', '16:00 on Wed 16 Sep', '11:00 on Thu 17 Sep']
  )
  // Friday is on, Saturday is off, Sunday is on: the run after Friday 16:00 is Sunday 11:00.
  eqList(
    'a2) the same schedule skips Saturday and lands on Sunday',
    runsAs(spec, at(LONDON, '2026-09-18T16:30'), 2, LONDON),
    ['11:00 on Sun 20 Sep', '16:00 on Sun 20 Sep']
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) every 300, no window: the midnight grid, reset each day
// ─────────────────────────────────────────────────────────────────────────────
{
  const spec: ScheduleSpec = { kind: 'every', value: '300', tz: LONDON }
  eqList(
    'b) every 5h with no window anchors on midnight and resets at midnight',
    runsAs(spec, at(LONDON, '2026-09-14T23:59'), 6, LONDON),
    ['00:00 on Tue 15 Sep', '05:00 on Tue 15 Sep', '10:00 on Tue 15 Sep',
     '15:00 on Tue 15 Sep', '20:00 on Tue 15 Sep', '00:00 on Wed 16 Sep']
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) every 120, window 22:00-06:00 overnight, days 5 (Friday) only
// ─────────────────────────────────────────────────────────────────────────────
{
  const spec: ScheduleSpec = { kind: 'every', value: '120', window: '22:00-06:00', days: '5', tz: LONDON }
  eqList(
    'c) overnight window opens Friday and runs into Saturday morning',
    runsAs(spec, at(LONDON, '2026-09-18T21:00'), 6, LONDON),
    ['22:00 on Fri 18 Sep', '00:00 on Sat 19 Sep', '02:00 on Sat 19 Sep',
     '04:00 on Sat 19 Sep', '06:00 on Sat 19 Sep', '22:00 on Fri 25 Sep']
  )
  // The day filter is about the day the window OPENS: standing inside Saturday's tail
  // of Friday's window still finds the rest of that window.
  eqList(
    'c2) standing inside the overnight tail on Saturday still sees Friday window slots',
    runsAs(spec, at(LONDON, '2026-09-19T01:00'), 2, LONDON),
    ['02:00 on Sat 19 Sep', '04:00 on Sat 19 Sep']
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// (d) times 11:00,19:00 on weekdays skips Saturday and Sunday
// ─────────────────────────────────────────────────────────────────────────────
{
  const spec: ScheduleSpec = { kind: 'times', value: '11:00,19:00', days: '1,2,3,4,5', tz: LONDON }
  eqList(
    'd) at 11:00 and 19:00 on weekdays skips Saturday and Sunday',
    runsAs(spec, at(LONDON, '2026-09-18T12:00'), 3, LONDON),
    ['19:00 on Fri 18 Sep', '11:00 on Mon 21 Sep', '19:00 on Mon 21 Sep']
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// (e) Europe/London 2026-03-29: the spring-forward GAP. 01:30 does not exist.
// ─────────────────────────────────────────────────────────────────────────────
{
  const spec: ScheduleSpec = { kind: 'times', value: '01:30', tz: LONDON }
  const from = at(LONDON, '2026-03-29T00:30')
  const next = computeNextRun(spec, from)
  // The gap runs 01:00 GMT -> 02:00 BST. The first instant after it is 01:00 UTC.
  const gapEnd = Date.UTC(2026, 2, 29, 1, 0, 0)
  check(
    'e) DST gap: 01:30 on 2026-03-29 London resolves to the first instant after the gap',
    next === gapEnd,
    `got ${next} (${next != null ? new Date(next).toISOString() : 'null'}), expected ${gapEnd} (${new Date(gapEnd).toISOString()} = 02:00 BST)`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// (f) Europe/London 2026-10-25: the fall-back OVERLAP. 01:30 happens twice.
// ─────────────────────────────────────────────────────────────────────────────
{
  const spec: ScheduleSpec = { kind: 'times', value: '01:30', tz: LONDON }
  // Stand at 00:00 BST (23:00 UTC on the 24th) so both occurrences are still ahead.
  const from = Date.UTC(2026, 9, 24, 23, 0, 0)
  const next = computeNextRun(spec, from)
  const firstPass = Date.UTC(2026, 9, 25, 0, 30, 0) // 01:30 BST
  const secondPass = Date.UTC(2026, 9, 25, 1, 30, 0) // 01:30 GMT
  check(
    'f) DST overlap: 01:30 on 2026-10-25 London resolves to the FIRST occurrence',
    next === firstPass,
    `got ${next != null ? new Date(next).toISOString() : 'null'}, expected ${new Date(firstPass).toISOString()} (not ${new Date(secondPass).toISOString()})`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// (g) A London-zoned card is the same instant under any process TZ
// ─────────────────────────────────────────────────────────────────────────────
{
  const spec: ScheduleSpec = { kind: 'every', value: '300', window: '11:00-19:00', days: '0,2,3,4,5', tz: LONDON }
  const from = Date.UTC(2026, 8, 15, 9, 0, 0)
  const saved = process.env.TZ

  process.env.TZ = LONDON
  const underLondon = computeNextRun(spec, from)
  process.env.TZ = SAO_PAULO
  const underSaoPaulo = computeNextRun(spec, from)
  if (saved === undefined) delete process.env.TZ
  else process.env.TZ = saved

  check(
    'g) a London-zoned card returns the same epoch under TZ=America/Sao_Paulo',
    underLondon != null && underLondon === underSaoPaulo,
    `London ${underLondon}, Sao Paulo ${underSaoPaulo}`
  )
  // And the zone genuinely matters: the same wall-clock schedule read as Sao Paulo time
  // is a different instant, so an accidental server-zone read would have been caught.
  const spSpec: ScheduleSpec = { ...spec, tz: SAO_PAULO }
  const spNext = computeNextRun(spSpec, from)
  check(
    'g2) the same schedule zoned America/Sao_Paulo is a DIFFERENT instant',
    spNext != null && spNext !== underLondon,
    `London ${underLondon != null ? new Date(underLondon).toISOString() : 'null'}, Sao Paulo ${spNext != null ? new Date(spNext).toISOString() : 'null'}`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// (h) window end is INCLUSIVE at the exact minute
// ─────────────────────────────────────────────────────────────────────────────
{
  const spec: ScheduleSpec = { kind: 'every', value: '240', window: '11:00-19:00', tz: LONDON }
  eqList(
    'h) every 4h in 11:00-19:00 includes 19:00 (window end inclusive)',
    runsAs(spec, at(LONDON, '2026-09-15T10:00'), 4, LONDON),
    ['11:00 on Tue 15 Sep', '15:00 on Tue 15 Sep', '19:00 on Tue 15 Sep', '11:00 on Wed 16 Sep']
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// (i) a cadence longer than the window fires once a day, at the window open
// ─────────────────────────────────────────────────────────────────────────────
{
  const spec: ScheduleSpec = { kind: 'every', value: '600', window: '11:00-19:00', tz: LONDON }
  eqList(
    'i) every 10h in an 8h window gives 11:00 only, once per day',
    runsAs(spec, at(LONDON, '2026-09-15T10:00'), 3, LONDON),
    ['11:00 on Tue 15 Sep', '11:00 on Wed 16 Sep', '11:00 on Thu 17 Sep']
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// (j) an empty day list is a validation error
// ─────────────────────────────────────────────────────────────────────────────
{
  const err = validateScheduleSpec({ kind: 'every', value: '300', days: '', tz: LONDON })
  check('j) an empty day list is rejected with a readable message', err !== null, `-> ${err}`)
  const outOfOrder = validateScheduleSpec({ kind: 'every', value: '300', days: '3,1', tz: LONDON })
  check('j2) an out-of-order day list is rejected', outOfOrder !== null, `-> ${outOfOrder}`)
  const dupe = validateScheduleSpec({ kind: 'times', value: '11:00,11:00', tz: LONDON })
  check('j3) a repeated time is rejected', dupe !== null, `-> ${dupe}`)
  const windowOnTimes = validateScheduleSpec({ kind: 'times', value: '11:00', window: '11:00-19:00', tz: LONDON })
  check('j4) an active window on an "at times" card is rejected', windowOnTimes !== null, `-> ${windowOnTimes}`)
  const badZone = validateScheduleSpec({ kind: 'every', value: '300', tz: 'Europe/Londonn' })
  check('j5) an unrecognised timezone is rejected', badZone !== null, `-> ${badZone}`)
  const good = validateScheduleSpec({ kind: 'every', value: '300', window: '22:00-06:00', days: '0,2,3,4,5', tz: LONDON })
  check('j6) the acceptance schedule itself validates', good === null, `-> ${good}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// (k) an until date in the past returns null
// ─────────────────────────────────────────────────────────────────────────────
{
  const yesterday: ScheduleSpec = { kind: 'every', value: '300', tz: LONDON, until: '2026-09-14' }
  const from = at(LONDON, '2026-09-15T10:00')
  check('k) schedule_until yesterday returns null', computeNextRun(yesterday, from) === null, '-> null')
  const today: ScheduleSpec = { kind: 'every', value: '300', tz: LONDON, until: '2026-09-15' }
  eqList(
    'k2) an until date of today still runs today, then stops',
    runsAs(today, from, 5, LONDON),
    ['15:00 on Tue 15 Sep', '20:00 on Tue 15 Sep']
  )
  const timesUntil: ScheduleSpec = { kind: 'times', value: '11:00,19:00', tz: LONDON, until: '2026-09-16' }
  eqList(
    'k3) an until date on an "at times" card stops after that day',
    runsAs(timesUntil, from, 5, LONDON),
    ['11:00 on Tue 15 Sep', '19:00 on Tue 15 Sep', '11:00 on Wed 16 Sep', '19:00 on Wed 16 Sep']
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// (l) once is unchanged: a past instant comes back as it is
// ─────────────────────────────────────────────────────────────────────────────
{
  const spec: ScheduleSpec = { kind: 'once', value: '2026-09-08T10:00', tz: LONDON }
  const from = at(LONDON, '2026-09-15T10:00')
  const next = computeNextRun(spec, from)
  const expected = at(LONDON, '2026-09-08T10:00')
  check('l) a past one-off returns its own instant, not null', next === expected, `-> ${next != null ? formatInZone(next, LONDON) : 'null'}`)
  const list = nextRuns(spec, 5, from)
  check('l2) a one-off previews exactly one run', list.length === 1, `-> ${list.length} run(s)`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Extra guards the mechanic depends on
// ─────────────────────────────────────────────────────────────────────────────
{
  // The preview and the scheduler are the same function: five consecutive calls to
  // computeNextRun, each from the previous answer, ARE what nextRuns returns.
  const spec: ScheduleSpec = { kind: 'every', value: '300', window: '11:00-19:00', days: '0,2,3,4,5', tz: LONDON }
  const from = at(LONDON, '2026-09-15T10:00')
  const manual: number[] = []
  let cursor = from
  for (let i = 0; i < 5; i++) {
    const n = computeNextRun(spec, cursor)
    if (n == null) break
    manual.push(n)
    cursor = n
  }
  const preview = nextRuns(spec, 5, from)
  check(
    'x1) the preview list equals five successive scheduler calls',
    manual.length === preview.length && manual.every((v, i) => v === preview[i]),
    `-> ${preview.length} run(s)`
  )

  // Never "now + N": standing at 10:03 must still give 11:00, not 15:03.
  const offGrid = computeNextRun(spec, at(LONDON, '2026-09-15T10:03'))
  check(
    'x2) the grid is anchored on the window open, never on now + N',
    offGrid === at(LONDON, '2026-09-15T11:00'),
    `-> ${offGrid != null ? formatInZone(offGrid, LONDON) : 'null'}`
  )

  // A window that crosses the spring-forward gap keeps its wall-clock open time.
  const dstWindow: ScheduleSpec = { kind: 'every', value: '60', window: '00:30-05:00', tz: LONDON }
  const dstFrom = Date.UTC(2026, 2, 28, 23, 0, 0)
  const dstRuns = runsAs(dstWindow, dstFrom, 4, LONDON)
  check(
    'x3) an every-hour window across the spring-forward gap still opens at 00:30',
    dstRuns[0] === '00:30 on Sun 29 Mar',
    `-> ${dstRuns.join(' | ')}`
  )

  // A times card with no days and no zone still works (the common case).
  const plain: ScheduleSpec = { kind: 'times', value: '09:00' }
  check('x4) a bare "at 09:00" card with no days and no zone still computes', computeNextRun(plain, Date.now()) !== null)
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CADENCE THAT DOES NOT FIT ITS WINDOW.
//
// The grid restarts at every window opening, so a cadence longer than the window fires
// exactly once per opening however large the number is. "Every 7 days" with no window is
// therefore every night at midnight: seven times the fires, seven times the spend. The
// engine's behaviour is correct and locked (D4); what must never come back is the engine
// DESCRIBING it as anything else.
// ─────────────────────────────────────────────────────────────────────────────
{
  // A weekly cadence cannot be stored at all any more (see w2), so the surviving way to
  // reach "fires once per opening" is a cadence longer than its WINDOW, which is legitimate
  // and common: "every 10 hours, but only between 11:00 and 19:00".
  const weekly: ScheduleSpec = { kind: 'every', value: '10080', tz: LONDON }
  check('y1) a weekly cadence is refused outright rather than silently becoming nightly', computeNextRun(weekly, Date.now()) === null)
  check('y2) firesOncePerOpening still recognises the shape', firesOncePerOpening(weekly) === true)

  const dayLong: ScheduleSpec = { kind: 'every', value: '1440', tz: LONDON }
  check(
    'y3) a day-long cadence is described as what it does, not as what the number says',
    describeSchedule(dayLong, { computerZone: LONDON }) === 'at 00:00',
    `-> "${describeSchedule(dayLong, { computerZone: LONDON })}" (must not contain "1 day")`
  )

  const tooLongForWindow: ScheduleSpec = { kind: 'every', value: '600', window: '11:00-19:00', days: '0,2,3,4,5', tz: LONDON }
  check(
    'y4) a cadence longer than its 8 hour window is described as the one time it fires',
    describeSchedule(tooLongForWindow, { computerZone: LONDON }) === 'at 11:00, on Tue, Wed, Thu, Fri, Sun',
    `-> "${describeSchedule(tooLongForWindow, { computerZone: LONDON })}"`
  )

  const fits: ScheduleSpec = { kind: 'every', value: '300', window: '11:00-19:00', days: '0,2,3,4,5', tz: LONDON }
  check(
    'y5) a cadence that DOES fit keeps its ordinary sentence',
    describeSchedule(fits, { computerZone: LONDON }) === 'every 5 hours, 11:00 to 19:00, on Tue, Wed, Thu, Fri, Sun',
    `-> "${describeSchedule(fits, { computerZone: LONDON })}"`
  )
  check('y6) and is not flagged', firesOncePerOpening(fits) === false)

  // The boundary, both sides. 1439 minutes fits inside 00:00 to 23:59 twice (00:00 and
  // 23:59); 1440 does not.
  check('y7) 1439 minutes with no window still fires twice a day', firesOncePerOpening({ kind: 'every', value: '1439', tz: LONDON }) === false)
  check('y8) 1440 minutes with no window does not', firesOncePerOpening({ kind: 'every', value: '1440', tz: LONDON }) === true)
  eqList(
    'y9) the 1439 boundary really does produce two runs in a day',
    runsAs({ kind: 'every', value: '1439', tz: LONDON }, at(LONDON, '2026-09-15T10:00'), 3, LONDON),
    ['23:59 on Tue 15 Sep', '00:00 on Wed 16 Sep', '23:59 on Wed 16 Sep']
  )

  // An overnight window is measured by wrapping, not by subtracting, or 22:00 to 06:00
  // would read as a negative length and every cadence would look like it fits.
  check('y10) an overnight window is 480 minutes long, not negative', windowLengthMinutes('22:00-06:00') === 480)
  check('y11) an ordinary window is measured inclusively', windowLengthMinutes('11:00-19:00') === 480)
  check('y12) no window is a full day', windowLengthMinutes(null) === 1439)
}

// ─────────────────────────────────────────────────────────────────────────────
// Window shapes that used to be accepted and mean something nobody asked for.
// ─────────────────────────────────────────────────────────────────────────────
{
  const equal = validateScheduleSpec({ kind: 'every', value: '60', window: '11:00-11:00', tz: LONDON })
  check('w1) a window that starts and ends at the same time is rejected', equal !== null, `-> ${equal}`)
  const tooLong = validateScheduleSpec({ kind: 'every', value: '1440', tz: LONDON })
  check('w2) a cadence of a day or longer is rejected, with the alternative named', tooLong !== null, `-> ${tooLong}`)
  check(
    'w3) and the message does not advertise a range the engine cannot honour',
    tooLong != null && !/7 days/.test(tooLong),
    `-> ${tooLong}`
  )
  const stillFine = validateScheduleSpec({ kind: 'every', value: '1439', tz: LONDON })
  check('w4) 1439 minutes, the longest cadence that fits in a day, is still accepted', stillFine === null)
  const overnight = validateScheduleSpec({ kind: 'every', value: '120', window: '22:00-06:00', tz: LONDON })
  check('w5) a genuine overnight window is still accepted', overnight === null)
  const noKind = validateScheduleSpec({ kind: '', value: '300' })
  check('w6) a missing cadence gets a sentence, not "Unknown cadence undefined"', noKind != null && !/undefined/.test(noKind), `-> ${noKind}`)

  // The until date is applied to the day the window OPENS, matching the days filter (D3).
  // An overnight window opening on the until date therefore finishes its night. The plan's
  // s4 pseudo-code reads as "every candidate's calendar day", which would cut the night in
  // half at midnight. This pins the behaviour the code actually has and s3 D3 implies.
  eqList(
    'w7) an overnight window opening on the until date finishes its night',
    runsAs({ kind: 'every', value: '120', window: '22:00-06:00', tz: LONDON, until: '2026-09-15' }, at(LONDON, '2026-09-15T21:00'), 6, LONDON),
    ['22:00 on Tue 15 Sep', '00:00 on Wed 16 Sep', '02:00 on Wed 16 Sep', '04:00 on Wed 16 Sep', '06:00 on Wed 16 Sep']
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// What a DST night does to a window, pinned rather than discovered.
//
// Candidates step in ABSOLUTE time from the window open (this is s4's own pseudo-code),
// so on the night the clocks move the wall-clock readings shift and the window holds one
// fewer or one more slot. That is correct for a cadence measured in real elapsed time, and
// it is the one place "the window end is inclusive at the exact minute" does not hold.
// Written down here so it is a known property with a test, not a surprise in March.
// ─────────────────────────────────────────────────────────────────────────────
{
  const overnight: ScheduleSpec = { kind: 'every', value: '120', window: '22:00-06:00', tz: LONDON }
  const normal = runsAs(overnight, at(LONDON, '2026-09-14T21:00'), 5, LONDON)
  eqList(
    'd1) an ordinary night runs 22:00 to 06:00 inclusive',
    normal,
    ['22:00 on Mon 14 Sep', '00:00 on Tue 15 Sep', '02:00 on Tue 15 Sep', '04:00 on Tue 15 Sep', '06:00 on Tue 15 Sep']
  )
  // Spring forward: the night is one real hour shorter, so it holds FOUR slots instead of
  // five and the wall readings jump 00:00 to 03:00 across the gap. The fifth run in the
  // list is already the NEXT night's opening.
  eqList(
    'd2) the spring-forward night holds four slots and skips the missing hour',
    runsAs(overnight, at(LONDON, '2026-03-28T21:00'), 5, LONDON),
    ['22:00 on Sat 28 Mar', '00:00 on Sun 29 Mar', '03:00 on Sun 29 Mar', '05:00 on Sun 29 Mar', '22:00 on Sun 29 Mar']
  )
  // Fall back: the night is one real hour longer, the 01:00 reading is the repeated hour,
  // and 06:00 is still not reached because the grid is absolute and lands on 05:00.
  eqList(
    'd3) the fall-back night repeats an hour and still ends on 05:00, not 06:00',
    runsAs(overnight, at(LONDON, '2026-10-24T21:00'), 6, LONDON),
    ['22:00 on Sat 24 Oct', '00:00 on Sun 25 Oct', '01:00 on Sun 25 Oct', '03:00 on Sun 25 Oct', '05:00 on Sun 25 Oct', '22:00 on Sun 25 Oct']
  )
  check(
    'd4) so the "window end is inclusive" promise holds on ordinary nights only, which is the documented trade',
    normal[normal.length - 1] === '06:00 on Tue 15 Sep',
    '-> the inclusive end is reached whenever the night is a real 8 hours long'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// "Am I inside an active window?" asked directly.
//
// The catch-up rule needs this to decide whether a missed slot is still worth running.
// The first implementation inferred it from the next candidate ("is the next run less than
// one cadence away?"), which is FALSE for the last slot of any window whose close is not
// itself a slot. On the acceptance schedule the slots are 11:00 and 16:00 in an 11:00 to
// 19:00 window, so from 16:05 the next candidate is tomorrow at 11:00, and a 16:00 slot
// missed by five minutes was dropped while the window had three hours left. These cases
// exist so that proxy can never come back.
// ─────────────────────────────────────────────────────────────────────────────
{
  const acceptance: ScheduleSpec = { kind: 'every', value: '300', window: '11:00-19:00', days: '0,2,3,4,5', tz: LONDON }
  const insideCases: Array<[string, string]> = [
    ['11:00, the moment it opens', '2026-09-15T11:00'],
    ['12:00, between slots', '2026-09-15T12:00'],
    ['16:05, five minutes after the LAST slot', '2026-09-15T16:05'],
    ['18:59, one minute before it closes', '2026-09-15T18:59'],
    ['19:00, the closing minute itself', '2026-09-15T19:00'],
  ]
  for (const [name, at_] of insideCases) {
    check(`v) inside the window at ${name}`, isInsideActiveWindow(acceptance, at(LONDON, at_)) === true)
  }
  const outsideCases: Array<[string, string]> = [
    ['10:59, one minute before it opens', '2026-09-15T10:59'],
    ['19:01, one minute after it closes', '2026-09-15T19:01'],
    ['03:00, the middle of the night', '2026-09-15T03:00'],
    ['Monday 12:00, a day the filter excludes', '2026-09-14T12:00'],
    ['Saturday 12:00, the other excluded day', '2026-09-19T12:00'],
  ]
  for (const [name, at_] of outsideCases) {
    check(`v) outside the window at ${name}`, isInsideActiveWindow(acceptance, at(LONDON, at_)) === false)
  }

  // An overnight window is open on BOTH sides of midnight, and the days filter is about
  // the day it opened, so Saturday 02:00 is inside a Friday-only 22:00 to 06:00 window.
  const overnight: ScheduleSpec = { kind: 'every', value: '120', window: '22:00-06:00', days: '5', tz: LONDON }
  check('v2) an overnight window is open at 23:00 on the Friday it opened', isInsideActiveWindow(overnight, at(LONDON, '2026-09-18T23:00')) === true)
  check('v3) and still open at 02:00 on the Saturday, a day the filter excludes', isInsideActiveWindow(overnight, at(LONDON, '2026-09-19T02:00')) === true)
  check('v4) but shut at 07:00 on that Saturday', isInsideActiveWindow(overnight, at(LONDON, '2026-09-19T07:00')) === false)
  check('v5) and shut at 23:00 on the Saturday, which is not a Friday', isInsideActiveWindow(overnight, at(LONDON, '2026-09-19T23:00')) === false)

  // No window means the whole day, on a day the filter allows.
  const noWindow: ScheduleSpec = { kind: 'every', value: '300', days: '0,2,3,4,5', tz: LONDON }
  check('v6) a card with no window is inside it all day', isInsideActiveWindow(noWindow, at(LONDON, '2026-09-15T03:00')) === true)
  check('v7) but not on a day its filter excludes', isInsideActiveWindow(noWindow, at(LONDON, '2026-09-14T12:00')) === false)
  // A 'times' card has no window, so its window is the whole day.
  check('v8) a times card with no days filter is inside all day', isInsideActiveWindow({ kind: 'times', value: '11:00', tz: LONDON }, at(LONDON, '2026-09-15T03:00')) === true)

  // BUT ITS DAYS FILTER STILL COUNTS, and this gate is the only place a late run is measured
  // against one. Two cards set to the same weekdays used to get opposite answers: a missed
  // Friday 23:30 slot was refused on Saturday morning for an 'every' card and RUN for a
  // 'times' card, on a day the user had switched the card off for.
  const timesWeekdays: ScheduleSpec = { kind: 'times', value: '23:30', days: '1,2,3,4,5', tz: LONDON }
  const everyWeekdays: ScheduleSpec = { kind: 'every', value: '60', days: '1,2,3,4,5', tz: LONDON }
  const satMorning = at(LONDON, '2026-09-19T00:20')
  check('v16) a weekdays times card is NOT inside on a Saturday', isInsideActiveWindow(timesWeekdays, satMorning) === false)
  check('v17) and the every card next to it agrees', isInsideActiveWindow(everyWeekdays, satMorning) === false)
  check('v18) the same times card IS inside late on the Friday', isInsideActiveWindow(timesWeekdays, at(LONDON, '2026-09-18T23:45')) === true)
  // A one-off has no days and a late reminder still does its job, so it never refuses.
  check('v19) a once card is always inside', isInsideActiveWindow({ kind: 'once', value: '2026-09-18T23:30', tz: LONDON }, satMorning) === true)

  // WINDOWLESS 'every' CARDS ARE SUBJECT TO THE DAYS FILTER TOO. The gate this replaced was
  // `schedule_kind === 'every' && schedule_window`, so a card with days and no window was
  // never checked at all and a missed Friday-night run was caught up on Saturday morning.
  // Refusing it is the right answer and it is a real behaviour change, so it is pinned here
  // rather than left as a side effect of a commit about something else.
  check('v20) windowless every card, Saturday 00:01 after a Friday 23:00 slot', isInsideActiveWindow(everyWeekdays, at(LONDON, '2026-09-19T00:01')) === false)
  check('v21) and the same card at 23:00 on the Friday itself', isInsideActiveWindow(everyWeekdays, at(LONDON, '2026-09-18T23:00')) === true)

  // NO WINDOW MEANS NO WINDOW, and the proof is a zone that puts its clocks back at MIDNIGHT.
  //
  // Borrowing parseWindow's 00:00-23:59 default gave a windowless card a synthetic close, and
  // a close can be landed on the wrong side of. wallToEpoch resolves an ambiguous wall time to
  // its FIRST pass, so in Santiago the hour 23:00-23:59 happens twice on the fall-back night
  // and the whole repeated hour sat after the close: a card that was never given any hours was
  // told for sixty minutes that its hours had closed. Widening the close by a minute, which is
  // what fixed the 59-second version of this, cannot reach sixty of them.
  const SANTIAGO = 'America/Santiago'
  const noWindowAnywhere: ScheduleSpec = { kind: 'every', value: '60', tz: SANTIAGO }
  // 2026-04-04 is the Saturday Santiago falls back at 24:00. These four readings are the
  // second pass of an hour that happens twice.
  const fallbackNight = at(SANTIAGO, '2026-04-04T23:00')
  check('v22) Santiago fall-back night, first pass of 23:00', isInsideActiveWindow(noWindowAnywhere, fallbackNight) === true)
  check('v23) and 59 minutes later, still the first pass', isInsideActiveWindow(noWindowAnywhere, fallbackNight + 59 * 60_000) === true)
  check('v24) and 62 minutes later, the REPEATED 23:02', isInsideActiveWindow(noWindowAnywhere, fallbackNight + 62 * 60_000) === true)
  check('v25) and 119 minutes later, the end of the repeated hour', isInsideActiveWindow(noWindowAnywhere, fallbackNight + 119 * 60_000) === true)
  // The day filter still applies on that path: it is the only thing left to apply.
  const sundayOnly: ScheduleSpec = { kind: 'every', value: '60', days: '0', tz: SANTIAGO }
  check('v26) a Sunday-only card is out on the Saturday of that night', isInsideActiveWindow(sundayOnly, fallbackNight) === false)
  check('v27) and in once it is Sunday', isInsideActiveWindow(sundayOnly, at(SANTIAGO, '2026-04-05T12:00')) === true)

  // THE LAST MINUTE OF THE DAY. `now` is a millisecond clock and a window is written HH:MM,
  // so a close compared at its first instant leaves the rest of its minute outside. On a
  // card with NO window, whose default close is 23:59, that made it outside its own hours
  // for the last 59 seconds of every day: a catch-up landing there was skipped with "the
  // hours this card is allowed to run in have closed since", on a card that has no hours.
  const lastMinute = at(LONDON, '2026-09-15T23:59')
  check('v9) no window, 23:59:00, inside', isInsideActiveWindow(noWindow, lastMinute) === true)
  check('v10) no window, 23:59:30, still inside', isInsideActiveWindow(noWindow, lastMinute + 30_000) === true)
  check('v11) no window, 23:59:59.999, the last instant, still inside', isInsideActiveWindow(noWindow, lastMinute + 59_999) === true)
  // Tuesday is in the filter, Wednesday is too, so midnight rolling over stays inside; the
  // point of the case is that the boundary is continuous rather than that it flips.
  check('v12) no window, 00:00:00 the next day, inside', isInsideActiveWindow(noWindow, lastMinute + 60_000) === true)
  // The same rule on an explicit close: 19:00 means through 19:00:59, not just 19:00:00.
  check('v13) explicit close, 19:00:30, inside', isInsideActiveWindow(acceptance, at(LONDON, '2026-09-15T19:00') + 30_000) === true)
  check('v14) explicit close, 19:01:00, outside', isInsideActiveWindow(acceptance, at(LONDON, '2026-09-15T19:01')) === false)
  // And the open is still exclusive on the wrong side of it.
  check('v15) explicit open, 10:59:59.999, outside', isInsideActiveWindow(acceptance, at(LONDON, '2026-09-15T11:00') - 1) === false)
}

// ─────────────────────────────────────────────────────────────────────────────
// ZONE INDEPENDENCE, the version that can actually fail.
//
// The first form of this test pinned tz on the spec, so computerZone() was never called
// and the assertion was guaranteed by construction. This one compares a ZONED card against
// a COMPUTER TIME card under two different process zones: the zoned one must not move, and
// the computer-time one must.
// ─────────────────────────────────────────────────────────────────────────────
{
  const zoned: ScheduleSpec = { kind: 'times', value: '11:00', tz: LONDON }
  const floating: ScheduleSpec = { kind: 'times', value: '11:00' }
  const from = Date.UTC(2026, 8, 15, 4, 0, 0)
  const saved = process.env.TZ

  const read = (tz: string) => {
    process.env.TZ = tz
    // Node caches the resolved zone per process in some builds; assert we really moved.
    return { resolved: computerZone(), zoned: computeNextRun(zoned, from), floating: computeNextRun(floating, from) }
  }
  const london = read(LONDON)
  const sp = read(SAO_PAULO)
  if (saved === undefined) delete process.env.TZ
  else process.env.TZ = saved

  const zoneReallyChanged = london.resolved !== sp.resolved
  check(
    'z1) setting process.env.TZ genuinely moves computerZone()',
    zoneReallyChanged,
    `London run resolved "${london.resolved}", Sao Paulo run resolved "${sp.resolved}"`
  )
  check(
    'z2) a London-zoned card returns the SAME instant under both process zones',
    london.zoned != null && london.zoned === sp.zoned,
    `${london.zoned} vs ${sp.zoned}`
  )
  if (zoneReallyChanged) {
    check(
      'z3) a computer-time card returns a DIFFERENT instant under the two process zones',
      london.floating != null && sp.floating != null && london.floating !== sp.floating,
      `London ${london.floating != null ? new Date(london.floating).toISOString() : 'null'}, Sao Paulo ${sp.floating != null ? new Date(sp.floating).toISOString() : 'null'}`
    )
  } else {
    // Honest rather than green: if the runtime refused to move, say so instead of
    // claiming a pass the run did not earn. A7 proves this end to end on a real server.
    check('z3) SKIPPED: this runtime ignored process.env.TZ, see A7 for the server-level proof', true, '(not a pass, a skip)')
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// (m) "Run now" holds a full cadence: the arithmetic the scheduler re-arms with
//
// fireTask re-arms a manual run from `now + cadence - 1` instead of `now`, so pressing
// Run now can never be followed by a scheduled run less than one cadence later. The
// engine rounds that instant UP to the next real slot, which is what keeps the grid.
// ──────────────────────────────────────────────────────────────────────────────
{
  const MIN = 60_000
  /** The instant fireTask passes to rescheduleTask for a manual run. */
  const holdFrom = (now: number, minutes: number) => now + minutes * MIN - 1

  const spec: ScheduleSpec = { kind: 'every', value: '300', window: '11:00-19:00', days: '0,2,3,4,5', tz: LONDON }

  // The case that started this: the card was armed for 16:00 and run by hand at 14:55.
  // Re-arming from `now` would have recomputed that same 16:00 and run the work twice in
  // an hour. Five hours out is 19:55, past the 19:00 close, so the next slot is tomorrow.
  const ranAt = at(LONDON, '2026-09-15T14:55')
  eqList(
    'm) Run now at 14:55 on an every-5h card holds to the next window, not 16:00',
    [formatInZone(computeNextRun(spec, holdFrom(ranAt, 300))!, LONDON)],
    ['11:00 on Wed 16 Sep']
  )

  // Run now AT a slot: the hold is exactly one cadence, not one cadence plus a grid step.
  // This is what the -1ms buys, computeNextRun being strictly greater than its argument.
  const onSlot = at(LONDON, '2026-09-15T11:00')
  eqList(
    'm2) Run now exactly on a slot holds exactly one cadence',
    [formatInZone(computeNextRun(spec, holdFrom(onSlot, 300))!, LONDON)],
    ['16:00 on Tue 15 Sep']
  )

  // Never SHORTER than the cadence, and the grid is preserved, so it can be longer.
  const hourly: ScheduleSpec = { kind: 'every', value: '60', tz: LONDON }
  const offGrid = at(LONDON, '2026-09-15T14:20')
  eqList(
    'm3) an hourly card run at 14:20 holds to 16:00, keeping the midnight grid',
    [formatInZone(computeNextRun(hourly, holdFrom(offGrid, 60))!, LONDON)],
    ['16:00 on Tue 15 Sep']
  )
}

console.log('')
console.log(`next-run table test: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  FAILED: ${f}`)
  process.exit(1)
}
