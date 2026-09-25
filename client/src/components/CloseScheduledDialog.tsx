// Close chat, for a chat that scheduled cards are aimed at.
//
// A scheduled card fires AT a chat. Closing that chat never deletes the card (the server
// does not cascade, on purpose): from the next fire on, the scheduler opens a fresh chat in
// the card's project for each run. That is the right default for a standing reminder and
// the wrong one for a card that only made sense inside this chat, so the close asks which
// it is. Asked in the existing close chain, after the uncommitted-work guard and the
// worktree check and before the task status pick, so a close is interrogated in exactly
// one place.
//
// Only cards that can still fire reach this dialog (see scheduledCardsForChats below): a
// fired one-off is finished, so asking about it is a question with no consequence.
//
// This dialog only records the choice. The deletes themselves happen immediately before
// the close, in the hook, so a Cancel later in the chain leaves the cards untouched.
//
// Portalled to document.body: the zoom transform on .app captures position: fixed, so an
// in-tree overlay lands off-screen and inflates its scroller (see the other close dialogs).

import { createPortal } from 'react-dom'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { describeNextRun, describeFiredOnce } from '@shared/routine-schedule'
import { describeSchedule } from '@shared/schedule-next'
import { specOf } from '../utils/taskSchedule'
import type { PipelineTask } from '@shared/types'

/** A one-off that fired and switched itself off. That is completion, not a user choice. */
function isFiredOnce(task: PipelineTask): boolean {
  return task.scheduleKind === 'once' && !task.scheduleEnabled && task.lastRunAt != null
}

/**
 * THE filter for the whole close flow: the scheduled cards that can still fire on one of
 * these chats. It lives here, next to the dialog that asks about them, and both callers
 * import it (the close-chat flow in useInstanceContextMenu and the Close All / Renew All
 * note in FolderGroup), because there is exactly one way to get this right and two copies
 * of it would drift.
 *
 * targetInstanceId, NEVER instanceId. targetInstanceId is CONFIG: the chat every scheduled
 * fire is aimed at. instanceId is RUNTIME: the chat that is working or last worked the
 * card, stamped by whichever run happened most recently. They point in opposite
 * directions, so filtering on instanceId would warn about cards that merely RAN here once
 * (and can never fire here again) while silently missing the ones still aimed at this chat,
 * which are the entire reason the question is being asked.
 *
 * A card aimed at its project instead (targetInstanceId null) is unaffected by closing a
 * chat: it opens its own on every fire regardless, so it is not this dialog's business.
 *
 * Only cards that CAN still fire are worth a question. A fired one-off has already switched
 * itself off, so keeping it costs nothing and deleting it only drops a finished card off
 * the board: asking is a dialog with no consequence in the way of a close. Paused cards
 * stay in the list, because resuming one is a single click.
 */
export function scheduledCardsForChats(tasks: PipelineTask[], instanceIds: readonly string[]): PipelineTask[] {
  return tasks.filter(t =>
    t.scheduleKind != null &&
    t.targetInstanceId != null &&
    instanceIds.includes(t.targetInstanceId) &&
    !isFiredOnce(t)
  )
}

interface Props {
  instanceName: string
  /** Scheduled cards aimed at this chat that can still fire. Never empty when rendered. */
  tasks: PipelineTask[]
  /** Continue the close and delete every listed card right before it. */
  onDelete: () => void
  /** Continue the close and change nothing about the cards. */
  onKeep: () => void
  /** Leave the chat open. */
  onCancel: () => void
}

function scheduleLine(task: PipelineTask): string {
  // Reads from the SAME describe function the board pill and the modal preview use. It
  // used to call describeRoutineSchedule, which only knew the pre-migration048 kinds and
  // fell through to printing the raw value: this dialog said "Routine · 300" where it
  // meant "every 5 hours, 11:00 to 19:00, on Tue, Wed, Thu, Fri, Sun", in the one place
  // somebody is deciding whether to delete the card.
  const label = task.scheduleKind === 'once' ? 'Scheduled' : 'Routine'
  const bits = [`${label} · ${describeSchedule(specOf(task))}`]
  // A one-off switches ITSELF off once it has fired. Calling that "paused" read as a
  // choice someone made, and hid the only fact that decides whether this card is worth
  // keeping: it has already run, so keeping it does nothing. Unreachable from the close
  // flow (scheduledCardsForChats drops fired one-offs) and kept as a backstop, so a card
  // that ever slips through still describes itself honestly.
  //
  // It says "fired" even when that run errored. A merged card carries lastRunAt but no run
  // STATUS, and telling a clean fire from a failed one needs the status, so the failed
  // wording has nothing left to read from. "Fired" is true either way, and the card's own
  // run history is where the error is visible.
  const fired = isFiredOnce(task)
  const next = describeNextRun(task.nextRunAt)
  if (fired) {
    const d = describeFiredOnce(task.lastRunAt)
    bits.push(`${d.label.toLowerCase()} ${d.text}`)
  } else if (next) bits.push(next)
  else if (!task.scheduleEnabled) bits.push('paused')
  return bits.join(' · ')
}

export function CloseScheduledDialog({ instanceName, tasks, onDelete, onKeep, onCancel }: Props) {
  useEscapeKey(onCancel)
  const many = tasks.length !== 1
  const noun = many ? 'scheduled cards' : 'scheduled card'

  return createPortal(
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-panel close-session-dialog" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Delete {noun}?</span>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, marginBottom: 10 }}>
            {many ? `${tasks.length} scheduled cards can still fire` : 'A scheduled card can still fire'} on &ldquo;{instanceName}&rdquo;.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {tasks.map(t => (
              <div
                key={t.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '6px 8px',
                  fontSize: 12,
                }}
              >
                <div>{t.title}</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{scheduleLine(t)}</div>
              </div>
            ))}
          </div>

          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
            A kept card will run in a new chat in its project each time it fires.
          </p>

          {/* Each choice carries a label and the consequence of picking it. .btn on its own
              is an inline-flex ROW, which put the consequence beside the label instead of
              under it, so both buttons take .close-choice-btn to stack them. The delete
              button is outlined rather than filled: a red surface on a chat close is an
              alarm nobody needs, and the safe choice below it is the primary one. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn close-choice-btn close-choice-btn--danger" onClick={onDelete}>
              Close and delete {noun}
              <span className="close-choice-desc">
                Removes {many ? 'them' : 'it'} from the board for good when the chat closes, run history included.
              </span>
            </button>
            <button className="btn btn-primary close-choice-btn" onClick={onKeep} autoFocus>
              Close and keep {noun}
              <span className="close-choice-desc">
                Each fire opens a new chat in its project and spends tokens.
              </span>
            </button>
          </div>
        </div>
        <div className="modal-footer">
          <span
            className="input-hint"
            style={{ marginRight: 'auto', alignSelf: 'center', fontSize: 11, color: 'var(--text-tertiary)' }}
          >
            Escape leaves the chat open
          </span>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
