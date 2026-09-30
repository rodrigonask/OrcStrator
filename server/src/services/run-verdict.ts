import { db } from '../db.js'
import { parseVerdict, type Verdict } from './verdict.js'

// The db half of the verdict (see verdict.ts for the grammar and why absence is failure).

/**
 * The final assistant message of the run that started at `since`, as text, or null.
 *
 * Scoped to rows written at or after the run's start: on a resumed or pinned chat the latest
 * assistant row can be YESTERDAY's `RESULT: OK`, and a run that crashed before saying anything
 * must not inherit it. The final CONTENT BLOCK of that row has to be text too: a row that ends
 * in a tool call is a turn that was cut off mid-step, whatever it said before the call.
 */
export function finalRunText(instanceId: string, since: number): string | null {
  const row = db.prepare(
    `SELECT content FROM messages
      WHERE instance_id = ? AND role = 'assistant' AND created_at >= ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(instanceId, since) as { content: string } | undefined
  if (!row) return null
  try {
    const blocks = JSON.parse(row.content) as Array<{ type: string; text?: string }>
    const lastBlock = blocks[blocks.length - 1]
    if (!lastBlock || lastBlock.type !== 'text' || typeof lastBlock.text !== 'string') return null
    return lastBlock.text
  } catch {
    return null
  }
}

/**
 * The verdict for a run, from everything known when its turn completed. The process facts go
 * first: a run that did not end cleanly is never OK, whatever its last message says.
 */
export function readRunVerdict(opts: {
  instanceId: string
  /** When the run started. Unknown (null) is itself a failure: nothing can be scoped to it. */
  since: number | null
  exitCode: number | null
  stoppedByUser: boolean
}): Verdict {
  if (opts.since == null) return { ok: false, reason: 'the start of this run is unknown (the server restarted during it), so its verdict cannot be read' }
  if (opts.stoppedByUser) return { ok: false, reason: 'the run was stopped before it finished' }
  if (opts.exitCode === null) return { ok: false, reason: 'the claude process was killed before the turn finished' }
  if (opts.exitCode !== 0) return { ok: false, reason: `the claude process exited with code ${opts.exitCode}` }
  return parseVerdict(finalRunText(opts.instanceId, opts.since))
}
