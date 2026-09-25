import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db.js'
import * as taskManager from '../services/task-manager.js'
import { MAX_DESCRIPTION_CHARS } from '../services/task-manager.js'
import { PIPELINE_COLUMNS } from '@orcstrator/shared'
import type { PipelineColumn, PipelineTask, TaskAttachment, TaskComment } from '@orcstrator/shared'
import {
  validateSchedule, computeNextRunAt, rescheduleTask, runTaskNow,
  rowToRun, type TaskRunRow,
} from '../services/task-scheduler.js'
import {
  hasPrompt, rawPromptIsEmpty, NO_PROMPT_MESSAGE, EMPTY_RAW_PROMPT_MESSAGE,
} from '../services/kickoff-prompt.js'
import crypto from 'crypto'

/**
 * The schedule + run settings a card can carry, read off a request body.
 *
 * Returns `{}` when the body mentions none of them, so an ordinary edit (rename, retitle,
 * move) never writes a schedule column. Every field is told apart three ways: absent leaves
 * the column alone, null clears it, a value sets it.
 */
function readTaskConfig(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const strings = ['model', 'effort', 'permissionMode', 'fallbackModel', 'outputStyle', 'language', 'targetInstanceId'] as const
  for (const key of strings) {
    if (body[key] === undefined) continue
    const v = body[key]
    out[key] = v === null || v === '' ? null : String(v)
  }
  for (const key of ['silent', 'rawPrompt', 'scheduleEnabled', 'autoCompact', 'autoClose'] as const) {
    if (body[key] !== undefined) out[key] = !!body[key]
  }
  // A FLOOR OF ONE CENT, not just "greater than zero". A cap of 0.000000001 passes `n > 0`,
  // reaches the column, and then reads as "$0.0000" in every sentence that shows it: a limit
  // nobody can see, and one smaller than the rounding slack the scheduler allows itself. The
  // field is not the only way in (a skill or a curl sends this body too), so the floor lives
  // here as well as in the form. Anything under it means no limit, which is the safe reading:
  // failing open costs money that was never really budgeted, failing closed stops a card dead.
  for (const key of ['maxBudgetUsd', 'budgetCapUsd'] as const) {
    if (body[key] === undefined) continue
    const n = Number(body[key])
    out[key] = body[key] === null || !Number.isFinite(n) || n < 0.01 ? null : n
  }
  // Whole-number settings. null or a nonsense value means "no limit", not zero: a limit of
  // zero runs would switch a card off the moment it was saved.
  for (const key of ['scheduleMaxRuns', 'maxRunMinutes'] as const) {
    if (body[key] === undefined) continue
    const n = Number(body[key])
    out[key] = body[key] === null || !Number.isInteger(n) || n <= 0 ? null : n
  }
  // The failure ceiling is the one counter where 0 is MEANINGFUL: it means never disarm.
  if (body.disarmAfterFailures !== undefined) {
    const n = Number(body.disarmAfterFailures)
    out.disarmAfterFailures = body.disarmAfterFailures === null || !Number.isInteger(n) || n < 0 ? 3 : n
  }
  if (body.catchupPolicy !== undefined) {
    out.catchupPolicy = body.catchupPolicy === 'skip' ? 'skip' : 'late'
  }
  return out
}

/**
 * Validate and normalise the When switch. Returns an error string the caller turns into a
 * 400, or the schedule columns to write.
 *
 * `scheduleKind: null` is "this card has no schedule any more", which has to clear the
 * value, the armed flag and the slot together: leaving next_run_at behind would give the
 * poll loop a card to fire that the board no longer draws a schedule for.
 */
/** An optional string field off the body: absent leaves it alone, null or '' clears it. */
function optionalText(body: Record<string, unknown>, key: string, fallback: string | null): string | null {
  if (body[key] === undefined) return fallback
  const v = body[key]
  return v === null || v === '' ? null : String(v)
}

function readSchedule(
  body: Record<string, unknown>,
  existing: {
    scheduleKind?: string | null
    scheduleValue?: string | null
    scheduleDays?: string | null
    scheduleWindow?: string | null
    scheduleTz?: string | null
    scheduleUntil?: string | null
  }
):
  | { error: string }
  | { fields: Record<string, unknown> } {
  // Any of the schedule SHAPE fields arriving means the schedule is being edited, so the
  // slot has to be recomputed. Days, window and zone change fire times exactly as much as
  // the cadence does: leaving them out of this test is how a card gets new days and keeps
  // the old grid.
  const shapeKeys = ['scheduleKind', 'scheduleValue', 'scheduleDays', 'scheduleWindow', 'scheduleTz', 'scheduleUntil']
  if (shapeKeys.every(k => body[k] === undefined)) return { fields: {} }

  const kind = body.scheduleKind === undefined ? existing.scheduleKind : body.scheduleKind
  if (kind === null || kind === '') {
    return {
      fields: {
        scheduleKind: null, scheduleValue: null, scheduleEnabled: false, nextRunAt: null,
        scheduleDays: null, scheduleWindow: null, scheduleTz: null, scheduleUntil: null,
        // A card with no schedule is not finished, failed or over budget: it has no
        // schedule. Leaving a state behind would keep a red dot on the nav for a card
        // that cannot be in trouble.
        scheduleState: null,
      },
    }
  }
  // EVERY shape field falls back to what the card already has, `scheduleValue` included.
  // It used to default to '' instead, so a PUT that changed only the days, only the window
  // or only the timezone was rejected with "How often must be between 1 minute and 7 days",
  // an error about the one field the caller had not touched. The modal never hit it because
  // it always sends all six, but the whole point of this route is that a card is editable from
  // anywhere: a skill, an MCP call or a curl sending one field is the normal case, not an
  // edge case.
  const value = body.scheduleValue === undefined ? (existing.scheduleValue ?? '') : String(body.scheduleValue)
  const isOnce = String(kind) === 'once'
  const spec = {
    kind: String(kind),
    value,
    // Days and a window mean nothing on a one-off, and storing them anyway leaves junk that
    // the modal reads back the day somebody switches the card to a repeating cadence.
    days: isOnce ? null : optionalText(body, 'scheduleDays', existing.scheduleDays ?? null),
    window: isOnce ? null : optionalText(body, 'scheduleWindow', existing.scheduleWindow ?? null),
    tz: optionalText(body, 'scheduleTz', existing.scheduleTz ?? null),
    until: isOnce ? null : optionalText(body, 'scheduleUntil', existing.scheduleUntil ?? null),
  }
  const err = validateSchedule(spec)
  if (err) return { error: err }

  // A schedule that can never fire again is not a schedule. Usually that is an end date in
  // the past, but it is also a Sunday-only card ending on a Friday, so the message does not
  // claim the date has gone by: it says the card would never run, which is the fact that
  // matters and is true in both cases.
  if (spec.until && !isOnce && computeNextRunAt(spec) === null) {
    return { error: 'With that end date this card would never run again. Pick a later date, or add a day it can still land on.' }
  }

  // Store the cadence canonically. Number() happily accepts '0x12c', '3e2' and ' 300 ',
  // and every one of those would sit in the row looking like a typo nobody dares touch.
  const canonicalValue = spec.kind === 'every' ? String(Number(value)) : value

  // Did the schedule actually change, or is this a save that happens to carry the same
  // schedule it already had? See the note on scheduleState below: the difference decides
  // whether a card's failure record survives somebody pressing Save.
  const shapeChanged =
    String(kind) !== (existing.scheduleKind ?? null) ||
    canonicalValue !== (existing.scheduleValue ?? '') ||
    spec.days !== (existing.scheduleDays ?? null) ||
    spec.window !== (existing.scheduleWindow ?? null) ||
    spec.tz !== (existing.scheduleTz ?? null) ||
    spec.until !== (existing.scheduleUntil ?? null)

  // Armed unless the caller said otherwise. A card given a schedule is one the user
  // just asked to run; making them arm it in a second click is a step nobody wants.
  const enabled = body.scheduleEnabled === undefined ? true : !!body.scheduleEnabled
  return {
    fields: {
      scheduleKind: String(kind),
      scheduleValue: canonicalValue,
      scheduleDays: spec.days,
      scheduleWindow: spec.window,
      scheduleTz: spec.tz,
      scheduleUntil: spec.until,
      scheduleEnabled: enabled,
      nextRunAt: enabled ? computeNextRunAt(spec) : null,
      // ONLY A REAL CHANGE CLEARS THE STATE, and this is not a nicety.
      //
      // The modal sends all six shape fields on EVERY save, because it rebuilds them from
      // its own form state every time. Clearing on their mere presence meant that opening a
      // card the scheduler had switched off, reading its description and pressing Save
      // wiped schedule_state and consecutive_failures while leaving the card disarmed (the
      // Armed checkbox loads from the row, which is false). The card came back silently
      // dead: no pill saying why, no red dot, and no record that it had ever failed. The
      // one alert mechanism deleted itself on a save that changed nothing.
      //
      // Editing the schedule for real IS the user saying "try again", so that still clears
      // both: otherwise a re-armed card would disarm itself again on its next stumble.
      //
      // AND ONLY IF THE CARD IS ARMED AFTERWARDS. "Try again" is not what a save that leaves
      // the card switched off means. The realistic path is "this thing keeps breaking, let me
      // slow it down and park it until I can look at it", which is a cadence change and an
      // untick in ONE save: without the `enabled` test that save deleted the record of why it
      // was failing, which is the same silent death the paragraph above is about, reached
      // through the other door. A card that is armed here never had a state to clear anyway,
      // since every state the scheduler writes also switches the card off.
      ...(shapeChanged && enabled ? { scheduleState: null, consecutiveFailures: 0 } : {}),
    },
  }
}

// A task id is globally unique, so every one of these routes used to work no matter
// which :projectId you addressed it through. That meant a task could be edited, moved,
// blocked, commented on or DELETED through an unrelated project's URL. Every handler
// that takes both ids now goes through this: the task must actually live in the project
// named in the path, or it is a 404 (not a 403, so we do not confirm the id exists).
function resolveTask(projectId: string, taskId: string, reply: FastifyReply): PipelineTask | null {
  const task = taskManager.getTask(taskId)
  if (!task || task.projectId !== projectId) {
    reply.code(404)
    return null
  }
  return task
}

export default async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  // List all project pipelines. Always the lightweight shape (no history, no full
  // descriptions, no attachments): this feeds the all-projects board and the sidebar
  // badges, so it is fetched for every project at once and payload size matters.
  // ?includeDone=true keeps the light shape but stops filtering out done tasks, which is
  // what the all-projects board needs so its Done column is not structurally empty.
  app.get('/pipelines', async (request) => {
    const query = request.query as { includeDone?: string }
    const includeDone = query.includeDone === 'true'
    const rows = db.prepare('SELECT DISTINCT project_id FROM pipeline_tasks').all() as Array<{ project_id: string }>
    const pipelines: Record<string, unknown[]> = {}
    for (const row of rows) {
      pipelines[row.project_id] = taskManager.getTasksForProjectLight(row.project_id, includeDone)
    }
    return pipelines
  })

  // Get tasks for a specific project
  app.get('/pipelines/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const query = request.query as { includeDone?: string }
    return query.includeDone === 'true'
      ? taskManager.getTasksForProject(projectId, true)
      : taskManager.getTasksForProjectLight(projectId)
  })

  // Get single task (full payload with description)
  app.get('/pipelines/:projectId/tasks/:taskId', async (request, reply) => {
    const { projectId, taskId } = request.params as { projectId: string; taskId: string }
    const task = resolveTask(projectId, taskId, reply)
    if (!task) return { error: 'Task not found' }
    return task
  })

  // Create task
  app.post('/pipelines/:projectId/tasks', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const body = request.body as Record<string, unknown>

    // Validation. Without this a task can be created with a null title (a blank,
    // unidentifiable card) or an unknown column, which the board silently drops on
    // render: the task then exists in the DB, is returned by the API, and can never
    // be seen, moved or deleted from the UI again.
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) {
      reply.code(400)
      return { error: 'Task title is required' }
    }
    if (body.column !== undefined && !PIPELINE_COLUMNS.includes(body.column as PipelineColumn)) {
      reply.code(400)
      return { error: `Unknown column "${String(body.column)}". Expected one of: ${PIPELINE_COLUMNS.join(', ')}` }
    }
    if (body.priority !== undefined && ![1, 2, 3, 4].includes(body.priority as number)) {
      reply.code(400)
      return { error: 'Priority must be 1, 2, 3 or 4' }
    }
    if (typeof body.description === 'string' && body.description.length > MAX_DESCRIPTION_CHARS) {
      reply.code(400)
      return { error: `Description is ${body.description.length} characters, the limit is ${MAX_DESCRIPTION_CHARS}` }
    }

    // POST keeps the strict check. A card being CREATED against a chat that does not
    // exist is a client bug, not a chat somebody closed, and silently nulling it would
    // hide the bug and quietly aim the card at its project instead.
    if (body.targetInstanceId) {
      const inst = db.prepare('SELECT id FROM instances WHERE id = ?').get(body.targetInstanceId as string)
      if (!inst) { reply.code(400); return { error: 'targetInstanceId does not match an existing chat' } }
    }

    // A raw_prompt card sends its description as the whole message, so one created without
    // a description is a routine that can only ever fire an empty prompt. See the PUT below.
    const config = readTaskConfig(body)
    if (config.rawPrompt && !hasPrompt(typeof body.description === 'string' ? body.description : '')) {
      reply.code(400)
      return { error: EMPTY_RAW_PROMPT_MESSAGE }
    }

    const schedule = readSchedule(body, {})
    if ('error' in schedule) { reply.code(400); return { error: schedule.error } }

    const task = await taskManager.createTask({
      projectId,
      title,
      description: body.description as string | undefined,
      column: body.column as PipelineColumn | undefined,
      priority: body.priority as 1 | 2 | 3 | 4 | undefined,
      labels: body.labels as string[] | undefined,
      attachments: body.attachments as TaskAttachment[] | undefined,
      createdBy: body.createdBy as string | undefined,
      ...config,
      ...schedule.fields,
    })
    reply.code(201)
    return task
  })

  // Update task
  app.put('/pipelines/:projectId/tasks/:taskId', async (request, reply) => {
    const { projectId, taskId } = request.params as { projectId: string; taskId: string }
    const existing = resolveTask(projectId, taskId, reply)
    if (!existing) return { error: 'Task not found' }
    const body = request.body as Record<string, unknown>
    if (body.title !== undefined && !String(body.title).trim()) {
      reply.code(400)
      return { error: 'Task title cannot be empty' }
    }
    if (typeof body.description === 'string' && body.description.length > MAX_DESCRIPTION_CHARS) {
      reply.code(400)
      return { error: `Description is ${body.description.length} characters, the limit is ${MAX_DESCRIPTION_CHARS}` }
    }
    if (body.priority !== undefined && ![1, 2, 3, 4].includes(body.priority as number)) {
      reply.code(400)
      return { error: 'Priority must be 1, 2, 3 or 4' }
    }
    // THE ORPHANED CHAT. A scheduled card pinned to a chat that has since been closed used
    // to 400 the WHOLE edit, which meant the card could not be changed AT ALL: not its
    // schedule, not its title, not even to unpin it, and pinned chats get closed often enough
    // that most pinned cards end up in that state. A stale id now becomes NULL, which is the card's own "aim me at my
    // project and open a fresh chat each time" state, and the fact is logged rather than
    // thrown. POST still 400s (see above): there, a missing chat is a client bug.
    const config = readTaskConfig(body)
    if (config.targetInstanceId) {
      const inst = db.prepare('SELECT id FROM instances WHERE id = ?').get(config.targetInstanceId as string)
      if (!inst) {
        console.warn(
          `[pipeline] Card ${taskId.slice(0, 8)} was pinned to chat ${String(config.targetInstanceId).slice(0, 8)}, ` +
          'which no longer exists; clearing the pin so each run opens a fresh chat in the card\'s project'
        )
        config.targetInstanceId = null
      }
    }

    // A CARD THAT CAN FIRE MAY NOT BE EDITED INTO ONE THAT CANNOT.
    //
    // A raw_prompt card sends its description verbatim, with no template and no title to fall
    // back on, so an empty description is an empty message. A routine can fire with nothing
    // in it if the board's light copy, which carries no description, is saved back over the
    // real one. Both ways in are refused: blanking the description of
    // a raw card, and making a card with no description raw.
    //
    // The test is BEFORE AGAINST AFTER, not the after alone. A card that is already empty stays
    // editable, so it can still be paused, renamed or given its prompt back. Refusing every
    // save on it would be the orphaned-chat trap above, reached through a different field, and
    // the scheduler already refuses to fire it in the meantime.
    const nextDescription = body.description === undefined ? existing.description : String(body.description ?? '')
    const nextRawPrompt = config.rawPrompt === undefined ? !!existing.rawPrompt : !!config.rawPrompt
    if (!rawPromptIsEmpty(existing) && rawPromptIsEmpty({ rawPrompt: nextRawPrompt, description: nextDescription })) {
      reply.code(400)
      return { error: EMPTY_RAW_PROMPT_MESSAGE }
    }

    const schedule = readSchedule(body, existing)
    if ('error' in schedule) { reply.code(400); return { error: schedule.error } }

    const updated = taskManager.updateTask(taskId, {
      title: body.title as string | undefined,
      description: body.description as string | undefined,
      priority: body.priority as 1 | 2 | 3 | 4 | undefined,
      labels: body.labels as string[] | undefined,
      ...config,
      ...schedule.fields,
    })

    // Recompute the slot ONLY when the schedule itself changed (kind, value, or the on/off
    // switch). A rename or a description edit must not touch it: a card that is due and
    // waiting for a busy chat would otherwise lose that fire silently. readSchedule already
    // wrote next_run_at for a genuine schedule change; this covers arming or disarming on
    // its own, which arrives without a scheduleKind at all.
    //
    // ASK THE ROW WHAT HAPPENED, DO NOT INFER IT FROM THE REQUEST. This used to read
    // `body.scheduleEnabled !== undefined && ...`, which is not the same question, because
    // readSchedule ARMS a card whose save carries a schedule but no `scheduleEnabled` key
    // at all (`enabled = body.scheduleEnabled === undefined ? true : ...`). A caller
    // resending a card's current shape, which is the normal thing for a skill or a curl to
    // do, therefore armed a switched-off card through a branch that then decided nothing
    // had changed: the card came back live, red, and one strike from dying again. Comparing
    // the row before against the row after cannot drift away from what was really written.
    const armedNow = !!updated?.scheduleEnabled
    const armedChanged = armedNow !== !!existing.scheduleEnabled

    // ARMING IT AGAIN IS THE USER SAYING "I FIXED IT".
    //
    // A card the scheduler switched off carries the reason it stopped: 'failed' with a
    // failure count, 'over_budget', or 'finished'. Turning it back on without clearing
    // those leaves a card that is armed AND painted red, and, worse, one strike from being
    // switched off again, because the counter that disarmed it is still sitting at its
    // ceiling. So arming clears the state and the counter together, which is also what
    // readSchedule does when the schedule itself is edited. Disarming by hand does NOT
    // clear them: switching a failed card off should not erase why it failed.
    //
    // THIS HAS TO SIT OUTSIDE THE rescheduleTask BRANCH BELOW. It used to be gated on the
    // save arriving WITHOUT a scheduleKind, on the theory that a save carrying a schedule
    // was already handled by readSchedule. It is not: CreateTaskModal rebuilds all six
    // shape fields from its form state on EVERY save, so the real Armed re-tick always
    // arrives with a scheduleKind, and when the shape is otherwise unchanged readSchedule
    // deliberately clears nothing. The one path a user actually has back to a switched-off
    // card therefore cleared nothing at all: the card came back armed, with next_run_at
    // set, still painted red, still at 3 of 3 failures, and a 'finished' one still at its
    // run limit so it fired once and immediately re-finished. Only a hand-written PUT hit
    // the working path, which is exactly what the first B5 proof did.
    if (armedChanged && armedNow) {
      // run_count is reset ONLY for a card that has already used up its run limit. Without
      // that, arming a "Finished, 3 of 3 runs" card left the counter at 3, so it fired once
      // more, immediately re-finished, and logged "has run 4 time(s), which is its limit"
      // for a limit of 3: re-arm turned a schedule into a one-shot button. A card that was
      // merely paused keeps its count, because that count is its history.
      //
      // The test is the COUNT against the LIMIT, not schedule_state === 'finished'. State is
      // cleared by any real schedule edit, so a user who edited the cadence of a finished
      // card and only armed it on a second save arrived here with state already NULL and
      // run_count still sitting on the limit: the one-shot bug, one save further along.
      //
      // BOTH LIMITS ARE TESTED, the one being replaced and the one being saved, because Ends
      // and Armed are two controls on one form and arrive in one PUT. Reading only the old
      // one meant "Ends after 5 runs" lowered to 3 with a count of 4, or "Never" changed to
      // "after 3" with a count of 7, produced a card the board draws as perfectly healthy,
      // green pill, next run in 21 minutes, which fires exactly once and switches itself off
      // forever. Reading only the new one would undo the restart the user just asked for on
      // a finished card whose limit they raised. Arming is a restart: if the card has hit a
      // ceiling under either setting, the count goes back to zero.
      // Both read off the ROW, before and after, for the same reason armedNow does: the new
      // limit arrives through readTaskConfig, not through readSchedule, and a rule that has
      // to know which of two readers owns a field is a rule that will be wrong again later.
      const oldLimit = existing.scheduleMaxRuns ?? 0
      const newLimit = updated?.scheduleMaxRuns ?? 0
      const count = existing.runCount ?? 0
      const atLimit = (oldLimit > 0 && count >= oldLimit) || (newLimit > 0 && count >= newLimit)
      db.prepare(
        `UPDATE pipeline_tasks SET schedule_state = NULL, consecutive_failures = 0${atLimit ? ', run_count = 0' : ''} WHERE id = ?`
      ).run(taskId)
    }

    // Recompute the slot for an arm or disarm that arrived on its own, without a
    // scheduleKind: readSchedule already wrote next_run_at when the schedule itself came
    // with the save.
    if (armedChanged && !('scheduleKind' in schedule.fields)) {
      rescheduleTask(taskId)
    } else if (body.targetInstanceId !== undefined && body.targetInstanceId !== existing.targetInstanceId) {
      // Same slot, different target: the old wait no longer applies, the slot still does.
      db.prepare('UPDATE pipeline_tasks SET queued_since = NULL WHERE id = ?').run(taskId)
    }
    return taskManager.getTask(taskId) ?? updated
  })

  // ── Scheduled cards ────────────────────────────────────────────────────────
  // These two used to be POST /routines/:id/run-now and GET /routines/:id/runs. The
  // routines table is gone (migration047), so a schedule is a property of a card and its
  // run history hangs off the card id.

  // Fire immediately. Does not consume the scheduled slot, unless that slot is already due.
  app.post('/pipelines/:projectId/tasks/:taskId/run-now', async (request, reply) => {
    const { projectId, taskId } = request.params as { projectId: string; taskId: string }
    if (!resolveTask(projectId, taskId, reply)) return { error: 'Task not found' }
    const result = await runTaskNow(taskId)
    if (!result.ok && result.reason === 'not-found') { reply.code(404); return { error: 'That card has no schedule to run' } }
    if (!result.ok && result.reason === 'instance-busy') { reply.code(409); return { error: 'That chat is busy right now. Try again when its turn finishes.' } }
    // Nothing to fire on: the chat is gone and the fallback found no folder to open a new
    // one in, so the scheduler switched the schedule off. That is a state of the world the
    // user can fix, not a server fault, so it gets a 409 and a sentence saying what to do,
    // rather than a 500 carrying the raw 'instance-deleted' reason string.
    if (!result.ok && result.reason === 'instance-deleted') {
      reply.code(409)
      return { error: 'This card has no chat and no project to open one in. Edit it and pick one.' }
    }
    // Same shape of answer: the card is missing something the user can give it.
    if (!result.ok && result.reason === 'no-prompt') {
      reply.code(409)
      return { error: NO_PROMPT_MESSAGE }
    }
    if (!result.ok) { reply.code(500); return { error: result.reason || 'Failed to run this card' } }
    return { ok: true, runId: result.runId }
  })

  // Run history with per-run cost. Available for EVERY card, not only scheduled ones:
  // that is the point of the merge, though only a scheduled card has rows today.
  app.get('/pipelines/:projectId/tasks/:taskId/runs', async (request, reply) => {
    const { projectId, taskId } = request.params as { projectId: string; taskId: string }
    const { limit } = request.query as { limit?: string }
    if (!resolveTask(projectId, taskId, reply)) return { error: 'Task not found' }
    const lim = Math.min(Math.max(parseInt(limit || '50', 10) || 50, 1), 200)
    const rows = db.prepare(
      'SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?'
    ).all(taskId, lim) as TaskRunRow[]
    return { runs: rows.map(rowToRun) }
  })

  // Delete task
  app.delete('/pipelines/:projectId/tasks/:taskId', async (request, reply) => {
    const { projectId, taskId } = request.params as { projectId: string; taskId: string }
    if (!resolveTask(projectId, taskId, reply)) return { error: 'Task not found' }
    await taskManager.deleteTask(taskId)
    return { ok: true }
  })

  // Start an instance on this task (fresh instance, or an idle one the user picked)
  app.post('/pipelines/:projectId/tasks/:taskId/start', async (request, reply) => {
    const { projectId, taskId } = request.params as { projectId: string; taskId: string }
    if (!resolveTask(projectId, taskId, reply)) return { error: 'Task not found' }
    // startedBy is how the UI says "the user clicked this". Anything that does not say so is
    // treated as an agent, because that is the safe default: an agent's start is the one
    // that goes invisible. Advisory only (an agent could claim 'user'); it changes logging
    // and, for edit-session/summary, whether the chat surfaces. A card start surfaces
    // either way.
    const body = (request.body || {}) as { instanceId?: string; startedBy?: unknown }
    const startedBy = body.startedBy === 'user' ? 'user' : 'agent'
    try {
      const { startTask } = await import('../services/task-runner.js')
      return await startTask(taskId, { instanceId: body.instanceId, startedBy })
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      if (status) {
        reply.code(status)
        return { error: (err as Error).message }
      }
      throw err
    }
  })

  // Move task
  app.post('/pipelines/:projectId/tasks/:taskId/move', async (request, reply) => {
    const { projectId, taskId } = request.params as { projectId: string; taskId: string }
    if (!resolveTask(projectId, taskId, reply)) return { error: 'Task not found' }
    const { column, agent } = (request.body || {}) as { column: PipelineColumn; agent?: string }
    if (!PIPELINE_COLUMNS.includes(column)) {
      reply.code(400)
      return { error: `Unknown column "${String(column)}". Expected one of: ${PIPELINE_COLUMNS.join(', ')}` }
    }
    return taskManager.moveTask(taskId, column, agent || 'human')
  })

  // Block task
  app.post('/pipelines/:projectId/tasks/:taskId/block', async (request, reply) => {
    const { projectId, taskId } = request.params as { projectId: string; taskId: string }
    if (!resolveTask(projectId, taskId, reply)) return { error: 'Task not found' }
    const { reason, agent } = (request.body || {}) as { reason: string; agent?: string }
    return taskManager.blockTask(taskId, reason, agent)
  })

  // Unblock task
  app.post('/pipelines/:projectId/tasks/:taskId/unblock', async (request, reply) => {
    const { projectId, taskId } = request.params as { projectId: string; taskId: string }
    if (!resolveTask(projectId, taskId, reply)) return { error: 'Task not found' }
    // The client calls this with no body at all, and destructuring `undefined` threw a
    // 500 that PipelineContext swallowed into console.error. Unblock has therefore never
    // worked from the UI.
    const { agent } = (request.body || {}) as { agent?: string }
    return taskManager.unblockTask(taskId, agent)
  })

  // Get comments for a task
  app.get('/pipelines/:projectId/tasks/:taskId/comments', async (request, reply) => {
    const { projectId, taskId } = request.params as { projectId: string; taskId: string }
    if (!resolveTask(projectId, taskId, reply)) return []
    const rows = db.prepare(
      'SELECT id, task_id, author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at ASC'
    ).all(taskId) as Array<Record<string, unknown>>
    return rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      author: r.author,
      body: r.body,
      createdAt: r.created_at,
    } as TaskComment))
  })

  // Add a comment to a task
  app.post('/pipelines/:projectId/tasks/:taskId/comments', async (request, reply) => {
    const { projectId, taskId } = request.params as { projectId: string; taskId: string }
    // Without this the insert hits the task_comments foreign key and Fastify returns a
    // raw 500 with the SQLite constraint name in the body.
    if (!resolveTask(projectId, taskId, reply)) return { error: 'Task not found' }
    const body = request.body as { author?: string; body: string }
    if (!body.body?.trim()) {
      reply.code(400)
      return { error: 'Comment body is required' }
    }
    const now = Date.now()
    const author = body.author?.trim() || 'human'
    // Dedup guard 1: exact body match within 60s
    const exactDupe = db.prepare(
      'SELECT id FROM task_comments WHERE task_id = ? AND body = ? AND created_at > ?'
    ).get(taskId, body.body.trim(), now - 60_000) as Record<string, unknown> | undefined
    if (exactDupe) {
      reply.code(409)
      return { error: 'Duplicate comment', existingId: exactDupe.id }
    }
    // Dedup guard 2, for non-human authors: catch a rephrased repeat of the SAME comment
    // without blocking a genuinely different second comment. The old rule rejected any
    // second comment by the same author within 5 minutes, which silently dropped real
    // agent output. Compare the normalised opening instead: a repeat says the same thing
    // the same way for its first line or so, a new comment does not.
    if (author !== 'human') {
      const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80)
      const incoming = norm(body.body)
      const recent = db.prepare(
        'SELECT id, body FROM task_comments WHERE task_id = ? AND author = ? AND created_at > ?'
      ).all(taskId, author, now - 300_000) as Array<{ id: string; body: string }>
      const nearDupe = recent.find(r => norm(r.body) === incoming)
      if (nearDupe) {
        reply.code(409)
        return { error: 'Duplicate comment: same author repeated the same opening', existingId: nearDupe.id }
      }
    }
    const id = crypto.randomUUID()
    db.prepare(
      'INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, taskId, author, body.body.trim(), now)
    reply.code(201)
    return { id, taskId, author, body: body.body.trim(), createdAt: now } as TaskComment
  })
}
