// The first thing the close flow asks, before the uncommitted-work guard and before the
// task status pick.
//
// A worktree outlives the session that made it, but the reason for it does not. Left
// alone it becomes a branch nobody can explain and a merge conflict months later. This
// is the one moment the session is still alive and can be told to go and finish it, so
// Investigate hands the work back to the session instead of closing it.

import { createPortal } from 'react-dom'
import { useEscapeKey } from '../../hooks/useEscapeKey'

export interface WorktreeOrphanInfo {
  path: string
  name: string
  branch: string
  registered: boolean
  dirty: number
  unpushed: number
}

interface Props {
  instanceName: string
  orphans: WorktreeOrphanInfo[]
  onInvestigate: () => void
  onIgnore: () => void
  onCancel: () => void
}

function riskLine(o: WorktreeOrphanInfo): string {
  const bits: string[] = []
  if (o.dirty > 0) bits.push(`${o.dirty} uncommitted file${o.dirty !== 1 ? 's' : ''}`)
  if (o.unpushed > 0) bits.push(`${o.unpushed} unpushed commit${o.unpushed !== 1 ? 's' : ''}`)
  if (o.unpushed === -1) bits.push('never pushed')
  if (!o.registered) bits.push('git no longer tracks it')
  return bits.length ? bits.join(', ') : 'clean, but still on disk'
}

export function WorktreeOrphanDialog({ instanceName, orphans, onInvestigate, onIgnore, onCancel }: Props) {
  useEscapeKey(onCancel)
  const many = orphans.length !== 1

  return createPortal(
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-panel close-session-dialog" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            {orphans.length} unfinished worktree{many ? 's' : ''}
          </span>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, marginBottom: 10 }}>
            &ldquo;{instanceName}&rdquo; created {many ? 'these worktrees' : 'this worktree'} and never
            removed {many ? 'them' : 'it'}.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {orphans.map(o => (
              <div
                key={o.path}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '6px 8px',
                  fontSize: 12,
                }}
              >
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{o.name}</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                  {o.branch || 'detached'} &middot; {riskLine(o)}
                </div>
              </div>
            ))}
          </div>

          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
            Closing now forgets {many ? 'them' : 'it'} forever. The files stay on disk and the
            branch stays in the repo, but the session that knows why is gone, and that is how
            an unmergeable branch and a merge conflict get made months from now.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn btn-primary" onClick={onInvestigate} autoFocus>
              Investigate
              <span style={{ display: 'block', fontSize: 11, opacity: 0.8, fontWeight: 400 }}>
                Keeps the session open and asks it to audit and finish {many ? 'each one' : 'it'}.
              </span>
            </button>
            <button className="btn" onClick={onIgnore}>
              Ignore and close
              <span style={{ display: 'block', fontSize: 11, opacity: 0.8, fontWeight: 400 }}>
                Leaves {many ? 'them' : 'it'} on disk. Nothing is deleted.
              </span>
            </button>
          </div>
        </div>
        <div className="modal-footer">
          <span
            className="input-hint"
            style={{ marginRight: 'auto', alignSelf: 'center', fontSize: 11, color: 'var(--text-tertiary)' }}
          >
            Escape leaves the session open
          </span>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
