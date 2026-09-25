/**
 * Permission rule helpers the server and the client both need: read a rule, match it against a
 * call, tell whether auto mode will honour an allow rule at all, and turn one refused or gated
 * call into the rule that would cover it next time.
 *
 * WHY THIS EXISTS. A chat running in auto mode had `node -e "..."` refused by the
 * classifier. The refusal card offered Allow, Allow saved `Bash(node:*)` to the chat, the retry was
 * refused again, and the operator clicked Allow a second time for the same result. Nothing was
 * wrong with the save. The CLI silently drops any allow rule that would let a whole interpreter or
 * shell skip the classifier, and says so only in a debug log nobody reads:
 *
 *   Ignoring dangerous permission Bash(node:*) from settings.json (bypasses classifier)
 *
 * A button that saves a rule the CLI then throws away is a loop with a label on it. So every allow
 * rule a button is about to save goes through `survivesAutoMode` first, and when no surviving rule
 * exists the button is hidden with one line saying why, instead of shown and ignored.
 *
 * MEASURED, NOT GUESSED. The two program lists below were read off the live CLI's own debug log
 * (verified against the real CLI 2.1.272) by feeding it well over a hundred rule shapes and
 * checking every one for a disagreement between this file and the CLI. Recheck after a CLI upgrade: a
 * drift here is exactly the loop above, coming back quietly.
 *
 * Findings worth knowing before editing anything:
 *  - Matching is case-insensitive: `Bash(NODE:*)` and `Bash(Npx:*)` are dropped too.
 *  - Naming a script or subcommand survives: `Bash(npx wrangler r2:*)`, `Bash(node reconcile.js:*)`,
 *    `Bash(bash scripts/x.sh:*)`. A flag straight after the program does not: `Bash(node -e:*)`,
 *    `Bash(npx -y cowsay:*)`, `Bash(python -m pytest:*)`. The one exception is a DOTTED python
 *    module, `Bash(python -m http.server:*)`, which survives.
 *  - An exact command with no trailing star survives, quotes and parentheses included:
 *    `Bash(node -e "console.log(1)")`. It is just useless as an "always" rule, since nobody runs
 *    the same one-liner twice.
 *  - `npm`, `pnpm`, `yarn`, `pip`, `cargo`, `go`, `make`, `curl`, `wget`, `aws`, `gcloud`, `gsutil`,
 *    `kubectl` and `docker` all survive in every shape tried. Only `npm run`, `yarn run`, `pnpm run`
 *    and `bun run` are on the list, not the package managers themselves.
 *  - PowerShell drops every program on the Bash list AND its own launchers (pwsh, cmd, iex, wsl,
 *    Start-Process and friends). Bare `PowerShell`, which the "run" bundle grants, is dropped.
 *  - Every `Agent` rule is dropped, bare or scoped.
 */

/** A rule split into its tool and the text between the parentheses. */
export interface ParsedRule {
  toolName: string
  /** Null for a bare tool name, which covers every call to that tool. */
  content: string | null
}

/** One rule in the CLI's structured form, as `permission_suggestions` and `updatedPermissions` carry it. */
export interface PermissionRuleValue {
  toolName: string
  ruleContent?: string
}

/**
 * The CLI's PermissionUpdate: what a can_use_tool request suggests in `permission_suggestions`, and
 * what a control_response may hand back in `updatedPermissions`. Only `addRules` is ever produced
 * here. The other kinds (setMode, addDirectories and so on) are typed loosely so a suggestion this
 * code does not use still passes through intact instead of failing to parse.
 */
export interface PermissionUpdate {
  type: string
  rules?: PermissionRuleValue[]
  behavior?: 'allow' | 'deny' | 'ask'
  destination?: string
  mode?: string
  directories?: string[]
}

export function parseRule(rule: string): ParsedRule | null {
  const m = /^([A-Za-z_][\w-]*)(?:\(([\s\S]*)\))?$/.exec(rule.trim())
  if (!m) return null
  return { toolName: m[1], content: m[2] === undefined || m[2] === '' ? null : m[2] }
}

export function formatRule(toolName: string, content?: string | null): string {
  return content ? `${toolName}(${content})` : toolName
}

export function isShellTool(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'PowerShell'
}

/**
 * Trimmed, blanks dropped, first occurrence kept. One chat's stored list read
 * `["Bash(node _goalput.cjs:*)","Edit","Edit","Edit","Edit"]`: four clicks of the
 * same grant, four copies, and a Permissions modal that showed the operator every one of them.
 */
export function dedupeRules(list: readonly unknown[] | undefined): string[] {
  if (!list) return []
  const out: string[] = []
  for (const value of list) {
    if (typeof value !== 'string') continue
    const rule = value.trim()
    if (rule && !out.includes(rule)) out.push(rule)
  }
  return out
}

// === Matching ===

/**
 * The string a rule's pattern is matched against, per tool. Bash and PowerShell rules match the
 * command; the file tools match the path. Anything else has no subject, which is correct: its
 * rules are written as a bare tool name.
 */
export function ruleSubject(toolName: string, input: Record<string, unknown> | null | undefined): string {
  if (!input) return ''
  if (isShellTool(toolName)) return typeof input.command === 'string' ? input.command : ''
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.notebook_path === 'string') return input.notebook_path
  if (typeof input.path === 'string') return input.path
  return ''
}

/** Shell separators the CLI checks each side of on its own. */
export function shellSegments(command: string): string[] {
  return command.split(/&&|\|\||;|\|/).map(p => p.trim()).filter(Boolean)
}

/**
 * A shell chain is several commands, and the CLI judges each one. Confirmed the hard way:
 * `cd "C:/code/..." && git push origin --delete <branch>` was refused by a rule written for
 * the push alone, which only happens if the parts are checked separately. So every
 * segment is a candidate subject, alongside the whole line.
 */
export function ruleSubjects(toolName: string, input: Record<string, unknown> | null | undefined): string[] {
  const full = ruleSubject(toolName, input)
  if (!full) return ['']
  const parts = full.split(/&&|\|\||;/).map(p => p.trim()).filter(Boolean)
  return parts.length > 1 ? [full, ...parts] : [full]
}

/** `*` is the only wildcard in the CLI's rule syntax. Everything else is a literal. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 's')
}

/**
 * One rule against one call. `Tool` on its own covers every call to that tool, `Tool(spec:*)` is a
 * prefix, and `Tool(spec)` is a glob over the whole subject.
 *
 * A reimplementation of the CLI's matcher, not the CLI's matcher, so callers hedge: it decides
 * what a card SAYS and which temporary rule to clear, never whether a call is allowed.
 */
export function ruleMatches(rule: string, toolName: string, candidates: string[]): boolean {
  const parsed = parseRule(rule)
  if (!parsed || parsed.toolName !== toolName) return false
  if (parsed.content === null) return true
  const spec = parsed.content
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2)
    return candidates.some(c => c.startsWith(prefix))
  }
  const re = globToRegExp(spec)
  return candidates.some(c => re.test(c))
}

// === Auto mode ===

/** Programs whose blanket allow rule auto mode drops for Bash. */
const BASH_BLANKET_PROGRAMS: readonly string[] = [
  'python', 'python3', 'python2', 'node', 'deno', 'tsx', 'ruby', 'perl', 'php', 'lua',
  'npx', 'bunx', 'npm run', 'yarn run', 'pnpm run', 'bun run',
  'bash', 'sh', 'ssh', 'zsh', 'fish', 'eval', 'exec', 'env', 'xargs', 'sudo',
]

/**
 * PowerShell's list is the Bash one plus its own launchers. `PowerShell(node:*)` and
 * `PowerShell(bash:*)` were both measured as dropped, so the Bash programs are not optional here.
 * The `.exe` spellings of the launchers are included on the measured `cmd.exe` and `pwsh.exe`.
 */
const POWERSHELL_BLANKET_PROGRAMS: readonly string[] = [
  ...BASH_BLANKET_PROGRAMS,
  'pwsh', 'pwsh.exe', 'powershell', 'powershell.exe', 'cmd', 'cmd.exe', 'wsl', 'wsl.exe',
  'iex', 'invoke-expression', 'icm', 'invoke-command', 'start-process', 'saps', 'start',
  'start-job', 'sajb', 'start-threadjob',
]

/** `python -m http.server:*` survives; `python -m pytest:*` does not. The dot is the difference. */
const DOTTED_PYTHON_MODULE = /^-m\s+[a-z_]\w*(\.[a-z_]\w*)+(:\*|\s*\*)$/

function isBlanketRule(content: string | null, programs: readonly string[]): boolean {
  const c = (content ?? '').trim().toLowerCase()
  if (/^[\s*]*$/.test(c)) return true
  for (const p of programs) {
    if (c === p || c === `${p}:*` || c === `${p}*` || c === `${p} *`) return true
    if (c.startsWith(`${p} `) && c.endsWith('*')) {
      const rest = c.slice(p.length + 1).trimStart()
      const dottedModule = p.startsWith('python') && DOTTED_PYTHON_MODULE.test(rest)
      if (rest.startsWith('-') && !dottedModule) return true
    }
  }
  return false
}

/**
 * False when the CLI would drop this allow rule in auto mode, or cannot read it at all.
 *
 * Only ALLOW rules are dropped. Ask and deny rules for the same patterns are honoured, which is why
 * a one-time question (an ask rule) is still available when no "always" rule is.
 */
export function survivesAutoMode(rule: string): boolean {
  const parsed = parseRule(rule)
  if (!parsed) return false
  if (parsed.toolName === 'Agent') return false
  if (parsed.toolName === 'Bash') return !isBlanketRule(parsed.content, BASH_BLANKET_PROGRAMS)
  if (parsed.toolName === 'PowerShell') return !isBlanketRule(parsed.content, POWERSHELL_BLANKET_PROGRAMS)
  return true
}

// === Deriving a rule from a call ===

/** A word safe to put in a rule verbatim. Quotes, `$`, redirects and globs end the prefix. */
const SAFE_WORD = /^[A-Za-z0-9_./:@=+,%~\\-]+$/

function leadingWords(segment: string, max: number, stopAtFlag: boolean): string[] {
  const words: string[] = []
  for (const word of segment.split(/\s+/).filter(Boolean)) {
    if (words.length >= max) break
    if (stopAtFlag && word.startsWith('-')) break
    if (!SAFE_WORD.test(word)) break
    words.push(word)
  }
  return words
}

const CD_SEGMENT = /^(cd|set-location|sl|pushd)(\s|$)/i

export type AllowRulePlan =
  | { rules: string[]; blocked?: undefined }
  | { rules: null; blocked: 'unreadable' | 'too-broad' }

/**
 * The allow rules that would let this call through next time, narrowed until auto mode keeps them.
 *
 * Prefix per command segment: up to three words, stopping at the first flag, so
 * `npx wrangler r2 bucket create foo` becomes `Bash(npx wrangler r2:*)` and never `Bash(npx:*)`,
 * and `git push --force origin main` becomes `Bash(git push:*)` rather than one exact invocation
 * nobody repeats. `cd` segments are skipped: the chain that gets refused is almost always
 * `cd X && <the real command>`, and a rule for the `cd` grants nothing.
 *
 * Never widens. If the narrowest honest prefix is one auto mode drops (`node -e "..."` can only
 * give `Bash(node:*)`), the answer is `too-broad`, not a broader rule and not a narrower one that
 * would not cover the retry.
 *
 * `isCovered` lets the caller skip segments something already allows, so a chain like
 * `npm test | tail -20` asks only for what is missing.
 */
export function deriveAllowRules(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  isCovered?: (segment: string) => boolean,
): AllowRulePlan {
  if (!isShellTool(toolName)) {
    if (!/^[A-Za-z_][\w-]*$/.test(toolName)) return { rules: null, blocked: 'unreadable' }
    if (!survivesAutoMode(toolName)) return { rules: null, blocked: 'too-broad' }
    return isCovered?.(ruleSubject(toolName, input)) ? { rules: [] } : { rules: [toolName] }
  }
  const parts = shellSegments(ruleSubject(toolName, input)).filter(p => !CD_SEGMENT.test(p))
  if (parts.length === 0) return { rules: null, blocked: 'unreadable' }
  const rules: string[] = []
  for (const part of parts) {
    if (isCovered?.(part)) continue
    const words = leadingWords(part, 3, true)
    if (words.length === 0) return { rules: null, blocked: 'unreadable' }
    const rule = `${toolName}(${words.join(' ')}:*)`
    if (!survivesAutoMode(rule)) return { rules: null, blocked: 'too-broad' }
    if (!rules.includes(rule)) rules.push(rule)
  }
  return { rules }
}

/**
 * The one-time ASK rule for a call auto mode refused: what the refusal card's "Allow once" saves
 * so the retry stops on the banner instead of going back to the classifier.
 *
 * The exact command when it is one line. Measured against the real CLI 2.1.272: an ask rule holding the whole command matched with double quotes, nested
 * parentheses and an unbalanced `)` inside it, and a rule holding only the second half of
 * `cd . && <command>` still caught the chain. A command with a line break did NOT match its exact
 * rule, so a multi-line command gets a narrow prefix instead: the first line's leading words, flags
 * included, up to three, stopping at the first quote or shell symbol, so `node -e "a\nb"` becomes
 * `Bash(node -e:*)`.
 *
 * Other tools get their bare name: a path rule would need the CLI's own path syntax to be right,
 * and the rule is deleted after one question anyway.
 *
 * Ask rules are never dropped by auto mode, which is why `node -e`, which has no "always" rule at
 * all, still has a working "once".
 */
export function askOnceRuleFor(toolName: string, input: Record<string, unknown> | null | undefined): string | null {
  if (!isShellTool(toolName)) return /^[A-Za-z_][\w-]*$/.test(toolName) ? toolName : null
  const command = ruleSubject(toolName, input).trim()
  if (!command) return null
  if (!/[\r\n]/.test(command)) return `${toolName}(${command})`
  const first = shellSegments(command.split(/\r?\n/)[0]).find(p => !CD_SEGMENT.test(p))
  if (!first) return null
  const words = leadingWords(first, 3, false)
  return words.length > 0 ? `${toolName}(${words.join(' ')}:*)` : null
}

/** Allow rules named in a request's `permission_suggestions`, as rule strings. */
export function rulesFromSuggestions(suggestions: unknown): string[] {
  if (!Array.isArray(suggestions)) return []
  const out: string[] = []
  for (const s of suggestions) {
    if (!s || typeof s !== 'object') continue
    const update = s as PermissionUpdate
    if (update.type !== 'addRules' || update.behavior !== 'allow' || !Array.isArray(update.rules)) continue
    for (const r of update.rules) {
      if (!r || typeof r.toolName !== 'string') continue
      const rule = formatRule(r.toolName, typeof r.ruleContent === 'string' ? r.ruleContent : null)
      if (!out.includes(rule)) out.push(rule)
    }
  }
  return out
}

/** The `updatedPermissions` entry that adds allow rules, for one destination. */
export function addAllowRulesUpdate(rules: string[], destination = 'session'): PermissionUpdate {
  return {
    type: 'addRules',
    rules: rules
      .map(parseRule)
      .filter((p): p is ParsedRule => p !== null)
      .map(p => (p.content === null ? { toolName: p.toolName } : { toolName: p.toolName, ruleContent: p.content })),
    behavior: 'allow',
    destination,
  }
}

/**
 * Loose shape check for an `updatedPermissions` entry arriving over HTTP. The CLI logs and ignores
 * a malformed one rather than failing the turn, so this only keeps obvious junk off the pipe.
 */
export function isPermissionUpdate(value: unknown): value is PermissionUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const u = value as Record<string, unknown>
  if (typeof u.type !== 'string' || typeof u.destination !== 'string') return false
  if (u.rules !== undefined) {
    if (!Array.isArray(u.rules)) return false
    if (!u.rules.every(r => r && typeof r === 'object' && typeof (r as PermissionRuleValue).toolName === 'string')) return false
  }
  return true
}

// === Scopes ===

/**
 * Where an "Allow always" click saves its rule.
 *
 * Both surfaces used to save app-wide and only app-wide, which is the right
 * default and the wrong only option: a grant that made sense for one repo ("run this project's
 * deploy script") became a grant every chat on the machine carried, and there was no way to say so
 * at the moment of clicking. Three scopes, no more, because each already has a home in the data
 * model and three is the most a person will read off a button row:
 *
 *  - 'chat'    the chat's own `instances.permission_rules` allow list.
 *  - 'project' the folder's `folders.permission_rules` allow list, inherited down the folder tree.
 *  - 'app'     the app-wide `permissionAllowRules` setting.
 *
 * All three are unioned at spawn (hook-injector `cliSettingsArgs`), so a wider scope never cancels a
 * narrower one and there is no precedence to explain. A deny still beats all of them, from any side.
 */
export type PermissionScope = 'chat' | 'project' | 'app'

export const PERMISSION_SCOPES: readonly PermissionScope[] = ['chat', 'project', 'app']

/** The words on the picker. Short enough to sit in a button row without wrapping it. */
export const PERMISSION_SCOPE_LABELS: Record<PermissionScope, string> = {
  chat: 'this chat',
  project: 'this project',
  app: 'all chats',
}

/**
 * The scope's own clause, used in the button tooltip and again in the receipt after the click.
 * Both have to name the rule AND the scope: "Allowed" on its own leaves the operator guessing
 * which of three places just changed, which is the exact ambiguity the picker exists to remove.
 */
export const PERMISSION_SCOPE_BLURBS: Record<PermissionScope, string> = {
  chat: 'in this chat only',
  project: 'in every chat in this project, including its sub-folders',
  app: 'in every chat',
}

export function isPermissionScope(value: unknown): value is PermissionScope {
  return value === 'chat' || value === 'project' || value === 'app'
}

/**
 * Folder paths compared the way the sidebar nests them: separators normalised, case folded, no
 * trailing slash. Windows paths arrive spelled both ways (`C:\code\x` from the folder picker,
 * `C:/code/x` from a pasted path), and a chain lookup that missed on a backslash would silently
 * hand a sub-folder none of its parent's rules.
 */
export function normalizeFolderPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}

/** True when `parent` is `child` or one of its ancestors, by path. Mirrors buildFolderTree. */
export function isAncestorPath(parent: string, child: string): boolean {
  const a = normalizeFolderPath(parent)
  const b = normalizeFolderPath(child)
  return a === b || b.startsWith(a + '/')
}
