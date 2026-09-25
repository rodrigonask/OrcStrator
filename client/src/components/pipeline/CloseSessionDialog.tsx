// Close Session, for a session that came from a pipeline task.
//
// Users rarely go back to the board to mark anything finished, so the board decays
// into a list of things that all look unstarted. Closing the chat is the one moment the user
// reliably signals that a piece of work is over, so that is where the status gets asked
// for. The pick is MANDATORY: Escape and the backdrop leave the session open rather than
// closing it statusless, because a close with no status is exactly the hole this fills.

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import type { PipelineTask } from '@shared/types'

export type CloseStatus = 'done' | 'inbox'

interface CloseSessionDialogProps {
  instanceName: string
  task: PipelineTask
  /** Whether a Haiku summary will follow, so the copy does not promise one that never comes. */
  willSummarize: boolean
  onCancel: () => void
  onConfirm: (status: CloseStatus) => void
}

export function CloseSessionDialog({ instanceName, task, willSummarize, onCancel, onConfirm }: CloseSessionDialogProps) {
  const [busy, setBusy] = useState(false)
  useEscapeKey(onCancel)

  const pick = (status: CloseStatus) => {
    if (busy) return
    setBusy(true)
    onConfirm(status)
  }

  return createPortal(
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-panel close-session-dialog" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Close &ldquo;{instanceName}&rdquo;</span>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, marginBottom: 4 }}>
            This session is working on <strong>{task.title}</strong>.
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
            {willSummarize
              ? 'Pick where the task goes. The chat closes straight away and a summary of it lands on the task a few seconds later.'
              : 'Pick where the task goes. Session Summary is off, so no summary will be written.'}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => pick('done')}
              autoFocus
            >
              Done
              <span style={{ display: 'block', fontSize: 11, opacity: 0.8, fontWeight: 400 }}>
                The work is finished. Moves the task to Done.
              </span>
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => pick('inbox')}
            >
              Send back to Inbox
              <span style={{ display: 'block', fontSize: 11, opacity: 0.8, fontWeight: 400 }}>
                Not finished. Returns the task to Backlog so it can be started fresh.
              </span>
            </button>
          </div>
        </div>
        <div className="modal-footer">
          <span className="input-hint" style={{ marginRight: 'auto', alignSelf: 'center', fontSize: 11, color: 'var(--text-tertiary)' }}>
            Escape leaves the session open
          </span>
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
