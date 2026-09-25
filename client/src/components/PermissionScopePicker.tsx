import { PERMISSION_SCOPES, PERMISSION_SCOPE_LABELS, type PermissionScope } from '@shared/permission-rules'
import type { PermissionScopeControl } from '../hooks/usePermissionScope'

/**
 * Where "Allow always" saves, chosen on the button row itself.
 *
 * A one-line select, not a modal and not three pills. It sits immediately after the button so the
 * row reads as one sentence, "Allow always / for all chats", and the two are never separated by a
 * decision: the scope is already set when the button is reached, and the button's own tooltip
 * repeats it. A modal would have put a second confirmation in front of a grant the operator had
 * already decided to make, which is how the old refusal card earned "massive, gigantic red stuff".
 *
 * The project option is disabled rather than hidden when a chat has no registered folder. Hiding it
 * would make the control change shape between chats for a reason nobody could see.
 */
export function PermissionScopePicker({
  control,
  disabled,
}: {
  control: PermissionScopeControl
  disabled?: boolean
}) {
  return (
    // `perm-scope` is inline-flex and the caller wraps it together with the button in
    // `perm-scope-pair`, so the two never land on different lines. Otherwise, in a narrow Grid
    // tile (3 tiles wide), the row breaks as "Allow once / Allow always" then "for this project /
    // Deny", which reads as though the scope belongs to Deny.
    <label className="perm-scope">
      <span className="perm-scope-lead">for</span>
      <select
        className="perm-scope-select"
        value={control.scope}
        disabled={disabled}
        title={`Saves the rule ${control.blurb}`}
        onChange={e => control.setScope(e.target.value as PermissionScope)}
      >
        {PERMISSION_SCOPES.map(scope => (
          <option key={scope} value={scope} disabled={scope === 'project' && !control.project}>
            {scope === 'project' && control.project
              ? `this project (${control.project.displayName || control.project.name})`
              : PERMISSION_SCOPE_LABELS[scope]}
          </option>
        ))}
      </select>
    </label>
  )
}
