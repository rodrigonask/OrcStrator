import { db } from '../db.js'
import { DEFAULT_TASK_KICKOFF_TEMPLATE } from '@orcstrator/shared'
import type { PipelineTask, TaskComment } from '@orcstrator/shared'

// ─────────────────────────────────────────────────────────────────────────────
// What a card actually SENDS. One builder, used by the manual start and by the
// scheduled fire, so a card cannot mean one thing when clicked and another at 3am.
//
// There are TWO bypasses of the kickoff template and they are deliberately separate
// branches. Merging them looks like a tidy-up and is not: they answer different
// questions (what the text starts with, versus what the card was configured as) and
// folding either into the template path is how a parked /goal starts sending prose.
// ─────────────────────────────────────────────────────────────────────────────

// SLASH_COMMAND_PASSTHROUGH
// A description that opens with a slash command IS the message, not content to wrap.
// The CLI only fires a command at character zero, so the kickoff template ("You're
// working on this task...", the title heading) would silently turn a parked `/goal`
// into prose and the goal loop would never arm. For these the wrapper is skipped
// whole: no template, no comments block (they would land INSIDE the /goal condition
// and can push it past the CLI's own 4000-character limit) and no image prefix.
// Parking a /goal on the board is the reason the pipeline can hold one at all.
const SLASH_COMMAND_KICKOFF = /^\/[a-z][a-z0-9-]*(\s|$)/i

export function isSlashCommandKickoff(description: string | undefined | null): boolean {
  return SLASH_COMMAND_KICKOFF.test((description || '').trimStart())
}

// RAW_PROMPT
// The second bypass. Set on the card itself rather than inferred from the text, and
// carried by every card migrated out of the routines table: a routine sent its prompt
// verbatim, with no template and no title heading, and existing routine cards must
// keep sending byte-identical text to what they sent before the merge.
export function isRawPrompt(task: Pick<PipelineTask, 'rawPrompt'>): boolean {
  return !!task.rawPrompt
}

/** True when this card sends its description verbatim, by either bypass. */
export function sendsVerbatim(task: Pick<PipelineTask, 'description' | 'rawPrompt'>): boolean {
  return isRawPrompt(task) || isSlashCommandKickoff(task.description)
}

// NOTHING TO SEND
// A raw_prompt card with no description builds an empty message, and the CLI answers an
// empty message cheerfully ("Ready. What do you need?") and bills for it. The template path
// cannot get here, because it always carries the title. One sentence for every refusal, so
// the scheduled fire, Run now and Start all say the same thing about the same card.
export const NO_PROMPT_MESSAGE = 'This card has no prompt, so the run was not started.'

export const EMPTY_RAW_PROMPT_MESSAGE =
  'This card sends its description word for word as the prompt, so the description cannot be empty.'

/** True when there is something for the CLI to read. Whitespace is not a prompt. */
export function hasPrompt(text: string | null | undefined): boolean {
  return !!text && text.trim().length > 0
}

/** True for a card that sends its description verbatim and has no description to send. */
export function rawPromptIsEmpty(card: { rawPrompt?: boolean | null; description?: string | null }): boolean {
  return !!card.rawPrompt && !hasPrompt(card.description)
}

function getSetting<T>(key: string, fallback: T): T {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : fallback
  } catch {
    return fallback
  }
}

export function buildKickoffPrompt(task: PipelineTask, comments: TaskComment[]): string {
  // Kept as two checks, not one `sendsVerbatim`, so each keeps its own reason on screen.
  if (isRawPrompt(task)) return task.description
  if (isSlashCommandKickoff(task.description)) return task.description.trimStart()

  const template = getSetting('taskKickoffTemplate', '') || DEFAULT_TASK_KICKOFF_TEMPLATE
  const commentsBlock = comments.length
    // Continuation lines are indented under their bullet, so a comment body cannot start a new
    // "- Human:" line of its own, with any line break a model reads as one: a lone
    // CR, VT, FF, NEL, U+2028 or U+2029 as well as LF.
    ? '## Comments\n' + comments.map(c => `- ${c.author === 'human' ? 'Human' : c.author}: ${c.body.replace(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/g, '\n  ')}`).join('\n')
    : ''
  return fillKickoffTemplate(template, {
    title: task.title,
    description: task.description || '(no description)',
    comments: commentsBlock,
  })
}

/**
 * One pass over the template, with a FUNCTION replacement.
 *
 * A string replacement reads `$$`, `$&`, `` $` `` and `$'` in the card's own text as
 * replacement patterns, so `echo $$` reached the agent as `echo $` and `$&` became the
 * placeholder itself. Chained replaceAll calls also re-scanned text already substituted, so a
 * description containing `{{comments}}` had the comments pasted into it. A single regex pass
 * with a callback does neither: the card's text is inserted exactly as written.
 */
export function fillKickoffTemplate(template: string, values: { title: string; description: string; comments: string }): string {
  return template
    .replace(/\{\{(title|description|comments)\}\}/g, (_match, key: 'title' | 'description' | 'comments') => values[key])
    .trim()
}

// SEND COMMENTS
// Whether the kickoff carries the card's comments. A verbatim card never does (see the two
// bypasses above). Otherwise the card's own choice wins, and with none set it is AUTO: on for
// a plain task, off for a card with a schedule. A routine is a fixed instruction; a year of
// notes about past runs pasted into every fire costs tokens and steers each run by the last.
export function sendsComments(task: Pick<PipelineTask, 'description' | 'rawPrompt' | 'sendComments' | 'scheduleKind'>): boolean {
  if (sendsVerbatim(task)) return false
  if (task.sendComments != null) return task.sendComments
  return !task.scheduleKind
}

/** The comments this card's kickoff carries: all of them, or none. */
export function kickoffComments(task: PipelineTask): TaskComment[] {
  return sendsComments(task) ? loadComments(task.id) : []
}

/** Comments for a card, oldest first, in the shape buildKickoffPrompt wants. */
export function loadComments(taskId: string): TaskComment[] {
  return (db.prepare(
    'SELECT id, task_id, author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at ASC'
  ).all(taskId) as Array<Record<string, unknown>>).map(r => ({
    id: r.id as string,
    taskId: r.task_id as string,
    author: r.author as string,
    body: r.body as string,
    createdAt: r.created_at as number,
  }))
}
