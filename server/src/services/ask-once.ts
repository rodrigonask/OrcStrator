// One-time ask rules: the refusal card's "Allow once".
//
// WHY. When auto mode refuses a call, nothing is paused, so there is no request anyone can approve.
// An allow rule is the wrong instrument for "once": it allows the command forever, and for node,
// python, npx and the shells auto mode throws it away regardless, which is how the card's old Allow
// turned into a loop. So the card writes an ASK rule for that call into the chat's `askOnce` list
// and sends the retry note. An ask is checked before the classifier even in auto mode
// (verified against the real CLI), so the retry stops on the banner and one click runs it.
//
// "Once" is enforced here rather than trusted to the agent, in two places:
//  - SPEND. The moment a banner raised by one of these rules is answered, allow or deny, the rule is
//    deleted (control-response route).
//  - DISARM. Each spawn remembers which one-time rules its settings file carried. When that process
//    exits, any of them still stored are deleted too, so a turn where the agent decided the work was
//    already done cannot leave a question lying in wait for some later, unrelated command.
// A rule added while a turn is already running was not in that turn's file, so that turn does not
// arm it, and it survives to the next spawn: the retry the card queued.
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { dedupeRules, ruleMatches, ruleSubjects } from '@orcstrator/shared'
import type { PermissionRequestData } from '@orcstrator/shared'

/** instanceId -> the one-time rules its running process was spawned with. */
const armed = new Map<string, string[]>()

function readRuleColumn(instanceId: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT permission_rules AS v FROM instances WHERE id = ?').get(instanceId) as
    | { v: string | null }
    | undefined
  if (!row?.v) return null
  try {
    const parsed = JSON.parse(row.v)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function storedAskOnce(rules: Record<string, unknown> | null): string[] {
  return Array.isArray(rules?.askOnce) ? dedupeRules(rules.askOnce as unknown[]) : []
}

function removeAskOnce(instanceId: string, spent: string[]): void {
  const rules = readRuleColumn(instanceId)
  const current = storedAskOnce(rules)
  const remaining = current.filter(r => !spent.includes(r))
  if (!rules || remaining.length === current.length) return

  const next: Record<string, string[]> = {}
  for (const [key, value] of Object.entries({ ...rules, askOnce: remaining })) {
    if (!Array.isArray(value)) continue
    const list = dedupeRules(value)
    if (list.length > 0) next[key] = list
  }
  const stored = Object.keys(next).length > 0 ? JSON.stringify(next) : null
  db.prepare('UPDATE instances SET permission_rules = ? WHERE id = ?').run(stored, instanceId)
  // instance:updated copies only the fields present, so id plus the rules is a complete update.
  // null rather than undefined when nothing is left: JSON drops an undefined key, and every other
  // tab would keep showing the rule that was just spent.
  broadcastEvent({ type: 'instance:updated', payload: { id: instanceId, permissionRules: stored ? next : null } })
}

/** At spawn: remember which one-time rules this process's settings file carries. */
export function armAskOnce(instanceId: string): void {
  try {
    const rules = storedAskOnce(readRuleColumn(instanceId))
    if (rules.length > 0) armed.set(instanceId, rules)
    else armed.delete(instanceId)
  } catch {
    armed.delete(instanceId)
  }
}

/** A banner was answered: delete the one-time rules that raised it. */
export function spendAskOnceFor(instanceId: string, request: PermissionRequestData): void {
  try {
    const once = storedAskOnce(readRuleColumn(instanceId))
    if (once.length === 0) return
    const candidates = ruleSubjects(request.toolName, request.input)
    const spent = once.filter(rule => rule === request.matchedAskRule || ruleMatches(rule, request.toolName, candidates))
    if (spent.length > 0) removeAskOnce(instanceId, spent)
  } catch (err) {
    console.warn(`[ask-once] could not spend one-time rules for ${instanceId}:`, (err as Error).message)
  }
}

/** At exit: delete whatever one-time rules this process was spawned with and never used. */
export function disarmAskOnce(instanceId: string): void {
  const rules = armed.get(instanceId)
  armed.delete(instanceId)
  if (!rules?.length) return
  try {
    removeAskOnce(instanceId, rules)
  } catch (err) {
    console.warn(`[ask-once] could not disarm one-time rules for ${instanceId}:`, (err as Error).message)
  }
}
