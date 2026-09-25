import { useState } from 'react'
import { GIT_HISTORY_FENCE } from '@shared/permission-bundles'

/**
 * One editable permission-rule bucket.
 *
 * Same chip idiom as the CLI flag list in Settings, because these are the same kind of
 * value: a short opaque string you add or remove whole, never edit in place.
 *
 * Lives in its own file rather than inside SettingsPage because the per-chat override
 * modal renders the identical five buckets, and two copies of a rule editor is exactly
 * how the app-wide list and the per-chat list end up disagreeing about what a rule is.
 */
export function RuleList({ label, hint, placeholder, rules, onChange }: {
  label: string
  hint: string
  placeholder: string
  rules: string[]
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const trimmed = draft.trim()
    setDraft('')
    if (!trimmed || rules.includes(trimmed)) return
    onChange([...rules, trimmed])
  }
  return (
    <div className="set-rulegroup">
      <label className="set-flab">{label}</label>
      {rules.length > 0 && (
        <div className="settings-flag-list">
          {rules.map(rule => (
            <span key={rule} className="settings-flag">
              {rule}
              <button
                className="settings-flag-remove"
                aria-label={`Remove rule: ${rule}`}
                onClick={() => onChange(rules.filter(r => r !== rule))}
              >x</button>
            </span>
          ))}
        </div>
      )}
      <div className="set-withbtn">
        <input
          className="form-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add() }}
          placeholder={placeholder}
        />
        <button className="btn btn-sm" onClick={add}>Add</button>
      </div>
      <p className="set-guide">{hint}</p>
    </div>
  )
}

/**
 * The git rule set, shared by the Settings preset button and the per-chat modal.
 *
 * Measured against the real CLI, in a scratch repo with a local bare remote.
 * In auto mode with no rules, `git push origin HEAD:main` came back "This command requires
 * approval" and the remote stayed empty. With these rules the same push ran and the remote
 * advanced, while the same command with a trailing `--force` was refused before it executed
 * and the remote SHA did not move.
 *
 * Deny beats allow, and both are glob matches rather than plain prefixes, which is the only
 * reason "push but never force push" is expressible: an allow of Bash(git push:*) on its own
 * hands over `git push origin main --force` in the same breath, and a deny anchored to
 * `git push --force` would miss it, because the flag is at the end of the line. Globs catch
 * it wherever it sits.
 *
 * This is still a list of spellings rather than an understanding of git, so an exotic way of
 * writing a force push gets through. It is a fence, not a proof.
 */
export const RECOMMENDED_GIT_RULES = {
  allow: [
    'Bash(git push:*)',
    'Bash(gh pr merge:*)',
    'Bash(gh pr create:*)',
    'Bash(gh pr edit:*)',
    'Bash(gh pr view:*)',
    'Bash(gh pr diff:*)',
  ],
  // The same list the app-wide fence installs, imported rather than retyped. Two hand-kept
  // copies is how the preset ended up denying every branch deletion after the fence had
  // stopped, leaving a chat blocked by a rule its owner had added while trying to unblock it.
  deny: [...GIT_HISTORY_FENCE],
}

/** What the preset adds, in the register of someone who does not read glob patterns. */
export const RECOMMENDED_GIT_SUMMARY = {
  grants: 'pushing commits, and opening, editing or merging pull requests',
  guards: 'force pushes, and deleting a trunk branch such as main on the remote',
}

/** Union that keeps order and drops duplicates. Adding a preset twice is a no-op. */
export function mergeRules(current: string[], extra: string[]): string[] {
  return [...current, ...extra.filter(r => !current.includes(r))]
}
