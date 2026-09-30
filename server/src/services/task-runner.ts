import crypto from 'crypto'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import type { PipelineTask } from '@orcstrator/shared'
import * as taskManager from './task-manager.js'
import { processRegistry, agentSlot, AgentLimitError } from './process-registry.js'
import { preprocessImages, detectMediaType } from './image-processor.js'
import { setSurfaceSilent } from './surface.js'
import { buildTurnFlags, applyTaskCliSettings } from './turn-flags.js'
import { buildKickoffPrompt, kickoffComments, sendsVerbatim, hasPrompt, NO_PROMPT_MESSAGE } from './kickoff-prompt.js'
import { isScheduledCard, settleScheduledColumn, noteManualStart, isRunInFlight, closeFinishedChat, chatAboutToBeUsed, SELF_CLOSE_SETTLE_MS } from './task-scheduler.js'
import { claim, release, taskKey, chatKey, StartCancelledError } from './turn-gate.js'
import { storeImageBlock } from './message-media.js'
import { SELF_CLOSE_INSTRUCTION, withSelfCloseFooter } from './verdict.js'
import { readRunVerdict } from './run-verdict.js'

// ─────────────────────────────────────────────────────────────────────────────
// Task runner: "start an instance from a task".
//
// The human clicks Start on a pipeline task. We either create a fresh instance
// in the task's project folder or reuse an idle one the human picked, send the
// task (title + description + comments) as the kickoff prompt, and move the
// task to in_progress. When the turn finishes, the task moves to in_review and
// the instance's final message lands as a task comment.
//
// All state lives in the DB (instances.active_task_id, pipeline_tasks.instance_id)
// so the in_review hand-off survives a server restart mid-run.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_COMMENT_CHARS = 3000
const MAX_INSTANCE_NAME_CHARS = 40

/**
 * The card runs in flight, by chat: when each started and whether that start OPENED the chat.
 * A self-closing card's verdict is read only from messages written after `startedAt`
 * (run-verdict.ts), and only a chat the start opened is the card's to close. In memory on
 * purpose: after a restart the entry is gone, the start is unknown, and the verdict fails safe.
 */
const cardRuns = new Map<string, { taskId: string; startedAt: number; openedChat: boolean }>()

// The kickoff prompt (and both of its verbatim bypasses) now lives in kickoff-prompt.ts,
// because the scheduled fire in task-scheduler.ts has to build the byte-identical thing.
// Two builders is exactly how a card ends up meaning one thing when clicked and another
// at 3am, which is the same class of bug the flag builder was extracted to kill.

/**
 * Attachments are stored as data URLs by the create-task modal, but detectMediaType and
 * preprocessImages both want bare base64, the way /send receives it from a chat paste.
 * Returns null for anything that is not an image, so a stray attachment cannot reach the
 * image pipeline and throw inside sharp.
 */
function base64FromDataUrl(dataUrl: string): string | null {
  if (!dataUrl?.startsWith('data:image/')) return null
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const b64 = dataUrl.slice(comma + 1)
  return b64.length > 0 ? b64 : null
}

export interface StartTaskResult {
  task: PipelineTask
  instanceId: string
  created: boolean
}

export async function startTask(
  taskId: string,
  opts: { instanceId?: string; startedBy?: 'user' | 'agent' } = {}
): Promise<StartTaskResult> {
  // Claim the card before the first await. A scheduled fire of the same card takes
  // the same claim, so the two can no longer both start it; the second one backs off.
  const key = taskKey(taskId)
  const token = claim(key, 'task')
  if (!token) throw Object.assign(new Error('This card is already being started. Wait a moment, then look at its chat.'), { statusCode: 409 })
  // ...and the chat it will run in (the picked one, or the id the new one will get), so the
  // agent-limit check below and the start are one step for the limit, and a Stop on that chat
  // can cancel this start like any other.
  const chatId = opts.instanceId ?? crypto.randomUUID()
  const chatToken = claim(chatKey(chatId), 'turn')
  if (!chatToken) {
    release(key, token)
    throw Object.assign(new Error('This chat is already working. Wait for it to finish.'), { statusCode: 409 })
  }
  try {
    return await startTaskClaimed(taskId, opts, chatId, chatToken)
  } finally {
    release(chatKey(chatId), chatToken)
    release(key, token)
  }
}

async function startTaskClaimed(
  taskId: string,
  opts: { instanceId?: string; startedBy?: 'user' | 'agent' },
  chatId: string,
  chatToken: symbol,
): Promise<StartTaskResult> {
  const task = taskManager.getTask(taskId)
  if (!task) throw Object.assign(new Error('Task not found'), { statusCode: 404 })
  // A scheduled run of this card that is already going (its fire finished starting it): a
  // second, manual run on top of it is exactly the double run to prevent.
  const running = isRunInFlight(taskId)
  if (running) throw Object.assign(new Error('This card is already running. Open its chat to follow it.'), { statusCode: 409 })
  // The agent limit, checked before a chat is created or a message stored, so a
  // refused Start leaves nothing behind.
  const slot = agentSlot(chatId)
  if (!slot.ok) throw new AgentLimitError(slot.inUse, slot.max)

  const folder = db.prepare('SELECT id, path, stealth_mode FROM folders WHERE id = ?').get(task.projectId) as
    | { id: string; path: string; stealth_mode: number } | undefined
  if (!folder) throw Object.assign(new Error('Project folder not found'), { statusCode: 404 })

  // Kickoff prompt from the editable template, unless the card sends verbatim. Built FIRST,
  // before a chat is created, linked or the card moved, because a raw_prompt card with no
  // description builds an empty message, and refusing it after the spawn would leave an empty
  // tab and a card sitting in In Progress for a run that never started.
  const verbatim = sendsVerbatim(task)
  const prompt = buildKickoffPrompt(task, kickoffComments(task))
  if (!hasPrompt(prompt)) {
    console.log(`[task-runner] Refused to start "${task.title}": it sends its description verbatim and the description is empty`)
    throw Object.assign(new Error(NO_PROMPT_MESSAGE), { statusCode: 409 })
  }

  // Resolve target instance: human-picked idle instance, or a fresh one
  let instanceId: string
  let created = false
  if (opts.instanceId) {
    const inst = db.prepare('SELECT id, folder_id, process_state FROM instances WHERE id = ?').get(opts.instanceId) as
      | { id: string; folder_id: string; process_state: string } | undefined
    if (!inst) throw Object.assign(new Error('Instance not found'), { statusCode: 404 })
    if (inst.folder_id !== task.projectId) throw Object.assign(new Error('Instance belongs to a different project'), { statusCode: 400 })
    if (inst.process_state !== 'idle' || processRegistry.isTracked(inst.id)) {
      throw Object.assign(new Error('This chat is already working. Wait for it to finish.'), { statusCode: 409 })
    }
    instanceId = inst.id
  } else {
    instanceId = chatId
    created = true
    const name = task.title.length > MAX_INSTANCE_NAME_CHARS
      ? task.title.slice(0, MAX_INSTANCE_NAME_CHARS - 1) + '…'
      : task.title
    db.prepare(`
      INSERT INTO instances (id, folder_id, name, cwd, session_id, state, agent_id, idle_restart_minutes, sort_order, created_at)
      VALUES (?, ?, ?, ?, NULL, 'idle', NULL, 0, 9999, ?)
    `).run(instanceId, task.projectId, name, folder.path, Date.now())
    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId) as Record<string, unknown>
    broadcastEvent({
      type: 'instance:created',
      payload: {
        id: row.id, folderId: row.folder_id, name: row.name, cwd: row.cwd,
        sessionId: undefined, state: 'idle', agentId: undefined,
        idleRestartMinutes: 0, sortOrder: row.sort_order, createdAt: row.created_at,
      },
    })
  }

  // Link both directions: instance → task drives cost attribution + the
  // turn-complete hand-off; task → instance powers the "Open instance" button.
  db.prepare('UPDATE instances SET active_task_id = ? WHERE id = ?').run(taskId, instanceId)
  db.prepare('UPDATE pipeline_tasks SET instance_id = ?, updated_at = ? WHERE id = ?').run(instanceId, Date.now(), taskId)

  if (task.column !== 'in_progress') {
    taskManager.moveTask(taskId, 'in_progress', 'orcstrator')
  }

  // The card's own run settings, layered over the global flags, with the global defaults
  // filling whatever is still unset. ONE builder, shared with the scheduled fire: the
  // Settings page's "default effort" used to be silently dropped by every card start
  // because this call site rolled its own and only ever added --model.
  const taskSettings = db.prepare(
    'SELECT model, effort, permission_mode, max_budget_usd, fallback_model, output_style, language FROM pipeline_tasks WHERE id = ?'
  ).get(taskId) as {
    model: string | null; effort: string | null; permission_mode: string | null
    max_budget_usd: number | null; fallback_model: string | null
    output_style: string | null; language: string | null
  }
  const flags = buildTurnFlags(taskSettings)

  let agentPrompt: string | undefined
  if (folder.stealth_mode) {
    agentPrompt = 'STEALTH MODE: Do not use the Memory tool. Do not create or update any CLAUDE.md memory files. Do not persist any context between conversations.'
  }
  // A self-closing card is told how to prove it succeeded (verdict.ts) twice: in the system
  // prompt, and at the END of the kickoff, because the system prompt alone was not enough
  // (measured, see verdict.ts). After the text, never before it: a verbatim /command keeps its
  // first character.
  let kickoff = prompt
  if (task.selfClose) {
    agentPrompt = agentPrompt ? `${agentPrompt}\n\n${SELF_CLOSE_INSTRUCTION}` : SELF_CLOSE_INSTRUCTION
    kickoff = withSelfCloseFooter(prompt)
  }

  // Attachments ride INLINE into the kickoff, down the exact path a chat paste takes:
  // detectMediaType + preprocessImages, then the images go to sendMessage alongside the
  // text. Previously a task could carry a screenshot, show its thumbnail on the card, and
  // start an instance that never saw the picture, because buildKickoffPrompt interpolates
  // only title, description and comments. A screenshot plus "fix this bug" is a typical
  // smallest unit of work, so the screenshot has to arrive.
  let processedImages: Array<{ base64: string; mediaType: string }> | undefined
  let imageTextPrefix = ''
  const rawAttachments = (task.attachments || [])
    .map(a => base64FromDataUrl(a.dataUrl))
    .filter((b): b is string => !!b)
    .map(b64 => ({ base64: b64, mediaType: detectMediaType(b64) }))
  if (rawAttachments.length > 0) {
    try {
      const preprocessed = await preprocessImages(rawAttachments)
      processedImages = preprocessed.images
      imageTextPrefix = preprocessed.textPrefix
    } catch (err) {
      // A corrupt attachment must not block the task from starting at all.
      console.error(`[task-runner] Could not process attachments for task ${taskId}:`, err)
    }
  }

  // Persist + broadcast the kickoff as a user message so the chat reads naturally
  const msgId = crypto.randomUUID()
  const now = Date.now()
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: kickoff }]
  // Card attachments go to the media store like a pasted image: the history row keeps a url and a
  // small thumbnail, not the full picture. storeImageBlock falls back to inline.
  for (const img of rawAttachments) {
    content.push({ ...(await storeImageBlock(img.base64, img.mediaType)) })
  }
  db.prepare('INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(msgId, instanceId, 'user', JSON.stringify(content), now)
  broadcastEvent({
    type: 'message:added',
    payload: { instanceId, message: { id: msgId, instanceId, role: 'user', content, createdAt: now } },
  })

  const startedBy = opts.startedBy === 'user' ? 'user' : 'agent'
  console.log(`[task-runner] Starting task "${task.title}" → instance ${instanceId.slice(0, 8)} (${created ? 'new' : 'existing'}, startedBy=${startedBy})`)

  // A card start is a deliberate, visible event, so it ends any silent chain on the chat
  // exactly as a hand-typed message does. A fresh chat is never silent anyway; this only
  // matters when the card is started on an existing chat that a silent routine once fired
  // on, where inheriting that silence would hide the start the user just asked for.
  setSurfaceSilent(instanceId, false)
  // Output style and language are not argv: they ride the managed --settings file, built
  // from the instance row at spawn. Stamp them before the spawn or they miss this turn.
  applyTaskCliSettings(instanceId, taskSettings)

  // Lazy import (same pattern as the task/wakeup schedulers) to avoid a static cycle
  const { sendMessage } = await import('./claude-process.js')
  const inst = db.prepare('SELECT cwd, session_id FROM instances WHERE id = ?').get(instanceId) as { cwd: string; session_id: string | null }
  cardRuns.set(instanceId, { taskId, startedAt: now, openedChat: created })
  try {
    await sendMessage({
      instanceId,
      // Verbatim (slash-command passthrough or raw_prompt): the prefix would push the
      // command off character zero and the CLI only fires one that starts the message.
      text: verbatim ? kickoff : imageTextPrefix + kickoff,
      images: processedImages,
      cwd: inst.cwd,
      sessionId: inst.session_id ?? undefined,
      flags,
      agentPrompt,
      // Always surfaces, clicked or over HTTP. The server cannot tell the two apart and
      // must not try: a card started by hand is one the user walked away from too.
      origin: 'task',
      taskId,
      gateToken: chatToken,
      startedBy,
    })
  } catch (err) {
    // Spawn failed: unlink so the task isn't stuck pointing at a dead run
    db.prepare('UPDATE instances SET active_task_id = NULL WHERE id = ?').run(instanceId)
    cardRuns.delete(instanceId)
    // Stopped before it started: the card goes back where it was, not left "in progress"
    // with nothing running on it.
    if (err instanceof StartCancelledError && task.column !== 'in_progress') taskManager.moveTask(taskId, task.column, 'orcstrator')
    throw err
  }

  // STARTING A SCHEDULED CARD BY HAND IS RUNNING IT, so the schedule has to hear about it.
  // Only once the turn is actually away: a start that threw above never happened, and must
  // not eat the slot the scheduler would otherwise have used. No-op for an ordinary card.
  noteManualStart(taskId, instanceId, created)

  return { task: taskManager.getTask(taskId)!, instanceId, created }
}

/**
 * Apply the status the user picked in the Close Session dialog.
 *
 * Called from secure-close BEFORE anything destructive runs, so the status is durable
 * whether or not the summary that follows ever arrives.
 *
 * 'inbox' also clears the task's instance link: the instance is about to be deleted, so
 * leaving the link would give the re-queued task an "Open instance" button pointing at a
 * session that no longer exists.
 */
export function applyCloseStatus(taskId: string, status: 'done' | 'inbox'): void {
  try {
    const task = taskManager.getTask(taskId)
    if (!task) return
    const column = status === 'done' ? 'done' : 'backlog'
    if (task.column !== column) taskManager.moveTask(taskId, column, 'orcstrator')
    if (status === 'inbox') {
      db.prepare('UPDATE pipeline_tasks SET instance_id = NULL, updated_at = ? WHERE id = ?')
        .run(Date.now(), taskId)
    }
  } catch (err) {
    console.error(`[task-runner] could not apply close status to task ${taskId}:`, err)
  }
}

/**
 * Last assistant message text for an instance, for the hand-off comment. `since` scopes it to
 * one run (self-closing cards pass it): on a reused chat the latest row can be an EARLIER run's,
 * and a card must not be filed a summary, least of all a `RESULT: OK`, that it never wrote.
 */
function lastAssistantText(instanceId: string, since?: number): string | null {
  const row = (since == null
    ? db.prepare(
      "SELECT content FROM messages WHERE instance_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1"
    ).get(instanceId)
    : db.prepare(
      "SELECT content FROM messages WHERE instance_id = ? AND role = 'assistant' AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
    ).get(instanceId, since)) as { content: string } | undefined
  if (!row) return null
  try {
    const blocks = JSON.parse(row.content) as Array<{ type: string; text?: string }>
    const text = blocks.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n').trim()
    return text || null
  } catch {
    return null
  }
}

/** Turn finished on an instance linked to a task → move to in_review + comment. */
function handleTurnComplete(instanceId: string, exitCode: number | null): void {
  const run = cardRuns.get(instanceId)
  const inst = db.prepare('SELECT name, active_task_id FROM instances WHERE id = ?').get(instanceId) as
    | { name: string; active_task_id: string | null } | undefined
  if (!inst?.active_task_id) return
  // Only the card's own turn: an entry for another card (a stale one) is not this run's start.
  cardRuns.delete(instanceId)
  const thisRun = run?.taskId === inst.active_task_id ? run : undefined

  const taskId = inst.active_task_id
  // Clear the link first: follow-up chat turns on this instance must not
  // re-trigger the hand-off. task.instance_id stays for "Open instance".
  db.prepare('UPDATE instances SET active_task_id = NULL WHERE id = ?').run(instanceId)

  const task = taskManager.getTask(taskId)
  if (!task) return

  // Roll the attributed turn costs up into the task totals (turn_costs.task_id is
  // stamped during the run from instances.active_task_id)
  // One indexed read (idx_turn_costs_task), not three full scans of turn_costs.
  try {
    const t = db.prepare(`
      SELECT COALESCE(SUM(input_tokens), 0) AS tin, COALESCE(SUM(output_tokens), 0) AS tout,
             COALESCE(SUM(COALESCE(NULLIF(cost_usd, 0), computed_cost_usd, 0)), 0) AS cost
        FROM turn_costs WHERE task_id = ?
    `).get(taskId) as { tin: number; tout: number; cost: number }
    db.prepare('UPDATE pipeline_tasks SET total_input_tokens = ?, total_output_tokens = ?, total_cost_usd = ? WHERE id = ?')
      .run(t.tin, t.tout, t.cost, taskId)
  } catch (err) {
    console.error(`[task-runner] cost roll-up failed for task ${taskId}:`, err)
  }

  // A card that carries a schedule is standing work, not a hand-off. It goes back to
  // Backlog to wait for its next slot (or to Done if it was a one-off), and it does NOT
  // collect a comment: a daily automation would otherwise file 365 of them a year and
  // bury the ones a human actually wrote. This is the ONE place a card's column is
  // decided after a turn, for both kinds, so the two can never disagree about it.
  // A self-closing card that only BECAME scheduled during this run (a schedule saved while it was
  // In Progress) has no run the scheduler tracked, so nothing there would read its verdict. It
  // settles as the manual card it was started as.
  const untrackedSelfClose = task.selfClose && thisRun != null && !db.prepare(
    'SELECT 1 FROM task_runs WHERE task_id = ? AND started_at >= ? LIMIT 1'
  ).get(taskId, thisRun.startedAt)
  if (isScheduledCard(taskId) && !untrackedSelfClose) {
    settleScheduledColumn(taskId)
    console.log(`[task-runner] Scheduled card "${task.title}" settled after its run (instance ${instanceId.slice(0, 8)} finished)`)
    return
  }

  try {
    // A self-closing card reads only its own run (with no known start, nothing).
    const summary = task.selfClose ? lastAssistantText(instanceId, thisRun?.startedAt ?? Number.MAX_SAFE_INTEGER) : lastAssistantText(instanceId)
    if (summary) {
      const commentId = crypto.randomUUID()
      db.prepare('INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(commentId, taskId, inst.name, summary.slice(0, MAX_COMMENT_CHARS), Date.now())
    }
  } catch (err) {
    console.error(`[task-runner] comment hand-off failed for task ${taskId}:`, err)
  }

  if (task.selfClose) {
    settleSelfClosingCard(task, instanceId, inst.name, thisRun, exitCode)
    return
  }

  if (task.column === 'in_progress') {
    try {
      taskManager.moveTask(taskId, 'in_review', inst.name)
    } catch (err) {
      console.error(`[task-runner] move to in_review failed for task ${taskId}:`, err)
    }
  }
  console.log(`[task-runner] Task "${task.title}" → in_review (instance ${instanceId.slice(0, 8)} finished)`)
}

/**
 * A self-closing manual card's turn is over (the summary comment is already written).
 *
 * ABSENCE OF PROOF IS FAILURE (verdict.ts). Only a clean exit whose own final message ends in
 * `RESULT: OK` sends the card to Done and closes its chat. Everything else sends it to In
 * Review with the reason as a comment, and the chat is kept: it is the evidence.
 */
function settleSelfClosingCard(
  task: PipelineTask,
  instanceId: string,
  author: string,
  run: { startedAt: number; openedChat: boolean } | undefined,
  exitCode: number | null,
): void {
  const verdict = readRunVerdict({
    instanceId,
    since: run?.startedAt ?? null,
    exitCode,
    stoppedByUser: run != null && processRegistry.stoppedByUserSince(instanceId, run.startedAt),
  })

  if (!verdict.ok) {
    try {
      db.prepare('INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), task.id, 'orcstrator', `Needs review: ${verdict.reason}`.slice(0, MAX_COMMENT_CHARS), Date.now())
    } catch (err) {
      console.error(`[task-runner] needs-review comment failed for task ${task.id}:`, err)
    }
    if (task.column === 'in_progress') {
      try { taskManager.moveTask(task.id, 'in_review', author) } catch (err) {
        console.error(`[task-runner] move to in_review failed for task ${task.id}:`, err)
      }
    }
    console.log(`[task-runner] Task "${task.title}" → in_review, needs review (${verdict.reason}); chat ${instanceId.slice(0, 8)} kept`)
    return
  }

  applyCloseStatus(task.id, 'done')
  console.log(`[task-runner] Task "${task.title}" → done, closed itself on RESULT: OK (instance ${instanceId.slice(0, 8)})`)

  // THE CARD IS DONE; THE CHAT IS CLOSED ONLY IF IT IS THE CARD'S TO CLOSE. A chat the user
  // picked for this start (or the card is pinned to) holds history that is not the card's, and
  // `messages` cascades from `instances`, so closing it would take that history with it.
  const pinned = task.targetInstanceId === instanceId
  if (pinned || !run?.openedChat) {
    console.log(`[task-runner] "${task.title}": chat ${instanceId.slice(0, 8)} was ${pinned ? 'pinned to the card' : 'not opened by this run'}, so it was not closed`)
    return
  }
  // Deferred, so a /btw follow-up or a retry about to start here claims the chat first, and
  // the close then sees it and leaves the chat alone.
  setTimeout(() => {
    void (async () => {
      const soon = await chatAboutToBeUsed(instanceId)
      if (soon) {
        console.warn(`[task-runner] "${task.title}": chat ${instanceId.slice(0, 8)} ${soon}, so it was left open rather than closed`)
        return
      }
      await closeFinishedChat(task.id, task.title, instanceId, { keepSession: false, secure: true })
    })().catch(err => console.warn(`[task-runner] "${task.title}": closing chat ${instanceId.slice(0, 8)} failed: ${(err as Error).message}`))
  }, SELF_CLOSE_SETTLE_MS)
}

let unsubscribe: (() => void) | null = null

export function startTaskRunner(): void {
  if (unsubscribe) return
  void import('./claude-process.js').then(mod => {
    unsubscribe = mod.onTurnComplete((instanceId, _tokens, exitCode) => {
      try { handleTurnComplete(instanceId, exitCode) } catch (err) {
        console.error('[task-runner] turn-complete handler error:', err)
      }
    })
  })
  console.log('[task-runner] Task runner started')
}

export function stopTaskRunner(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
}
