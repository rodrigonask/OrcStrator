import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InstanceConfig, PermissionRuleSet } from '@shared/types'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useInstances } from '../context/InstancesContext'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { projectRuleChain } from '../utils/permissionMatch'
import { api } from '../api'
import { RuleList, RECOMMENDED_GIT_RULES, RECOMMENDED_GIT_SUMMARY, mergeRules } from './RuleList'
import { PermissionBundlePicker } from './PermissionBundlePicker'
import type { PermissionBundleId } from '@shared/permission-bundles'
import { dedupeRules } from '@shared/permission-rules'

/**
 * Per-chat permission rules, opened from the session's right-click menu.
 *
 * ADDITIVE, not an override in the outputStyle sense. "Give this chat permissions" is a
 * grant for one session, so these rules are unioned with the app-wide ones rather than
 * replacing them, and the header shows the inherited counts so the total is never a guess.
 * Denies still beat allows on both sides, which means a chat can tighten itself but can
 * never loosen something the app-wide list denies. That asymmetry is the point: the blast
 * radius of a per-chat grant is one chat, and it cannot be used to undo a global fence.
 *
 * Portalled to document.body, not rendered in place: `.app` carries a zoom transform, and
 * a position:fixed overlay inside a transformed ancestor is positioned against that
 * ancestor instead of the viewport, which lands it off-screen and inflates the scroller.
 */
export function PermissionRulesModal({ instance, onClose }: { instance: InstanceConfig; onClose: () => void }) {
  const { settings } = useUI()
  const { folders } = useInstances()
  const { dispatch } = useAppDispatch()
  const [removing, setRemoving] = useState<string | null>(null)
  useEscapeKey(onClose)

  const current: PermissionRuleSet = instance.permissionRules ?? {}
  // De-duplicated on the way in as well as out: rows written by older versions can hold the same
  // rule several times (`Edit` four times, say), and the modal would show every copy.
  const [bundles, setBundles] = useState<PermissionBundleId[]>(current.bundles ?? [])
  const [allow, setAllow] = useState<string[]>(dedupeRules(current.allow))
  const [deny, setDeny] = useState<string[]>(dedupeRules(current.deny))
  const [ask, setAsk] = useState<string[]>(dedupeRules(current.ask))
  const [autoAllow, setAutoAllow] = useState<string[]>(dedupeRules(current.autoAllow))
  const [autoSoftDeny, setAutoSoftDeny] = useState<string[]>(dedupeRules(current.autoSoftDeny))
  const [autoHardDeny, setAutoHardDeny] = useState<string[]>(dedupeRules(current.autoHardDeny))

  const inheritedAllow = settings.permissionAllowRules?.length ?? 0
  const inheritedDeny = settings.permissionDenyRules?.length ?? 0

  // Where the chat's rules actually come from, now that "Allow always" can save to three places.
  // Read-only here on purpose: this modal owns ONE chat, and a control that quietly
  // edited a folder or the app-wide list from inside a window titled with a chat name would be the
  // same category of surprise as the per-chat deploy toggle that silently changed nothing.
  // The one exception is removing a project rule, which is offered because the alternative is
  // hunting for which folder in the chain holds it with no screen that says.
  const chain = useMemo(() => projectRuleChain(folders, instance.folderId), [folders, instance.folderId])
  const appWideAllow = dedupeRules(settings.permissionAllowRules)

  const removeProjectRule = async (folderId: string, rule: string) => {
    setRemoving(rule)
    try {
      const res = await api.patchFolderPermissionRules(folderId, { remove: [rule] })
      dispatch({
        type: 'UPDATE_FOLDER',
        payload: { id: folderId, updates: { permissionRules: res.permissionRules ?? undefined } },
      })
    } catch (err) {
      console.error('Removing the project rule failed:', err)
    } finally {
      setRemoving(null)
    }
  }

  const save = () => {
    // Always send every list. The server normalises an all-empty set back to NULL, so
    // clearing every bucket is how a chat goes back to inheriting, with no separate action
    // and no third state to keep in sync.
    //
    // `askOnce` is not edited here but must be carried through: the PUT replaces the whole
    // column, so leaving it out would delete a one-time question the operator asked for from a
    // refusal card, and the retry would go straight back to the classifier.
    const next: PermissionRuleSet = {
      bundles,
      allow: dedupeRules(allow),
      deny: dedupeRules(deny),
      ask: dedupeRules(ask),
      askOnce: dedupeRules(current.askOnce),
      autoAllow: dedupeRules(autoAllow),
      autoSoftDeny: dedupeRules(autoSoftDeny),
      autoHardDeny: dedupeRules(autoHardDeny),
    }
    const anything = bundles.length || allow.length || deny.length || ask.length || next.askOnce?.length || autoAllow.length || autoSoftDeny.length || autoHardDeny.length
    dispatch({
      type: 'UPDATE_INSTANCE',
      payload: { id: instance.id, updates: { permissionRules: anything ? next : undefined } },
    })
    api.updateInstance(instance.id, { permissionRules: next })
      .catch(err => console.error('Failed to save permission rules:', err))
    onClose()
  }

  const clearAll = () => {
    setBundles([]); setAllow([]); setDeny([]); setAsk([]); setAutoAllow([]); setAutoSoftDeny([]); setAutoHardDeny([])
  }

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel permission-rules-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Permissions for &ldquo;{instance.name}&rdquo;</span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <div className="modal-body">
          <p className="set-hint">
            Rules for this chat only, <strong>added</strong> to the {inheritedAllow + inheritedDeny} app-wide
            rule{inheritedAllow + inheritedDeny === 1 ? '' : 's'} rather than replacing them. A deny still wins
            wherever it comes from, so this can grant this chat something the rest of the app does not have,
            but it cannot undo an app-wide deny. Applies from this chat&rsquo;s next turn.
          </p>

          <PermissionBundlePicker
            value={bundles}
            onChange={setBundles}
            scopeNote={'Granted to this chat on top of whatever is on app-wide. The destructive fence is set in Settings and still applies here, because a deny wins whichever side it came from.'}
          />

          <div className="set-withbtn" style={{ marginTop: 8 }}>
            <button className="btn btn-sm" onClick={clearAll}>Clear everything for this chat</button>
          </div>
          <p className="set-guide">
            Puts this chat back to inheriting the app-wide permissions and nothing else.
          </p>

          {/* What this chat carries from the other two scopes. Quiet by construction: a details
              block, closed until asked for, with no controls except the one remove. The counts are
              on the summary so the answer to "does this chat have anything else?" needs no click. */}
          <details className="set-advanced perm-inherited">
            <summary>
              Also applies here: {chain.reduce((n, c) => n + (c.rules.allow?.length ?? 0), 0)} from the
              project, {appWideAllow.length} from all chats
            </summary>
            <p className="set-guide">
              Added to whatever is set above, from this chat&rsquo;s next turn. A deny still wins over
              all of it, wherever it came from.
            </p>

            {chain.length === 0 ? (
              <p className="set-guide">Nothing is set on this project yet.</p>
            ) : (
              chain.map(({ folder, rules }) => (
                <div key={folder.id} className="perm-inherited-group">
                  <div className="set-sub">
                    {folder.displayName || folder.name}
                    {folder.id !== instance.folderId && <span className="perm-inherited-tag">inherited</span>}
                  </div>
                  {(rules.allow ?? []).length === 0 && <p className="set-guide">No allow rules.</p>}
                  {(rules.allow ?? []).map(rule => (
                    <div key={rule} className="perm-inherited-row">
                      <code>{rule}</code>
                      <button
                        className="btn btn-sm"
                        disabled={removing === rule}
                        title={`Removes it from ${folder.displayName || folder.name}, for every chat in that project`}
                        onClick={() => void removeProjectRule(folder.id, rule)}
                      >
                        {removing === rule ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  ))}
                </div>
              ))
            )}

            <div className="set-sub">All chats</div>
            {appWideAllow.length === 0 ? (
              <p className="set-guide">No app-wide allow rules.</p>
            ) : (
              <>
                {appWideAllow.map(rule => (
                  <div key={rule} className="perm-inherited-row"><code>{rule}</code></div>
                ))}
                <p className="set-guide">Change these in Settings, Permission Rules.</p>
              </>
            )}
          </details>

          <details className="set-advanced">
            <summary>Advanced: individual rules</summary>

            {/* The label says both halves. Called "recommended git rules" it would read as a
                grant, and it adds denies: a chat stuck on a branch deletion would get MORE stuck
                every time this was clicked to unstick it. */}
            <div className="set-withbtn">
              <button
                className="btn btn-sm"
                onClick={() => {
                  setAllow(c => mergeRules(c, RECOMMENDED_GIT_RULES.allow))
                  setDeny(c => mergeRules(c, RECOMMENDED_GIT_RULES.deny))
                }}
              >Add git grants and guards</button>
            </div>
            <p className="set-guide">
              Grants {RECOMMENDED_GIT_SUMMARY.grants}. Also adds guards, which are DENIES, against{' '}
              {RECOMMENDED_GIT_SUMMARY.guards}. The guards duplicate the app-wide fence, so this
              button cannot get a blocked command through; it can only add to what is blocked.
            </p>

            <div className="set-sub">Pattern rules, matched before the classifier runs</div>
          <RuleList
            label="Allow"
            rules={allow}
            onChange={setAllow}
            placeholder="Bash(gh pr merge:*)"
            hint="Decided here and never sent to the classifier, in any permission mode. Glob match, so Bash(git push:*) covers git push --force too."
          />
          <RuleList
            label="Ask"
            rules={ask}
            onChange={setAsk}
            placeholder="Bash(*supabase functions deploy*)"
            hint="Stops this chat and asks you, instead of deciding. A deny tells the agent no and it works around it before you can answer; an ask holds the chat still until you click, then runs the original command untouched. Beats an allow, and is itself beaten by a deny for the same command."
          />
          <RuleList
            label="Deny"
            rules={deny}
            onChange={setDeny}
            placeholder="Bash(rm -rf:*)"
            hint="Refuses outright, with no chance to approve it. Beats both allow and ask, from any source including the app-wide list."
          />

          <div className="set-sub">Classifier rules, plain English, Auto mode only</div>
          <p className="set-guide">
            Advisory. In testing none of these three keys changed a verdict. Anything that has
            to hold belongs in the pattern rules above.
          </p>
          <RuleList
            label="Allow"
            rules={autoAllow}
            onChange={setAutoAllow}
            placeholder="Pushing commits with git push, as long as it is not a force push"
            hint="Describe the action the way you would to a person."
          />
          <RuleList
            label="Soft deny"
            rules={autoSoftDeny}
            onChange={setAutoSoftDeny}
            placeholder="Anything that sends data to a third-party service"
            hint="Meant to stop and ask rather than refuse."
          />
          <RuleList
            label="Hard deny"
            rules={autoHardDeny}
            onChange={setAutoHardDeny}
            placeholder="Any force push, wherever the flag appears on the line"
            hint="Meant to refuse outright. A pattern allow above wins regardless, because it short-circuits before the classifier is consulted."
            />
          </details>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
