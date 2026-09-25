/**
 * Warning shown before switching the model on a chat that is still holding a warm prompt
 * cache. A chat with no session, or one whose cache has already gone cold, never sees this:
 * there the next turn re-sends the full history whichever model runs it, so the switch adds
 * nothing and compacting first would be the expensive turn rather than the cheap one.
 *
 * Switching models mid-chat throws away the prompt cache: the cached copy of the
 * conversation lives under the model that wrote it, so the first turn on the new
 * model re-sends the entire history as fresh, full-price input. On a long chat that
 * is a big bite out of the weekly quota for zero new work.
 *
 * Some switches cost extra: thinking blocks are bound to the model that produced
 * them and only travel to models that can read them. Fable 5.1 can read what
 * earlier models thought, but only Fable 5.1 and Mythos 5.1 can read Fable 5.1's
 * or Opus 5.5's, so leaving either of those for anything else silently drops the
 * reasoning on the way out. `switchLosesThinking` in shared/constants owns the
 * rule; this component only renders it. It used to be a hardcoded "am I leaving
 * Fable 5.1" check here, which stopped being the whole truth when Opus 5.5
 * shipped with the same binding.
 *
 * "Compact first" sends /compact on the CURRENT model (still cached, so it is cheap)
 * to shrink the conversation, then applies the switch itself once that turn finishes.
 * The order matters: compacting on the NEW model would be the expensive cache-miss
 * turn we are trying to avoid. The model stays locked in between.
 */

/** "claude-fable-5-1" → "Fable 5.1" — the picker label without its parenthetical. */
export function modelDisplayName(modelId: string, label?: string): string {
  if (label) return label.split(' (')[0]
  return modelId.replace(/^claude-/, '').replace(/-/g, ' ')
}

interface Props {
  fromModel: string
  toModel: string
  fromLabel?: string
  toLabel?: string
  /** true when the chat is leaving Fable 5.1, which also loses its reasoning */
  losesThinking: boolean
  onCompactFirst: () => void
  onSwitchAnyway: () => void
  onCancel: () => void
}

export function ModelSwitchWarning({
  fromModel, toModel, fromLabel, toLabel, losesThinking,
  onCompactFirst, onSwitchAnyway, onCancel,
}: Props) {
  const from = modelDisplayName(fromModel, fromLabel)
  const to = modelDisplayName(toModel, toLabel)

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-panel" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <span className="modal-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>
            {from} → {to}: this re-sends the whole chat
          </span>
        </div>
        <div className="modal-body" style={{ fontSize: 13, lineHeight: 1.55 }}>
          <p style={{ margin: '0 0 10px' }}>
            Right now this conversation is cached under {from}, so every turn re-reads it at a
            fraction of the normal price. {to} has no such cache. Its first turn pays full price
            for the entire history again, and on a long chat that can be a serious chunk of the
            weekly quota in one go.
          </p>
          {losesThinking && (
            <p style={{ margin: '0 0 10px' }}>
              Moving off Fable 5.1 also drops its reasoning. Fable 5.1 can read what other models
              thought, but nothing can read what Fable 5.1 thought, so everything it has worked
              out in this chat is thrown away as it leaves.
            </p>
          )}
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            Compacting first shrinks the conversation while it is still cheap to read, so there is
            far less to re-send. It compacts on {from}, then switches to {to} on its own the moment
            that finishes. The model picker stays locked until then.
          </p>
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-ghost" onClick={onSwitchAnyway}>Switch anyway</button>
          <button className="btn btn-primary" onClick={onCompactFirst} autoFocus>Compact first</button>
        </div>
      </div>
    </div>
  )
}
