import { PERMISSION_BUNDLES, ALL_BUNDLE_IDS, SAFE_BUNDLE_IDS, DESTRUCTIVE_FENCE, type PermissionBundleId } from '@shared/permission-bundles'
import { useUI } from '../context/UIContext'

/**
 * The fence's patterns grouped into what they protect, for people, with the raw list one more
 * click away for whoever wants to check it. A wall of a thousand glob patterns reads as a list of
 * a thousand dangers.
 */
function fenceGroups(): Array<{ label: string; count: number }> {
  const groups = [
    { label: 'Rewriting or deleting git history that is already pushed', test: (r: string) => /\bgit\b/.test(r) },
    { label: 'Deleting your home folder', test: (r: string) => /~|HOME|home|USERPROFILE|userprofile|Users|users/.test(r) },
    { label: 'Deleting the folders Windows needs', test: (r: string) => /indows|INDOWS|rogram|ROGRAM|WINDIR|windir|SYSTEMROOT|systemroot|SystemRoot|programfiles/.test(r) },
    { label: 'Deleting the whole drive', test: (r: string) => / \/\)| \/ \*\)/.test(r) },
  ]
  return groups.map(g => ({ label: g.label, count: DESTRUCTIVE_FENCE.filter(g.test).length }))
}

/**
 * The app-wide fence, shown read-only where it cannot be changed.
 *
 * Without this the per-chat modal gave no hint the fence existed, so a chat blocked by it
 * looked like a chat whose permissions had not saved. Turning every grant on and watching
 * nothing happen is a bug report; being told a deny is winning is an instruction.
 */
function FenceNote() {
  const { settings } = useUI()
  const on = settings.blockDestructive !== false
  return (
    <div className="perm-fence-note">
      <p className="set-guide">
        <strong>Block destructive commands is {on ? 'ON' : 'OFF'}</strong>, app-wide, set in
        Settings.{' '}
        {on
          ? <>It refuses a short list of catastrophes no matter what this chat is granted:
              rewriting or deleting history that is already pushed, deleting a trunk branch such
              as main on the remote, deleting your whole home folder, and deleting the folders
              Windows needs. It is a list of spellings, not an understanding of the command, so an
              unusual one can still get past it: deleting everything INSIDE your home folder with
              a wildcard is the known gap. Deleting a merged feature branch, or a folder inside
              your home folder, is allowed. A deny cannot be lifted for one chat, so this is the
              one thing on this screen you cannot change from here.</>
          : <>Nothing is fenced, for any chat, including force-pushing over work that is already
              on GitHub.</>}
      </p>
      {on && (
        <details className="set-advanced">
          <summary>What it blocks</summary>
          <ul className="set-guide" style={{ margin: '6px 0', paddingLeft: 18 }}>
            {fenceGroups().map(g => (
              <li key={g.label}>{g.label} <span style={{ color: 'var(--text-muted)' }}>({g.count} spellings)</span></li>
            ))}
          </ul>
          <details className="set-advanced">
            <summary>Technical: every pattern</summary>
            <div className="set-tags" style={{ maxHeight: 220, overflowY: 'auto' }}>
              {DESTRUCTIVE_FENCE.map(rule => (
                <span key={rule} className="settings-flag">{rule}</span>
              ))}
            </div>
          </details>
        </details>
      )}
    </div>
  )
}

/**
 * The plain-English grants, as toggles.
 *
 * This is the surface a non-programmer actually uses. The glob patterns underneath are real
 * and still editable under Advanced, but nobody should have to know what `Bash(git push:*)`
 * means in order to let their agent save work. Labels and descriptions are the product here;
 * the patterns are the implementation.
 *
 * Shared by the app-wide Settings card and the per-chat modal so the two cannot drift on what
 * a bundle contains or what it is called.
 */
export function PermissionBundlePicker({
  value,
  onChange,
  blockDestructive,
  onBlockDestructive,
  scopeNote,
}: {
  value: PermissionBundleId[]
  onChange: (next: PermissionBundleId[]) => void
  /** Omitted per-chat: the fence is app-wide, because a deny wins whichever side it came
   *  from, so a per-chat "unfence" could not work even if it were offered. */
  blockDestructive?: boolean
  onBlockDestructive?: (next: boolean) => void
  scopeNote?: string
}) {
  const fenceAvailable = typeof blockDestructive === 'boolean' && !!onBlockDestructive
  const allOn = ALL_BUNDLE_IDS.every(id => value.includes(id))

  const toggle = (id: PermissionBundleId) => {
    onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id])
  }

  return (
    <>
      <div className="set-withbtn">
        {fenceAvailable ? (
          <>
            {/* Two buttons, not one with a caveat. The whole complaint that produced this
                screen was that a button called "recommended" quietly meant "some of it", so
                neither of these is allowed to be vague about what it does. */}
            <button
              className="btn btn-sm"
              onClick={() => { onChange([...SAFE_BUNDLE_IDS]); onBlockDestructive!(true) }}
            >Allow everything except the catastrophic</button>
            <button
              className="btn btn-sm"
              onClick={() => { onChange([...ALL_BUNDLE_IDS]); onBlockDestructive!(false) }}
            >Allow everything</button>
          </>
        ) : (
          <button className="btn btn-sm" onClick={() => onChange([...ALL_BUNDLE_IDS])}>
            Allow everything for this chat
          </button>
        )}
        {value.length > 0 && (
          <button className="btn btn-sm" onClick={() => onChange([])}>Turn all off</button>
        )}
      </div>
      {scopeNote && <p className="set-guide">{scopeNote}</p>}

      <div className="perm-bundles">
        {PERMISSION_BUNDLES.map(bundle => {
          const on = value.includes(bundle.id)
          return (
            <div key={bundle.id} className={`perm-bundle ${on ? 'on' : ''}`}>
              <div className="perm-bundle-main">
                <span className="perm-bundle-label">
                  {bundle.label}
                  {bundle.readOnly && <span className="perm-bundle-tag">asks before any change</span>}
                </span>
                <span className="perm-bundle-desc">{bundle.description}</span>
                {bundle.autoModeNote && <span className="perm-bundle-desc perm-bundle-auto-note">{bundle.autoModeNote}</span>}
              </div>
              <div
                className={`toggle-switch ${on ? 'active' : ''}`}
                role="switch"
                aria-checked={on}
                aria-label={bundle.label}
                onClick={() => toggle(bundle.id)}
              />
            </div>
          )
        })}
      </div>

      {!fenceAvailable && <FenceNote />}

      {fenceAvailable && (
        <>
          <div className="settings-toggle" style={{ marginTop: 8 }}>
            <span className="settings-toggle-label">Block destructive commands</span>
            <div
              className={`toggle-switch ${blockDestructive ? 'active' : ''}`}
              role="switch"
              aria-checked={blockDestructive}
              onClick={() => onBlockDestructive!(!blockDestructive)}
            />
          </div>
          <p className="set-guide">
            {blockDestructive
              ? <>On. Refuses rewriting or deleting git history that is already pushed, deleting
                  your whole home folder, and deleting the folders Windows needs, in the usual
                  spellings. It matches spellings, so an unusual one can slip past. It overrides
                  every switch above.</>
              : <>Off. Nothing is fenced, including force-pushing over work that is already on
                  GitHub. This is what makes the button above mean everything.</>}
          </p>
        </>
      )}

      {allOn && !blockDestructive && fenceAvailable && (
        <p className="set-guide set-danger">
          Every grant is on and nothing is fenced, deploying included. An agent can do anything you
          can do on this machine, and other people will see the results.
        </p>
      )}
      {value.includes('deploy') && (
        <p className="set-guide set-danger">
          Deploying is on. An agent can put changes in front of real users without asking. A
          PreToolUse hook still overrides this if the project has one, but only where it has one.
        </p>
      )}
      {value.length > 0 && !value.includes('deploy') && (
        <p className="set-guide">
          Deploying is off, so a deploy PAUSES the chat and asks you, and runs untouched if you
          say yes. It is not refused: a refusal just makes the agent find another way to do the
          job before you have answered.
        </p>
      )}
    </>
  )
}
