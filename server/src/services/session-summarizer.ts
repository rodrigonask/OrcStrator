// Session summary on close.
//
// Closing a session is the only moment the user reliably tells the app that a piece of work
// is finished, so it is the only moment worth spending a summary on. One Haiku call over
// the tail of the transcript, filed as a comment on the task the session came from.
//
// THE ORDERING IS THE FEATURE, not an implementation detail. `secure-close` scrubs the
// session file, kills the process, then runs DELETE FROM instances, and `messages` is
// declared REFERENCES instances(id) ON DELETE CASCADE with foreign keys ON. Closing a
// session destroys its transcript. So the caller must capture first (captureForSummary),
// let the close proceed, and only then hand the in-memory copy here. "Close it, then
// summarize" reads an empty table. Reading the JSONL back off disk afterwards is no better:
// it depends on the session-slug path, which is exactly what goes wrong when a worktree
// cwd changes.
//
// The second property that ordering buys: the task status is committed before anything
// destructive runs, so a failed Haiku call can never cost a status. The summary is
// best-effort; the status is not.
//
// Same encrypted Anthropic key as instance-namer, same never-throws discipline.
import { db } from '../db.js'
import crypto from 'crypto'
import { broadcastEvent } from '../ws/handler.js'
import { getAnthropicKey } from './instance-namer.js'
import { readNativeTasks } from './native-tasks.js'
import * as taskManager from './task-manager.js'
import type { NativeTask } from '@orcstrator/shared'
import { redactSecrets } from '@orcstrator/shared'

const SUMMARY_MODEL = 'claude-haiku-4-5'   // authoritative API id (claude-api skill)
const TAIL_MESSAGES = 20                   // measured: ~2,950 tokens median, ~$0.005 a close
const MAX_CHARS_PER_MESSAGE = 4000
const MAX_SUMMARY_CHARS = 3000
const MAX_TOKENS = 500
const REQUEST_TIMEOUT_MS = 30_000

export type SessionSummaryMode = 'all' | 'tasks' | 'off'

export interface CapturedSession {
  instanceId: string
  instanceName: string
  /** Needed to file a log task for a chat that came from no task. */
  folderId: string
  taskId: string | null
  /** Oldest-first, already flattened to text. */
  transcript: Array<{ role: string; text: string }>
  nativeTasks: NativeTask[]
  /**
   * When the work actually happened. Null only for a chat that never ran a turn.
   *
   * This has to be captured here for the same reason the transcript does: `messages`
   * cascades away with the instance. `turn_costs` does NOT cascade, so it is read as
   * well and the two are unioned - a chat compacted down to a short tail still has all
   * of its turn rows, and a chat whose turns predate turn-cost tracking still has its
   * messages.
   */
  workStartedAt: number | null
  workEndedAt: number | null
}

function getSetting<T>(key: string, fallback: T): T {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : fallback
  } catch {
    return fallback
  }
}

export function getSummaryMode(): SessionSummaryMode {
  const mode = getSetting<string>('sessionSummaryMode', 'tasks')
  return mode === 'all' || mode === 'off' ? mode : 'tasks'
}

/** Flatten a stored message's content blocks down to plain text. */
function blocksToText(raw: string): string {
  try {
    const blocks = JSON.parse(raw) as Array<{ type: string; text?: string }>
    return blocks
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text as string)
      .join('\n')
      .trim()
  } catch {
    return ''
  }
}

/**
 * The first and last moment this chat did anything, unioned across the two tables that
 * know. Call it before the close, while `messages` is still there.
 */
function readWorkSpan(instanceId: string, sessionId: string | null): { startedAt: number | null; endedAt: number | null } {
  const widen = (
    acc: { startedAt: number | null; endedAt: number | null },
    row: { a: number | null; b: number | null } | undefined
  ) => {
    if (!row) return acc
    if (row.a != null) acc.startedAt = acc.startedAt == null ? row.a : Math.min(acc.startedAt, row.a)
    if (row.b != null) acc.endedAt = acc.endedAt == null ? row.b : Math.max(acc.endedAt, row.b)
    return acc
  }

  const span: { startedAt: number | null; endedAt: number | null } = { startedAt: null, endedAt: null }
  try {
    widen(span, db.prepare('SELECT MIN(created_at) AS a, MAX(created_at) AS b FROM messages WHERE instance_id = ?')
      .get(instanceId) as { a: number | null; b: number | null } | undefined)
    // Matched on session_id too: resuming a chat into a fresh instance row keeps the
    // session, and the turns before the resume belong to the same piece of work.
    widen(span, db.prepare(
      'SELECT MIN(created_at) AS a, MAX(created_at) AS b FROM turn_costs WHERE instance_id = ? OR (session_id IS NOT NULL AND session_id = ?)'
    ).get(instanceId, sessionId) as { a: number | null; b: number | null } | undefined)
  } catch (err) {
    console.error('[session-summarizer] could not read the work span:', err)
  }
  return span
}

/**
 * Read everything the summary will need WHILE THE INSTANCE STILL EXISTS.
 *
 * Call this before secure-close does anything destructive. Reads the last messages out of
 * the DB (they cascade away with the instance) and the native task files off disk (the
 * scrub rewrites the session file). Never throws: a capture failure must not block a close.
 */
export function captureForSummary(instanceId: string): CapturedSession | null {
  try {
    const inst = db.prepare('SELECT id, name, folder_id, session_id, active_task_id FROM instances WHERE id = ?')
      .get(instanceId) as { id: string; name: string; folder_id: string; session_id: string | null; active_task_id: string | null } | undefined
    if (!inst) return null

    // pipeline_tasks.instance_id outlives active_task_id: the runner clears active_task_id
    // the moment a turn completes, but the task keeps pointing at the instance. Prefer the
    // live link, fall back to the durable one, so a task whose turn already finished still
    // gets its summary.
    let taskId = inst.active_task_id
    if (!taskId) {
      const row = db.prepare('SELECT id FROM pipeline_tasks WHERE instance_id = ? ORDER BY updated_at DESC LIMIT 1')
        .get(instanceId) as { id: string } | undefined
      taskId = row?.id ?? null
    }

    const rows = db.prepare(
      'SELECT role, content FROM messages WHERE instance_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(instanceId, TAIL_MESSAGES) as Array<{ role: string; content: string }>

    const transcript = rows
      .reverse()   // query is newest-first; a transcript reads oldest-first
      // Redacted here, before anything else sees it: this text is sent to a model for
      // the close summary and lands in a task comment.
      .map(r => ({ role: r.role, text: redactSecrets(blocksToText(r.content)).redacted.slice(0, MAX_CHARS_PER_MESSAGE) }))
      .filter(m => m.text.length > 0)

    const span = readWorkSpan(instanceId, inst.session_id)

    return {
      instanceId,
      instanceName: inst.name,
      folderId: inst.folder_id,
      taskId,
      transcript,
      nativeTasks: readNativeTasks(inst.session_id),
      workStartedAt: span.startedAt,
      workEndedAt: span.endedAt,
    }
  } catch (err) {
    console.error('[session-summarizer] capture failed:', err)
    return null
  }
}

/** Should this capture get a Haiku call at all? */
export function shouldSummarize(captured: CapturedSession | null): boolean {
  if (!captured) return false
  const mode = getSummaryMode()
  if (mode === 'off') return false
  if (mode === 'tasks' && !captured.taskId) return false
  if (!captured.transcript.length) return false
  return !!getAnthropicKey()
}

function buildPrompt(captured: CapturedSession): string {
  const parts: string[] = []
  parts.push('## Transcript (last messages of the session)')
  for (const m of captured.transcript) {
    parts.push(`### ${m.role === 'user' ? 'User' : 'Assistant'}\n${m.text}`)
  }
  if (captured.nativeTasks.length) {
    parts.push('## The session\'s own task list')
    for (const t of captured.nativeTasks) {
      parts.push(`- [${t.status}] ${t.subject}`)
    }
  }
  return redactSecrets(parts.join('\n\n')).redacted
}

/** One Haiku call → a short summary, or null on any failure. Never throws. */
async function generateSummary(captured: CapturedSession): Promise<string | null> {
  const key = getAnthropicKey()
  if (!key) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        max_tokens: MAX_TOKENS,
        system:
          'You summarize a finished coding session for someone who will read it weeks later ' +
          'with no memory of it. Write plain prose in at most 120 words: what was actually ' +
          'done, what was decided, and anything left unfinished. If the session\'s own task ' +
          'list is included, say which of those tasks were completed and which were not. ' +
          'Do not use headings, bullet points, or a preamble. Do not use em dashes. ' +
          'If the transcript shows no real work, say so in one sentence.',
        messages: [{ role: 'user', content: buildPrompt(captured) }],
      }),
    })
    if (!resp.ok) {
      console.log(`[session-summarizer] summary call failed: HTTP ${resp.status}`)
      return null
    }
    const data = await resp.json() as { stop_reason?: string; content?: Array<{ type: string; text?: string }> }
    if (data.stop_reason === 'refusal') return null
    const out = (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join(' ').trim()
    return out ? out.slice(0, MAX_SUMMARY_CHARS) : null
  } catch (e) {
    console.log('[session-summarizer] summary call error:', e instanceof Error ? e.message : e)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Task title for the close notification, or null if the task is already gone. */
function taskTitle(taskId: string): string | null {
  try {
    const row = db.prepare('SELECT title FROM pipeline_tasks WHERE id = ?').get(taskId) as { title: string } | undefined
    return row?.title ?? null
  } catch {
    return null
  }
}

function postComment(taskId: string, author: string, body: string): void {
  try {
    // The task may have been deleted between the close and the summary landing.
    const exists = db.prepare('SELECT 1 FROM pipeline_tasks WHERE id = ?').get(taskId)
    if (!exists) return
    db.prepare('INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), taskId, author, body.slice(0, MAX_SUMMARY_CHARS), Date.now())
    broadcastEvent({ type: 'pipeline:updated', payload: { action: 'updated', taskId } })
  } catch (err) {
    console.error('[session-summarizer] could not post comment:', err)
  }
}

/**
 * A card with a schedule keeps its close summaries in its RUN HISTORY, not its comments.
 * A daily routine would otherwise file one comment a day, and the comments a human wrote
 * would be buried under them. Lands on the newest run this chat did, else the card's newest
 * run. False when there is no run to hold it (the caller then posts a comment, so the
 * summary is never simply dropped).
 */
function attachToRun(taskId: string, instanceId: string, body: string): boolean {
  try {
    const card = db.prepare('SELECT schedule_kind FROM pipeline_tasks WHERE id = ?').get(taskId) as
      | { schedule_kind: string | null } | undefined
    if (!card?.schedule_kind) return false
    const run = (db.prepare(
      'SELECT id FROM task_runs WHERE task_id = ? AND instance_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(taskId, instanceId) ?? db.prepare(
      'SELECT id FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(taskId)) as { id: string } | undefined
    if (!run) return false
    db.prepare('UPDATE task_runs SET summary = ? WHERE id = ?').run(body.slice(0, MAX_SUMMARY_CHARS), run.id)
    // Bumped so an open card panel sees a change and refetches its runs.
    db.prepare('UPDATE pipeline_tasks SET updated_at = ? WHERE id = ?').run(Date.now(), taskId)
    broadcastEvent({ type: 'pipeline:updated', payload: { action: 'updated', taskId } })
    return true
  } catch (err) {
    console.error('[session-summarizer] could not attach summary to a run:', err)
    return false
  }
}

/**
 * File a closed chat that came from no task AS a task, so nothing worked on goes
 * unrecorded. Only under Session Summary = 'all'; that mode's whole point is that the
 * record is the deliverable, and a summary with nowhere to live is not a record.
 *
 * Lands in Done, because the session it describes is already over. Returns the new task id.
 */
function logClosedChatAsTask(captured: CapturedSession, body: string): string | null {
  try {
    const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(captured.folderId)
    if (!folder) return null
    const task = taskManager.createTask({
      projectId: captured.folderId,
      title: captured.instanceName,
      description: body,
      column: 'done',
      priority: 3,
      labels: ['session-log'],
      createdBy: 'orcstrator',
      // Without these the row's only date is "now", the moment of the close. A chat left
      // open for three weeks would file itself as today's work.
      workStartedAt: captured.workStartedAt ?? undefined,
      workEndedAt: captured.workEndedAt ?? undefined,
    })
    return task?.id ?? null
  } catch (err) {
    console.error('[session-summarizer] could not log the closed chat as a task:', err)
    return null
  }
}

/**
 * Fire-and-forget. Runs AFTER the close has already returned, so the tab shuts instantly
 * and the user never waits on the network. Safe to call without awaiting: it never throws.
 *
 * Where the result goes depends on whether the session came from a task:
 *   - from a task  -> a comment on that task, keeping the task's history in one place
 *   - from a routine -> the summary of its newest run (see attachToRun), never a comment
 *   - from no task -> a NEW task in that project carrying the summary (mode 'all' only)
 *
 * Either way something is written even when the call fails. Silence would read as "the
 * summary is still coming" forever.
 */
export async function summarizeInBackground(captured: CapturedSession): Promise<void> {
  const author = `${captured.instanceName} (summary)`
  try {
    const summary = await generateSummary(captured)
    const body = summary ?? (
      'Session closed. The summary was unavailable, so this is a placeholder: '
      + `${captured.transcript.length} messages and ${captured.nativeTasks.length} task list entries were captured, `
      + 'but the summarization call did not return.'
    )

    let loggedTaskId: string | null = null
    if (captured.taskId) {
      // A task that ran this chat gets the span too, widened rather than overwritten:
      // the same task is often picked up again in a second chat days later.
      taskManager.recordWorkSpan(captured.taskId, captured.workStartedAt, captured.workEndedAt)
      if (!attachToRun(captured.taskId, captured.instanceId, body)) postComment(captured.taskId, author, body)
    } else if (getSummaryMode() === 'all') {
      loggedTaskId = logClosedChatAsTask(captured, body)
      if (loggedTaskId) broadcastEvent({ type: 'pipeline:updated', payload: { action: 'created', taskId: loggedTaskId } })
    }

    // The client names the destination in its notification, and by the time this fires the
    // instance is deleted, so the name has to travel with the event.
    const landedOn = captured.taskId ?? loggedTaskId
    broadcastEvent({
      type: 'session:summary',
      payload: {
        instanceId: captured.instanceId,
        instanceName: captured.instanceName,
        taskId: landedOn,
        taskTitle: landedOn ? taskTitle(landedOn) : null,
        summary,
        ok: !!summary,
        loggedAsNewTask: !!loggedTaskId,
      },
    })
  } catch (err) {
    console.error('[session-summarizer] background summary failed:', err)
  }
}
