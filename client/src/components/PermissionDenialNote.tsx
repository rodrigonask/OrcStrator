import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react'
import type { ChatMessage, PermissionRuleSet } from '@shared/types'
import { askOnceRuleFor, dedupeRules } from '@shared/permission-rules'
import { useUI } from '../context/UIContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'
import { readPermMode, permissionModeFlag } from '../utils/permMode'
import { usePermissionScope } from '../hooks/usePermissionScope'
import { PermissionScopePicker } from './PermissionScopePicker'
import { effectivePermissionMode } from '@shared/constants'
import {
  explainDenial,
  isClassifierDenial,
  classifierReason,
  parseToolInput,
  planStandingAllow,
  refusalLine,
  ruleSubject,
  SOURCE_FIX,
  type RuleSource,
  type StandingAllowPlan,
} from '../utils/permissionMatch'

/**
 * Why a tool call was refused, on the refused call itself, with what can be done about it.
 *
 * Mounted only when a tool result already looks like a permission refusal, so the context
 * subscriptions below cost nothing on the thousands of calls that succeed.
 *
 * Three short lines: what refused it, the rule or the refusal's own words, and the buttons.
 * Any button collapses the card to a one-line receipt. A multi-paragraph red box reads as an
 * alarm out of all proportion to a refused tool call, so the whole thing is quiet by
 * construction.
 *
 * Two failure modes shape the mechanics:
 *
 *  - The explanation must not FLIP after the click. Granting the deploy bundle changes the
 *    chat's rules; if the diagnosis re-ran against the new rules it would find nothing denying
 *    the call any more and switch to "no deny rule covers it" before the "granted" line could
 *    render, telling the reader the opposite of what had just happened. So the diagnosis is
 *    frozen the instant a button is clicked and never re-evaluated: what the card explains is
 *    the refusal that happened, not the rules as they are now.
 *  - A mid-turn grant must reach the chat. Skipping the retry while the chat is running (a
 *    plain send would 409) would save the grant while the chat carried on with no idea it had
 *    been given anything, and the operator would have to ask again by hand. The retry goes
 *    through the "by the way" endpoint, which queues the note while a turn runs and fires it
 *    as a follow-up the moment the turn ends, or sends it now when idle.
 *
 * WHEN AUTO MODE REFUSED IT the card offers Allow once, Allow always and Deny. The old
 * single Allow saved a per-chat ALLOW rule, and for a `node -e "..."` call that rule was
 * `Bash(node:*)`, which auto mode silently drops. The retry was refused again and the operator
 * clicked Allow in a loop. So:
 *
 *  - Allow once saves a one-time ASK rule for this exact call (askOnce) and sends the retry. An ask
 *    is checked before the classifier even in auto mode, so the retry stops on the banner and one
 *    click runs it. The server deletes the rule once its banner is answered, or when the turn it was
 *    armed for ends. It works for commands that have no "always" rule at all.
 *  - Allow always saves an allow rule, only ever one auto mode keeps, then sends the retry. The
 *    scope picker beside the button says WHERE: this chat, this project, or all chats, defaulting
 *    to whichever was picked last and to all chats before that. App-wide alone was the
 *    right default and the wrong only option, since a grant for one repo became a grant every chat
 *    on the machine carried. Hidden, with one line saying why, when no such rule exists at all.
 *
 * WHEN A DENY RULE REFUSED IT the card keeps its older behaviour. A fence or app-wide deny only
 * Settings can lift, so there is no allow button at all: a button that cannot do what its label says
 * is worse than none. A deny on this chat's own list, or the deploy gate, gets "Allow in this chat",
 * which is still scoped to this chat and says so.
 */

type Offer = 'once' | 'always' | 'chat'

interface Diagnosis {
  head: string
  detail: ReactNode
  /** Deny-rule branches: the per-chat change "Allow in this chat" makes, or null when none can. */
  chatGrant: Partial<PermissionRuleSet> | null
  /** Auto mode judged it, or nothing explains it: the Allow once / Allow always form applies. */
  judged: boolean
  /** The one-time ask rule Allow once would save. */
  once: string | null
  /** What Allow always would save, or why it cannot. */
  always: StandingAllowPlan
}

interface Decision {
  receipt: string
  head: string
  detail: ReactNode
}

/**
 * Decisions already made, keyed by tool id.
 *
 * Tool groups collapse and remount, and a remount starts from a blank diagnosis. Without this
 * the one-line receipt would spring back into the full card, buttons and all, and offer
 * the operator a grant they had already made. Memory for the open tab only, like the tool
 * results themselves (see the `toolResults` comment in context/AppContext.tsx): a reload
 * starts clean, and so does the card.
 */
const decisions = new Map<string, Decision>()

const HEAD_BY_SOURCE: Record<RuleSource, string> = {
  // Unreachable while the deploy fence is an ask rather than a deny: an ask never
  // refuses, so it never appears in `denied`. Kept because RuleSource requires every key, and
  // because it is the right wording if the fence is ever moved back.
  'deploy-fence': 'Refused by the deploy gate',
  'this-chat': "Refused by this chat's deny list",
  fence: 'Refused by the destructive fence',
  'app-wide': 'Refused by the app-wide deny list',
  // Reachable only if a deny is ever written at project scope. The picker saves allow rules and
  // only allow rules, but the column takes the same shape as the other two and the spawn path
  // unions a deny found there, so the card has to be able to name it rather than fall through to
  // "refused, and no rule says so" about a rule that is sitting right there in the project.
  'this-project': "Refused by this project's deny list",
  // Unreachable: a one-time rule is only ever an ask.
  'one-time': 'Refused by a one-time question',
}

const ALWAYS_WHY: Record<Exclude<StandingAllowPlan['blocked'], undefined>, string> = {
  'too-broad': 'No Allow always: auto mode ignores a standing rule this broad.',
  unreadable: 'No Allow always: no safe rule fits this command.',
  // Measured against the APP-WIDE list, so it is true at every scope: nothing a narrower one could
  // add would change the outcome. See planStandingAllow.
  'already-allowed': 'No Allow always: every chat already allows this, so something else refused it.',
}

const FAILED: Record<Offer, string> = {
  once: 'It did not save. Try again, or open Permissions from the session menu.',
  always: 'It did not save. Open Permissions from the session menu, or Settings, Permission Rules.',
  chat: 'The grant did not save. Open Permissions from the session menu and add it there.',
}

export function PermissionDenialNote({
  toolId,
  toolName,
  input,
  output,
}: {
  toolId?: string
  toolName: string
  input: string
  output?: string
}) {
  const { settings, selectedInstanceId } = useUI()
  const { instances } = useInstances()
  const { dispatch } = useAppDispatch()
  // Scoped to the chat this card is rendered in. In Grid that is the tile's own instance, because
  // GridTile overrides selectedInstanceId per tile (InstanceScope), which is the same id this card
  // has always used to find its chat.
  const scopeControl = usePermissionScope(selectedInstanceId ?? undefined)

  const [decision, setDecision] = useState<Decision | null>(
    () => (toolId ? decisions.get(toolId) ?? null : null),
  )
  const [frozen, setFrozen] = useState<Diagnosis | null>(null)
  const [status, setStatus] = useState<{ state: 'idle' | 'saving' | 'failed'; offer?: Offer }>({ state: 'idle' })
  const [expanded, setExpanded] = useState(false)

  const instance = useMemo(
    () => instances.find(i => i.id === selectedInstanceId),
    [instances, selectedInstanceId],
  )
  const chatRules = instance?.permissionRules

  const fromClassifier = isClassifierDenial(output)
  const permMode = instance
    ? readPermMode(instance.id, effectivePermissionMode(settings))
    : effectivePermissionMode(settings)
  const autoMode = fromClassifier || permMode === 'auto'

  const projectRules = scopeControl.projectRules
  const { denied, allowed, asked } = useMemo(
    () => explainDenial(toolName, input, settings, chatRules, { autoMode, projectRules }),
    [toolName, input, settings, chatRules, autoMode, projectRules],
  )

  const reason = classifierReason(output)
  const command = ruleSubject(toolName, input)
  const parsedInput = useMemo(() => parseToolInput(input), [input])
  const line = refusalLine(output)

  const live = useMemo<Diagnosis>(() => {
    const once = askOnceRuleFor(toolName, parsedInput)
    const always = planStandingAllow(toolName, parsedInput, settings, chatRules, undefined, projectRules)
    const base = { chatGrant: null, judged: false, once, always }

    // An ask rule covers this call, so it should have stopped the chat and raised the
    // banner rather than landing here. Two ways it still does: the chat's process
    // was spawned before the rule existed (rules are read from the managed settings file at
    // spawn, so they apply from the next turn), or a hook refused it before the rule was ever
    // consulted. Either way there is nothing to grant: it already IS granted-with-a-question,
    // and the only useful action is to run the turn again.
    if (asked.length > 0 && denied.length === 0) {
      return {
        ...base,
        head: 'This should have asked you, not refused',
        detail: (
          <>
            <code>{asked[0].rule}</code> is set to ask, which stops the chat and waits for you.
            {' '}This chat started before that rule existed, so it never got the question. The next
            {' '}turn will ask properly.
          </>
        ),
      }
    }

    if (denied.length > 0) {
      // Several patterns can cover the same command, and the CLI stops at the first. Naming
      // one of them as "the" cause would be a guess, so all of them are listed: removing any
      // single one leaves the call still blocked.
      const sources = new Set(denied.map(d => d.source))
      const codes = denied.map((d, i) => (
        <Fragment key={`${d.source}:${d.rule}`}>{i > 0 && ' '}<code>{d.rule}</code></Fragment>
      ))
      const head = denied.length === 1
        ? HEAD_BY_SOURCE[denied[0].source]
        : `Refused by ${denied.length} deny rules`

      // A fence, an app-wide rule or a project rule is somebody else's list. This card only touches
      // the chat, and a project deny in particular may live on a folder ABOVE this one, so
      // "Allow in this chat" would have been a button that saved a change and left the call refused.
      const blocker = denied.find(d => d.source === 'fence' || d.source === 'app-wide' || d.source === 'this-project')
      if (blocker) {
        return { ...base, head, detail: <>{codes} Lift it in {SOURCE_FIX[blocker.source]}</> }
      }

      const patch: Partial<PermissionRuleSet> = {}
      const fixes: string[] = []
      if (sources.has('deploy-fence')) {
        patch.bundles = Array.from(new Set([...(chatRules?.bundles ?? []), 'deploy' as const]))
        fixes.push('turns the deploy grant on for this chat')
      }
      if (sources.has('this-chat')) {
        const ours = denied.filter(d => d.source === 'this-chat').map(d => d.rule)
        patch.deny = (chatRules?.deny ?? []).filter(r => !ours.includes(r))
        fixes.push(`takes ${ours.length === 1 ? 'it' : 'them'} off this chat's deny list`)
      }
      return { ...base, head, detail: <>{codes} Allow {fixes.join(', and ')}.</>, chatGrant: patch }
    }

    // Auto mode judged the call itself. There is no rule and no pending request (verified against
    // CLI 2.1.261): the CLI decides instead of asking. Allow once turns the retry into a question,
    // Allow always saves a rule that is matched before the classifier is consulted.
    const judged = reason
      ? <><em>{reason}</em>.</>
      : <>No rule covers it, so auto mode judged the call itself.</>

    if (fromClassifier) {
      return { ...base, head: 'Refused by auto mode, not by a rule', detail: judged, judged: true }
    }

    if (allowed.length > 0) {
      // A rule allows it, auto mode keeps that rule, and nothing denies it, so the refusal came
      // from a PreToolUse hook or the CLI's own guard. Its wording is the whole record, and under
      // Ultra Compact the tool output that holds it is hidden, so it is quoted here.
      return {
        ...base,
        head: 'Refused by a hook or the CLI, not by a rule',
        detail: (
          <>
            {line && <>&ldquo;{line}&rdquo; </>}
            <code>{allowed[0].rule}</code> allows it and nothing denies it.
          </>
        ),
      }
    }

    return { ...base, head: 'Refused, and no rule says so', detail: judged, judged: true }
  }, [denied, allowed, asked, fromClassifier, reason, line, chatRules, projectRules, settings, toolName, parsedInput])

  // Once a button is clicked the rules change under the diagnosis. The frozen copy is what the
  // card shows and what a retry uses, so a failed save can be retried with the same plan.
  const shown = frozen ?? live

  /**
   * What the chat is told once the grant is saved.
   *
   * CONDITIONAL, not imperative, and that is the whole point of the wording. A grant made while
   * a turn is running cannot reach that turn: it is queued and delivered as a fresh turn after
   * the current one ends (see the /btw route), by which time the agent has usually narrated a
   * workaround and done the job another way. The old line was "Run this again, exactly as it
   * was: <command>", which in that situation is an instruction to repeat a mutation on top of a
   * change already applied. The observed case was `cp server.mjs /tmp/server.mjs.bak && <edit>`:
   * re-running it would have overwritten the pre-change backup with the already-modified file.
   *
   * So the note states the fact (permission exists now) and hands the decision back, because the
   * agent is the only party that knows whether the work still needs doing. An `ask` rule is the
   * real fix for the timing, since it stops the turn instead of letting it route around; this
   * line covers what is left, mainly classifier refusals for commands in no ask list.
   */
  const retryLine = command
    ? `Permission has now been granted for: ${command}\n\nIf you already worked around the refusal and the job is done, do NOT run it again, just say so. If the work is still outstanding, run it now.`
    : `Permission has now been granted for ${toolName}. If you already worked around the refusal and the job is done, do NOT retry, just say so. If the work is still outstanding, retry the call that was refused.`

  const settle = useCallback(
    (d: Decision) => {
      if (toolId) decisions.set(toolId, d)
      setDecision(d)
      setFrozen(null)
      setStatus({ state: 'idle' })
    },
    [toolId],
  )

  /**
   * The rule alone is not the fix the operator wanted: rules apply from the NEXT turn, so a grant
   * with no follow-up leaves the chat sitting on a failure it has already narrated and moved past.
   * The note is added to the transcript here because the btw route persists it without
   * broadcasting, same as the composer's /btw path, unless the identical note is already queued.
   */
  const sendRetry = useCallback(async (): Promise<'sent' | 'queued' | 'failed'> => {
    if (!instance) return 'failed'
    try {
      // The retry carries the chat's OWN permission mode, and it has to. A /btw with
      // no flags falls through to the send route, which leaves `globalFlags` alone unless the
      // message names a mode, and globalFlags ships as `['--dangerously-skip-permissions']`. So
      // without it this retry would spawn in BYPASS on a chat set to auto (visible in the
      // server's spawn log). The one thing an "Allow once" must
      // not do is quietly widen the rest of the turn to everything.
      const res = await api.btw(instance.id, retryLine, [permissionModeFlag(permMode)])
      if (!res.duplicate) {
        const note: ChatMessage = {
          id: crypto.randomUUID(),
          instanceId: instance.id,
          role: 'user',
          content: [{ type: 'text', text: retryLine }],
          createdAt: Date.now(),
        }
        dispatch({ type: 'ADD_MESSAGE', payload: note })
      }
      return res.queued ? 'queued' : 'sent'
    } catch (err) {
      console.error('The permission retry did not send:', err)
      return 'failed'
    }
  }, [instance, retryLine, permMode, dispatch])

  const saveChatRules = useCallback(async (next: PermissionRuleSet) => {
    if (!instance) throw new Error('no chat')
    dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { permissionRules: next } } })
    await api.updateInstance(instance.id, { permissionRules: next })
  }, [instance, dispatch])

  const run = useCallback(
    async (offer: Offer, save: () => Promise<void>, receipts: Record<'sent' | 'queued' | 'failed', string>) => {
      const snapshot = shown
      setFrozen(snapshot)
      setStatus({ state: 'saving', offer })
      try {
        await save()
      } catch (err) {
        console.error('Failed to save the permission grant:', err)
        setStatus({ state: 'failed', offer })
        return
      }
      const sent = await sendRetry()
      settle({ receipt: receipts[sent], head: snapshot.head, detail: snapshot.detail })
    },
    [shown, sendRetry, settle],
  )

  const allowOnce = useCallback(() => {
    const rule = shown.once
    if (!instance || !rule) return
    void run('once', () => {
      const current = instance.permissionRules ?? {}
      return saveChatRules({ ...current, askOnce: dedupeRules([...(current.askOnce ?? []), rule]) })
    }, {
      queued: 'Will ask you once, the moment this turn ends.',
      sent: 'Sent back. It will ask you once before it runs.',
      failed: 'Set to ask once, but the retry did not send. Ask for it again.',
    })
  }, [instance, shown, run, saveChatRules])

  /**
   * Saves at the picked scope and sends the retry.
   *
   * The receipt names the RULE and the SCOPE, both, and it is captured before the save so the line
   * cannot drift if the picker is moved afterwards. "Allowed in every chat" was true of the only
   * scope that existed; with three of them a receipt that names neither is a click the operator
   * cannot audit an hour later, which is exactly the state this card was built to end.
   */
  const allowAlways = useCallback(() => {
    const rules = shown.always.rules
    if (!instance || !rules) return
    const what = `${rules.join(', ')} for ${scopeControl.label}`
    void run('always', () => scopeControl.save(rules), {
      queued: `Allowed ${what}. Runs the moment this turn ends.`,
      sent: `Allowed ${what}. Sent back to run again.`,
      failed: `Allowed ${what}. The retry did not send, ask for it again.`,
    })
  }, [instance, shown, run, scopeControl])

  const allowInChat = useCallback(() => {
    const patch = shown.chatGrant
    if (!instance || !patch) return
    void run('chat', () => saveChatRules({ ...(instance.permissionRules ?? {}), ...patch }), {
      queued: 'Allowed for this chat. Runs the moment this turn ends.',
      sent: 'Allowed for this chat. Sent back to run again.',
      failed: 'Allowed for this chat. The retry did not send, ask for it again.',
    })
  }, [instance, shown, run, saveChatRules])

  const deny = useCallback(() => {
    settle({ receipt: 'Refused, left as is.', head: shown.head, detail: shown.detail })
  }, [shown, settle])

  // The `perm-denial` class stays on the root in every state: styles.css keeps this node
  // visible under Ultra Compact with `:has(.perm-denial)`, and the receipt is the state the
  // card spends most of its life in.
  if (decision) {
    return (
      <div className="perm-denial is-receipt" onClick={() => setExpanded(e => !e)}>
        <div className="perm-denial-row">
          <span className="perm-denial-dot is-done" />
          <span>{decision.receipt}</span>
          <span className={`perm-denial-chevron ${expanded ? 'expanded' : ''}`}>›</span>
        </div>
        {expanded && (
          <>
            <div className="perm-denial-detail"><span className="perm-denial-head">{decision.head}</span></div>
            <div className="perm-denial-detail">{decision.detail}</div>
          </>
        )}
      </div>
    )
  }

  const busy = status.state === 'saving'
  const judged = shown.judged && !!instance
  const canOnce = judged && !!shown.once
  const canAlways = judged && shown.always.rules !== null
  const canChat = !!shown.chatGrant && !!instance
  const label = (offer: Offer, text: string) => (busy && status.offer === offer ? 'Saving…' : text)

  return (
    <div className="perm-denial">
      <div className="perm-denial-row">
        <span className="perm-denial-dot" />
        <span className="perm-denial-head">{shown.head}</span>
      </div>
      <div className="perm-denial-detail">{shown.detail}</div>
      <div className="perm-denial-actions">
        {canOnce && (
          <button
            className="perm-denial-btn"
            disabled={busy}
            title="Sends it back to run again, and asks you once before it does"
            onClick={allowOnce}
          >
            {label('once', 'Allow once')}
          </button>
        )}
        {canAlways && (
          <span className="perm-scope-pair">
            <button
              className="perm-denial-btn"
              disabled={busy}
              title={`Allows ${shown.always.rules?.join(', ')} ${scopeControl.blurb} from now on, then sends it back to run again`}
              onClick={allowAlways}
            >
              {label('always', 'Allow always')}
            </button>
            <PermissionScopePicker control={scopeControl} disabled={busy} />
          </span>
        )}
        {canChat && (
          <button
            className="perm-denial-btn"
            disabled={busy}
            title="Grants it to this chat only, then sends the command back to run again"
            onClick={allowInChat}
          >
            {label('chat', 'Allow in this chat')}
          </button>
        )}
        <button className="perm-denial-btn" disabled={busy} title="Leaves it refused" onClick={deny}>
          Deny
        </button>
        {canChat && <span className="perm-denial-scope">This chat only.</span>}
      </div>
      {judged && shown.always.blocked && (
        <div className="perm-denial-why-not">{ALWAYS_WHY[shown.always.blocked]}</div>
      )}
      {status.state === 'failed' && status.offer && (
        <div className="perm-denial-status">{FAILED[status.offer]}</div>
      )}
    </div>
  )
}
