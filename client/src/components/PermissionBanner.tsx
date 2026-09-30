import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, ChatMessage, MessageContentBlock, PermissionRequestData, PermissionRuleSet } from '@shared/types'
import { addAllowRulesUpdate, ruleSubjects } from '@shared/permission-rules'
import { useMessagesSelector } from '../context/MessagesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useUI } from '../context/UIContext'
import { useInstance } from '../context/InstancesContext'
import { api } from '../api'
import { effectiveRules, planStandingAllow, ruleMatches } from '../utils/permissionMatch'
import { usePermissionScope } from '../hooks/usePermissionScope'
import { PermissionScopePicker } from './PermissionScopePicker'

/**
 * The agent's reason for a gated tool call lives in the assistant text that
 * preceded the tool_use in the same turn. Surface it here so Allow/Deny isn't a
 * context-free command dump — otherwise the "why" sits one message up, visually
 * divorced from the decision the user is being asked to make.
 */
function findRationale(msgs: ChatMessage[] | undefined, perm: PermissionRequestData): string {
  if (!msgs?.length) return ''

  // Tightest signal: the contiguous text blocks immediately before THIS tool call.
  if (perm.toolUseId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== 'assistant') continue
      const callIdx = m.content.findIndex(b => b.type === 'tool-call' && b.toolId === perm.toolUseId)
      if (callIdx === -1) continue
      const seg: string[] = []
      for (let j = callIdx - 1; j >= 0 && m.content[j].type === 'text'; j--) {
        seg.unshift((m.content[j] as Extract<MessageContentBlock, { type: 'text' }>).text)
      }
      const before = seg.join('\n').trim()
      if (before) return before
      break // matched the call but no preceding text — fall back to last spoken text
    }
  }

  // Fallback: the most recent assistant text (the permission gate fires right after it).
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'assistant') continue
    const t = m.content
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim()
    if (t) return t
  }
  return ''
}

export type AllowAlwaysOffer = { rules: string[]; why?: undefined } | { rules: null; why: string }

/**
 * Whether "Allow always" can honestly be offered for this request, and with which rules.
 *
 * Every hidden case is one where the button would save something and change nothing, which would
 * trap the operator in a loop of clicking Allow and being asked again. Checked in this order:
 *
 *  1. The CLI says a saved rule will not apply to this call (`suppress_always_allow_rule`).
 *  2. A safety check. An Edit under `.claude/` went to the classifier with bare `Edit` ALLOWED just
 *     as it did with no rule at all (measured against the real CLI), so a saved
 *     rule does not move it. `classifier_approvable: false` is the stricter form of the same thing.
 *  3. An ask rule raised it. An ask beats an allow, including a session allow sent back in this very
 *     answer (the CLI asks again). The deploy fence is an ask rule, and it is deliberately gated by
 *     hand, so one click must never switch deploys on for every chat. A one-time question from the
 *     refusal card is also an ask rule, and "always" is the opposite of what was asked for.
 *  4. No standing rule survives auto mode, or every chat already has one.
 */
export function offerAllowAlways(
  perm: PermissionRequestData,
  settings: AppSettings,
  chatRules: PermissionRuleSet | undefined,
  projectRules?: PermissionRuleSet,
): AllowAlwaysOffer {
  if (perm.suppressAlwaysAllowRule) return { rules: null, why: 'Always asks: Claude will not save a rule for this one.' }
  if (perm.decisionReasonType === 'safetyCheck' || perm.classifierApprovable === false) {
    return { rules: null, why: 'Always asks: this touches a protected file.' }
  }

  const candidates = ruleSubjects(perm.toolName, perm.input)
  const asked = effectiveRules(settings, chatRules, projectRules).ask.find(r => ruleMatches(r.rule, perm.toolName, candidates))
  if (asked?.source === 'deploy-fence') return { rules: null, why: 'Always asks: deploys are approved by hand.' }
  if (asked?.source === 'one-time') return { rules: null, why: 'Asking once, as you chose.' }
  if (asked || perm.decisionReasonType === 'rule' || perm.matchedAskRule) {
    return { rules: null, why: 'Always asks: a rule says so.' }
  }

  const plan = planStandingAllow(perm.toolName, perm.input, settings, chatRules, perm.permissionSuggestions, projectRules)
  if (plan.rules) return { rules: plan.rules }
  if (plan.blocked === 'too-broad') return { rules: null, why: 'Only once: auto mode ignores a standing rule this broad.' }
  if (plan.blocked === 'already-allowed') return { rules: null, why: 'Every chat already allows this from its next turn.' }
  return { rules: null, why: 'Only once: no safe rule fits this command.' }
}

/**
 * Tool-permission banner for the can_use_tool control protocol
 * (--permission-prompt-tool stdio). Shown when Claude blocks on a tool that
 * needs approval; the answer writes a control_response and the turn resumes
 * in-process (no kill/resume). Sibling to CliPromptBanner (login/api-key).
 *
 * Shows the OLDEST pending request for the chat, with "1 of N" when more are waiting. Parallel
 * calls really do block together: two Read calls in one message were both pending before either was
 * answered, and answering them newest first works (measured against the real CLI). A single slot
 * per chat would lose the first of them and hang the turn.
 *
 *  - Allow once: runs this call, nothing saved.
 *  - Allow always: runs it, tells the running process to stop asking for the same thing this turn
 *    (updatedPermissions, destination session), and saves the rule at the SCOPE picked beside the
 *    button, so every chat in that scope has it from its next spawn. Hidden with a one-line reason
 *    whenever it would change nothing.
 *  - Deny: refuses this call.
 *
 * Why a scope picker: app-wide alone is the right default and the wrong only option, since a grant for one repo became a grant every chat on
 * the machine carried, with no way to say otherwise at the moment of clicking. Whatever the scope,
 * the session update still rides along, so the turn in front of the operator unblocks either way.
 */
export function PermissionBanner({ instanceId }: { instanceId: string }) {
  const queue = useMessagesSelector(s => s.permissionRequests[instanceId])
  const chatMessages = useMessagesSelector(s => s.messages[instanceId])
  const { dispatch } = useAppDispatch()
  const { settings } = useUI()
  const thisInstance = useInstance(instanceId)
  const [notice, setNotice] = useState<string | null>(null)
  const scopeControl = usePermissionScope(instanceId)


  const perm = queue?.[0]
  const chatRules = useMemo(() => thisInstance?.permissionRules, [thisInstance])
  const projectRules = scopeControl.projectRules
  const always = useMemo(
    () => (perm ? offerAllowAlways(perm, settings, chatRules, projectRules) : null),
    [perm, settings, chatRules, projectRules],
  )

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 9000)
    return () => clearTimeout(timer)
  }, [notice])

  if (!perm) return notice ? <div className="permission-banner-notice">{notice}</div> : null

  const answer = (behavior: 'allow' | 'deny', rules?: string[]) => {
    // Optimistic removal so the same request can't be answered twice; the turn unblocks server-side.
    dispatch({ type: 'RESOLVE_PERMISSION', payload: { instanceId, requestId: perm.requestId } })
    // The allow branch REQUIRES updatedInput — round-trip the original tool input unchanged.
    api.controlResponse(instanceId, {
      requestId: perm.requestId,
      behavior,
      ...(behavior === 'allow' ? { input: perm.input } : {}),
      ...(rules ? { updatedPermissions: [addAllowRulesUpdate(rules, 'session')] } : {}),
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      // The server says this request is done with: the chat stopped, or it was already answered or
      // withdrawn. Nothing to put back.
      if (/process-not-running|request-gone/.test(msg)) {
        setNotice('The chat had already stopped, so the command did not run. Send the request again.')
        return
      }
      // Anything else and the CLI may still be waiting on this answer. A card that vanished on a failed
      // click left the chat blocked with nothing on screen, for as long as the server spares a waiting
      // prompt (hours now), so it comes back.
      dispatch({ type: 'ADD_PERMISSION', payload: perm })
      setNotice('That answer did not reach the chat. The card is back, try again.')
    })
  }

  /**
   * Run it now, and save the rule at the picked scope.
   *
   * The session update goes out first and unconditionally, because that is what unblocks the turn
   * the operator is looking at. The stored rule is what covers the NEXT spawn, and it is the part
   * that can fail: the receipt names the rule and the scope either way, so a click is never
   * ambiguous about which of the three lists just changed, and a failure says which one did not.
   */
  const allowAlways = (rules: string[]) => {
    const { label, scope } = scopeControl
    answer('allow', rules)
    scopeControl.save(rules)
      .then(() => setNotice(`Allowed ${rules.join(', ')} for ${label}.`))
      .catch(err => {
        console.error('Saving the allow rule failed:', err)
        setNotice(
          scope === 'app'
            ? `Allowed for this turn, but ${rules.join(', ')} did not save for all chats. Add it in Settings, Permission Rules.`
            : `Allowed for this turn, but ${rules.join(', ')} did not save for ${label}. Try again from Permissions in the session menu.`,
        )
      })
  }

  const hasInput = perm.input && Object.keys(perm.input).length > 0
  const rationale = findRationale(chatMessages, perm)
  const alwaysRules = always?.rules ?? null

  return (
    <div className="permission-banner">
      <span className="cli-prompt-icon">&#x26A0;</span>
      <div className="cli-prompt-body">
        <div className="cli-prompt-label">
          Permission required: <code>{perm.displayName || perm.toolName}</code>
          {queue.length > 1 && (
            <span className="permission-banner-count" title="Requests waiting in this chat, oldest first">
              1 of {queue.length}
            </span>
          )}
        </div>
        {rationale && (
          <div className="permission-banner-why" title={rationale}>
            <span className="permission-banner-why-tag">Why</span>
            <span className="permission-banner-why-text">{rationale}</span>
          </div>
        )}
        {perm.description && <div className="cli-prompt-detail">{perm.description}</div>}
        {hasInput && (
          <pre className="permission-banner-input">{JSON.stringify(perm.input, null, 2)}</pre>
        )}
        <div className="cli-prompt-action-row">
          <button className="cli-prompt-allow" title="Runs this one call" onClick={() => answer('allow')}>
            Allow once
          </button>
          {alwaysRules && (
            <span className="perm-scope-pair">
              <button
                className="cli-prompt-allow-always"
                title={`Runs it now, and allows ${alwaysRules.join(', ')} ${scopeControl.blurb} from now on`}
                onClick={() => allowAlways(alwaysRules)}
              >
                Allow always
              </button>
              <PermissionScopePicker control={scopeControl} />
            </span>
          )}
          <button className="cli-prompt-deny" title="Refuses this call" onClick={() => answer('deny')}>Deny</button>
        </div>
        {always?.why && <div className="permission-banner-why-not">{always.why}</div>}
        {notice && <div className="permission-banner-notice">{notice}</div>}
      </div>
    </div>
  )
}
