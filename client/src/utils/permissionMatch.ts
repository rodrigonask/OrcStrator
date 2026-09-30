import { expandBundles, expandBundleAsks, DESTRUCTIVE_FENCE, DEPLOY_FENCE } from '@shared/permission-bundles'
import {
  deriveAllowRules,
  isAncestorPath,
  normalizeFolderPath,
  parseRule,
  ruleMatches as sharedRuleMatches,
  ruleSubject as sharedRuleSubject,
  ruleSubjects,
  rulesFromSuggestions,
  survivesAutoMode,
} from '@shared/permission-rules'
import type { AppSettings, FolderConfig, PermissionRuleSet } from '@shared/types'

/**
 * Work out WHICH rule refused a tool call, so the answer is on screen instead of in a
 * four-round guessing game.
 *
 * This exists because the failure it explains is invisible from both ends. The chat is told
 * only "has been denied", with no pattern and no source, so it goes looking in `.claude/
 * settings.json` and finds nothing, because OrcStrator never writes there: it writes a managed
 * file and passes `--settings`. Meanwhile the operator clicks every grant in the modal and
 * watches nothing change, because a deny beats every allow and the deny came from a fence the
 * modal does not show. Both sides are reasoning correctly about the wrong file.
 *
 * Deliberately client-side. Everything needed is already in the browser (the app settings, the
 * chat's own rules, and the bundle definitions), and the alternative is a server change, which
 * cannot reach a running app until the dev-watch lock clears and every chat is idle. This
 * lands the moment it is merged.
 *
 * It is a reimplementation of the CLI's matcher, not the CLI's matcher, so the UI hedges when
 * it should: one match is reported as the cause, several are listed, none says so plainly. The
 * matcher itself lives in shared/src/permission-rules.ts, because the server
 * needs it too, to spend a one-time question when its banner is answered.
 */

export type RuleSource = 'fence' | 'deploy-fence' | 'app-wide' | 'this-project' | 'this-chat' | 'one-time'

export interface MatchedRule {
  rule: string
  source: RuleSource
}

/** Where a rule came from, and whether the operator can do anything about it from here. */
export const SOURCE_LABEL: Record<RuleSource, string> = {
  fence: 'the destructive fence, app-wide',
  // An ask, not a deny: it stops the chat and raises the banner.
  'deploy-fence': 'the deploy gate, app-wide',
  'app-wide': 'the app-wide deny list',
  // Project scope. Inherited down the folder tree, so the rule may live on a
  // folder ABOVE the one this chat sits in.
  'this-project': "this project's own list",
  'this-chat': "this chat's own deny list",
  // Only ever an ask: the refusal card's "Allow once".
  'one-time': 'a one-time question for this chat',
}

export const SOURCE_FIX: Record<RuleSource, string> = {
  fence: 'Settings, Block destructive commands.',
  'deploy-fence': 'Turn the "Deploy to live sites and servers" grant on, here or in Settings.',
  'app-wide': 'Settings, Permission Rules, Deny.',
  'this-project': 'Permissions on this chat, under the project heading.',
  'this-chat': 'Advanced below, Deny.',
  'one-time': 'Nothing to lift: it asks once and is then deleted.',
}

/**
 * True when the tool result is the CLI refusing on permission grounds.
 *
 * Matches the shapes the CLI actually emits and nothing looser. A bare "permission denied" is
 * excluded on purpose: that is what the filesystem says when a chmod is wrong, and blaming a
 * rule for an EACCES would be worse than saying nothing.
 *
 * The "was denied" pattern matters because the classifier refusal is the most common one in an
 * auto-mode chat. Auto mode's wording is "Permission for this action WAS denied", while the other
 * shapes say "HAS BEEN denied", so without it that refusal would render as a plain red tool error
 * with no explanation attached (verified against CLI 2.1.261), and the component built to explain
 * this exact failure would never mount.
 */
export function looksLikeDenial(output: string | undefined): boolean {
  if (!output) return false
  const head = output.slice(0, 400)
  return (
    /\bhas been denied\b/i.test(head) ||
    /\bwas denied\b/i.test(head) ||
    /\brequested permissions? to use\b/i.test(head) ||
    /\brequires approval\b/i.test(head)
  )
}

/**
 * True when auto mode's server-side classifier made the call, rather than a rule anyone wrote.
 *
 * Worth separating because the two failures have opposite fixes and opposite explanations. A
 * rule denial is deterministic, local, and visible in the modal. A classifier denial is a
 * judgement made on Anthropic's side, per call, and it never reaches OrcStrator's Allow/Deny
 * banner at all: in auto mode the CLI decides instead of emitting `can_use_tool`, so there is
 * no pending request for anyone to approve. Saying "approve it in the UI" would be a lie.
 */
export function isClassifierDenial(output: string | undefined): boolean {
  if (!output) return false
  return /auto mode classifier/i.test(output.slice(0, 400))
}

/** The classifier's own one-line reason, when it gave one. */
export function classifierReason(output: string | undefined): string | null {
  if (!output) return null
  const m = /auto mode classifier\.\s*Reason:\s*([^.\n]{1,120})/i.exec(output.slice(0, 400))
  return m ? m[1].trim() : null
}

/**
 * The refusal's own first line, for the cases where the matcher cannot name a rule.
 *
 * Under Ultra Compact the tool output is hidden, so "the tool output above is the only
 * record" pointed at something the operator could not see. When a hook or the CLI's own
 * guard did the refusing, its wording is the whole explanation, and the card has to carry it.
 * Cut to 160 characters: a hook that prints a paragraph still gets one line here.
 */
export function refusalLine(output: string | undefined): string | null {
  if (!output) return null
  const first = output.split(/\r?\n/).map(l => l.trim()).find(Boolean)
  if (!first) return null
  return first.length > 160 ? `${first.slice(0, 159)}…` : first
}

/** A tool call's input as the transcript stores it (a JSON string), as an object, or null. */
export function parseToolInput(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The string a rule is matched against, for an input stored as JSON text. See shared ruleSubject. */
export function ruleSubject(toolName: string, input: string): string {
  return sharedRuleSubject(toolName, parseToolInput(input))
}

export const ruleMatches = sharedRuleMatches

/**
 * The project rules a chat in `folderId` carries: its own folder's, plus every registered folder
 * ABOVE it by path, outermost first.
 *
 * Path, not a parent column, because that is how the sidebar decides what is nested inside what
 * (buildFolderTree in Sidebar.tsx) and how the server resolves the same chain at spawn
 * (server/src/services/folder-rules.ts). Three implementations of "inside" would be two too many,
 * so all three read the path.
 */
export function projectRuleChain(
  folders: readonly FolderConfig[],
  folderId: string | undefined,
): Array<{ folder: FolderConfig; rules: PermissionRuleSet }> {
  const self = folders.find(f => f.id === folderId)
  if (!self) return []
  return folders
    .filter(f => f.permissionRules && (f.id === self.id || (!!f.path && !!self.path && isAncestorPath(f.path, self.path))))
    .sort((a, b) => normalizeFolderPath(a.path).length - normalizeFolderPath(b.path).length)
    .map(folder => ({ folder, rules: folder.permissionRules as PermissionRuleSet }))
}

/** Every bucket in the chain, unioned. What the spawn path writes into the settings file. */
export function mergeProjectRules(
  chain: Array<{ folder: FolderConfig; rules: PermissionRuleSet }>,
): PermissionRuleSet {
  const out: Record<string, string[]> = {}
  for (const { rules } of chain) {
    for (const [key, value] of Object.entries(rules)) {
      if (!Array.isArray(value)) continue
      out[key] = [...(out[key] ?? []), ...value.filter(v => !(out[key] ?? []).includes(v))]
    }
  }
  return out as PermissionRuleSet
}

/**
 * Rebuild the exact allow, deny and ask lists this chat was spawned with.
 *
 * Mirrors `cliSettingsArgs` in server/src/services/hook-injector.ts, including the condition on
 * the deploy fence: it is only installed once some grant is on, so a fresh install with no
 * bundles adds nothing at all.
 *
 * `projectRules` is the folder chain that goes with the scope picker. It has to be here and
 * not only on the server: this function is what the refusal card explains a denial with, and a
 * scope it cannot see is a rule it would blame the wrong source for, or miss entirely.
 */
export function effectiveRules(
  settings: AppSettings,
  chatRules: PermissionRuleSet | undefined,
  projectRules?: PermissionRuleSet,
) {
  const activeBundles = [
    ...(settings.permissionBundles ?? []),
    ...(projectRules?.bundles ?? []),
    ...(chatRules?.bundles ?? []),
  ]

  const allow: MatchedRule[] = [
    ...expandBundles(activeBundles).map(rule => ({ rule, source: 'app-wide' as const })),
    ...(settings.permissionAllowRules ?? []).map(rule => ({ rule, source: 'app-wide' as const })),
    ...(projectRules?.allow ?? []).map(rule => ({ rule, source: 'this-project' as const })),
    ...(chatRules?.allow ?? []).map(rule => ({ rule, source: 'this-chat' as const })),
  ]

  const deny: MatchedRule[] = [
    ...(settings.blockDestructive !== false
      ? DESTRUCTIVE_FENCE.map(rule => ({ rule, source: 'fence' as const }))
      : []),
    ...(settings.permissionDenyRules ?? []).map(rule => ({ rule, source: 'app-wide' as const })),
    ...(projectRules?.deny ?? []).map(rule => ({ rule, source: 'this-project' as const })),
    ...(chatRules?.deny ?? []).map(rule => ({ rule, source: 'this-chat' as const })),
  ]

  // The deploy fence is an ASK, not a deny. It does not refuses anything, so
  // it must not appear in `deny`: naming it as the cause of a refusal would send the reader to
  // lift a rule that is not what stopped them. The spawn side filters ask against deny for the
  // same reason a deny is listed first here, a deny beating an ask.
  const ask: MatchedRule[] = [
    ...(!activeBundles.includes('deploy')
      ? DEPLOY_FENCE.map(rule => ({ rule, source: 'deploy-fence' as const }))
      : []),
    ...expandBundleAsks(activeBundles).map(rule => ({ rule, source: 'app-wide' as const })),
    ...(settings.permissionAskRules ?? []).map(rule => ({ rule, source: 'app-wide' as const })),
    ...(projectRules?.ask ?? []).map(rule => ({ rule, source: 'this-project' as const })),
    ...(chatRules?.ask ?? []).map(rule => ({ rule, source: 'this-chat' as const })),
    // askOnce is per-chat and stays there: a one-time question belongs to the chat that asked
    // for it, and a project-wide "ask me once" would fire in whichever chat got there first.
    ...(chatRules?.askOnce ?? []).map(rule => ({ rule, source: 'one-time' as const })),
  ].filter(r => !deny.some(d => d.rule === r.rule))

  return { allow, deny, ask }
}

export interface DenialExplanation {
  /** Deny rules that match this call. A deny beats every allow, whatever the source. */
  denied: MatchedRule[]
  /** Allow rules that match AND that the CLI actually honours. Only interesting when nothing denies. */
  allowed: MatchedRule[]
  /**
   * Ask rules that match.
   *
   * A match here should have produced a BANNER, not this card, because an ask holds the turn
   * open rather than refusing. So a non-empty list on a refused call means the refusal came
   * from somewhere else (a hook, the classifier, or a process spawned before the rule existed),
   * and the card says so instead of blaming a rule that does not refuse anything.
   */
  asked: MatchedRule[]
}

/**
 * `autoMode` drops the allow rules the CLI throws away in auto mode (see survivesAutoMode). Without
 * it the card would say "Bash(node:*) allows it and nothing denies it" about a `node -e` call auto
 * mode had just refused, which is true of the settings file and false of the running CLI.
 */
export function explainDenial(
  toolName: string,
  input: string,
  settings: AppSettings,
  chatRules: PermissionRuleSet | undefined,
  opts: { autoMode?: boolean; projectRules?: PermissionRuleSet } = {},
): DenialExplanation {
  const candidates = ruleSubjects(toolName, parseToolInput(input))
  const { allow, deny, ask } = effectiveRules(settings, chatRules, opts.projectRules)
  const seen = new Set<string>()
  const denied = deny.filter(r => {
    if (seen.has(r.rule)) return false
    seen.add(r.rule)
    return ruleMatches(r.rule, toolName, candidates)
  })
  const seenAsk = new Set<string>()
  const asked = ask.filter(r => {
    if (seenAsk.has(r.rule)) return false
    seenAsk.add(r.rule)
    return ruleMatches(r.rule, toolName, candidates)
  })
  const allowed = allow.filter(r =>
    (!opts.autoMode || survivesAutoMode(r.rule)) && ruleMatches(r.rule, toolName, candidates))
  return { denied, allowed, asked }
}

export type StandingAllowPlan =
  | { rules: string[]; blocked?: undefined }
  | { rules: null; blocked: 'too-broad' | 'unreadable' | 'already-allowed' }

/**
 * The app-wide allow rules an "Allow always" would save for this call, or why there are none.
 *
 * Shared by the banner and the refusal card so the two can never disagree about what "always"
 * means for the same command.
 *
 *  - The CLI's own `permission_suggestions` win when they are standing rules (a trailing `*`) that
 *    auto mode keeps. An exact one-off like `Bash(mkdir d_one)`, which is what the CLI suggested for
 *    `mkdir d_one` (measured against the CLI), is not an "always" in any sense a person would mean, so
 *    that falls through to the derived prefix.
 *  - Otherwise the narrowest honest prefix per command segment (shared deriveAllowRules), skipping
 *    segments something app-wide already allows.
 *  - Never a rule auto mode drops. That was the whole bug.
 *
 * Deliberately NOT a function of the chosen scope, even though there are three scopes.
 * Coverage is measured against the APP-WIDE list alone, because that is the only one
 * that makes every scope pointless: if a rule is already on app-wide there is nothing left for
 * "this project" or "this chat" to add either. Narrowing it per scope would make the button appear
 * and disappear as the picker moved, which is a worse thing to watch than one rule saved twice.
 */
export function planStandingAllow(
  toolName: string,
  input: Record<string, unknown> | null,
  settings: AppSettings,
  chatRules: PermissionRuleSet | undefined,
  suggestions?: unknown,
  projectRules?: PermissionRuleSet,
): StandingAllowPlan {
  const standing = rulesFromSuggestions(suggestions).filter(rule => {
    const parsed = parseRule(rule)
    return parsed?.toolName === toolName && (parsed.content ?? '').endsWith('*')
  })
  if (standing.length > 0 && standing.every(survivesAutoMode)) return { rules: standing }

  const { allow } = effectiveRules(settings, chatRules, projectRules)
  const covered = (subject: string) =>
    allow.some(r => r.source === 'app-wide' && survivesAutoMode(r.rule) && ruleMatches(r.rule, toolName, [subject]))
  const plan = deriveAllowRules(toolName, input, covered)
  if (plan.rules === null) return { rules: null, blocked: plan.blocked }
  if (plan.rules.length === 0) return { rules: null, blocked: 'already-allowed' }
  return { rules: plan.rules }
}
