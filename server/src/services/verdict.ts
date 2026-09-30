// ─────────────────────────────────────────────────────────────────────────────
// Verdict: how a self-closing card proves it succeeded.
//
// A card with self_close on asks its run to end the final message with ONE line:
//
//   RESULT: OK
//   RESULT: NEEDS_REVIEW - <reason>
//
// ABSENCE OF PROOF IS FAILURE. Done is reached only by a positively parsed `RESULT: OK` on
// the last non-empty line of the final assistant message of THIS run, with a clean exit.
// Everything else (no line, a typo, the line anywhere but last, a crash, a non-zero exit, a
// Stop, no message at all) is NEEDS_REVIEW, and the chat is kept, because it is the only
// evidence of what went wrong. The failure this exists to prevent: a run that crashed is
// marked Done and its chat deleted while the board shows green.
//
// This module is pure (no db), so it can be unit tested on its own. run-verdict.ts is the
// one place that decides which message counts as "this run's final message".
// ─────────────────────────────────────────────────────────────────────────────

export type Verdict =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * The instruction a self-closing run receives, through --append-system-prompt and, short,
 * as SELF_CLOSE_FOOTER below (see task-runner.ts and task-scheduler.ts). Injected by the server rather than trusted to the
 * card text, so it reaches a verbatim kickoff (raw prompt, a leading /goal) as well, without
 * a single character being put in front of the command.
 */
export const SELF_CLOSE_INSTRUCTION = [
  'SELF-CLOSING TASK: this run closes itself only on proof of success.',
  'End your FINAL message of this turn with exactly one verdict line, as the very last line, plain text, no code fence, no formatting:',
  'RESULT: OK',
  '(alone on the line, nothing after it) when every part of the task is done and you verified it, or',
  'RESULT: NEEDS_REVIEW - <one-line reason>',
  'when anything failed, is unverified, was skipped, or needs a human decision.',
  'This holds even when the task asks you to finish with a summary or anything else: write that first, then the verdict line after it, as the last line.',
  'This holds for EVERY run on this task, including a resumed conversation: earlier messages do not carry a verdict for this one.',
  'If in doubt, use NEEDS_REVIEW. A missing or malformed verdict line counts as NEEDS_REVIEW.',
].join('\n')

/**
 * The same instruction, short, at the END of every self-closing kickoff message. Measured on the
 * scratch server (claude 2.1.284): with --resume the CLI does not apply --append-system-prompt
 * (3 of 3 resumed runs ignored it, the fresh control followed it), and even on a fresh chat a
 * terse prompt let the model skip the system-prompt copy. The message is the channel it reads.
 * Appended AFTER the kickoff on a new paragraph, never in front: a leading /command must stay
 * at character zero.
 */
export const SELF_CLOSE_FOOTER =
  'SELF-CLOSING TASK: after everything else, end your final message with one verdict line as the very last line, plain text: ' +
  'RESULT: OK (alone on the line) if every part is done and verified, otherwise RESULT: NEEDS_REVIEW - <one-line reason>. No line counts as NEEDS_REVIEW.'

export function withSelfCloseFooter(text: string): string {
  return `${text.replace(/\s+$/, '')}\n\n${SELF_CLOSE_FOOTER}`
}

// OK is the WHOLE line: `RESULT: OK - but 3 tests failed` is not proof of success, so a qualified
// OK reads as not understood. NEEDS_REVIEW carries its reason.
const VERDICT_LINE = /^RESULT:\s*(?:(OK)|(NEEDS_REVIEW)(?:\s*[-:]\s*(.+))?)$/

export const NO_VERDICT_REASON = 'no verdict line'

/** Read the verdict off a final message's text. Pure. */
export function parseVerdict(text: string | null | undefined): Verdict {
  if (!text) return { ok: false, reason: `${NO_VERDICT_REASON} (the run left no final text)` }
  const lines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l.length > 0)
  const last = lines[lines.length - 1]
  if (!last) return { ok: false, reason: `${NO_VERDICT_REASON} (the run left no final text)` }
  const m = VERDICT_LINE.exec(last)
  if (!m) {
    // Say what was there when it LOOKS like an attempt, so a typo reads as a typo.
    return /^result\b/i.test(last.replace(/^[`*_>\s]+/, ''))
      ? { ok: false, reason: `verdict line not understood: "${last.slice(0, 200)}"` }
      : { ok: false, reason: NO_VERDICT_REASON }
  }
  if (m[1] === 'OK') return { ok: true }
  const reason = m[3]?.trim()
  return { ok: false, reason: reason || 'no reason given' }
}
