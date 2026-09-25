import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { DATA_DIR } from '../config.js'
import { expandBundles, dedupeRules, DESTRUCTIVE_FENCE, DEPLOY_FENCE } from '@orcstrator/shared'
import { db } from '../db.js'
import { folderRuleChainForInstance, mergedFolderRules } from './folder-rules.js'

// Managed `--settings` wiring: the context-compaction hook, and the Claude CLI settings
// OrcStrator exposes in its own Settings page (output style, response language, permission
// rules) instead of making you type /config or /permissions inside a chat.
//
// We spawn the native `claude` CLI and sit OUTSIDE its tool loop, so the only supported way to
// shrink what the model sees is a PostToolUse hook (claude >= 2.1.119). This module materialises
// a managed settings file that registers `hooks/compact-tool-output.mjs`, and hands the spawn
// path the `--settings <file>` args. It is layered as a command-line settings source, so its
// hooks MERGE with the user's own (~/.claude, project .claude) rather than replacing them.
//
// Everything here is gated behind the `contextCompactionHook` setting (default ON, opt-out) so
// the choice stays reversible — flipping it can't silently change a running session.

// Resolve the standalone hook script across dev (tsx from src/) and prod (compiled dist/) layouts.
const here = dirname(fileURLToPath(import.meta.url))
const HOOK_CANDIDATES = [
  join(here, '..', '..', 'hooks', 'compact-tool-output.mjs'), // src/services|dist/services -> server/hooks
  join(here, '..', 'hooks', 'compact-tool-output.mjs'),
  join(process.cwd(), 'hooks', 'compact-tool-output.mjs'),
  join(process.cwd(), 'server', 'hooks', 'compact-tool-output.mjs'),
]
const HOOK_PATH: string | null = HOOK_CANDIDATES.find((p) => existsSync(p)) ?? null

/** Where the per-instance managed settings files live. */
const SETTINGS_DIR = join(DATA_DIR, 'cli-settings')

/** Compaction hook block, or null when the hook is off or its script is missing. */
function compactionHookBlock(): Record<string, unknown> | null {
  if (!compactionEnabled()) return null
  if (!HOOK_PATH) {
    console.warn('[compaction] hook script not found in any known location, compaction hook unavailable')
    return null
  }
  // Quote both paths: process.execPath ("...Program Files...") and the script path may contain spaces.
  const command = `"${process.execPath}" "${HOOK_PATH}"`
  return {
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 30 }] }],
  }
}

/** Read one app setting as a trimmed string, or '' when unset/blank/unreadable. */
export function readStringSetting(key: string): string {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return ''
    const parsed = JSON.parse(row.value)
    return typeof parsed === 'string' ? parsed.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Read one app setting as an array of non-blank strings. `[]` when unset, unreadable, or
 * stored as something other than an array of strings, because a malformed rule list must
 * degrade to "no rules of my own" rather than poison the whole settings file: the CLI
 * validates `autoMode` as a unit and silently skips the source when it fails to parse.
 */
function readStringArraySetting(key: string): string[] {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return []
    const parsed = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return []
    return dedupeRules(parsed)
  } catch {
    return []
  }
}

/** Read one app setting as a boolean. Unset, blank or unreadable falls back to `fallback`. */
function readBoolSetting(key: string, fallback: boolean): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return fallback
    const parsed = JSON.parse(row.value)
    return typeof parsed === 'boolean' ? parsed : fallback
  } catch {
    return fallback
  }
}

/**
 * The chat's own permission rules, or null. Read from the instance row rather than a
 * setting because they belong to one session, and unioned with the app-wide lists rather
 * than replacing them: a per-chat entry is a grant for that chat, not a different policy.
 *
 * `bundles` rides through the same string[] filter as the rule lists, which is correct: it is
 * a list of ids and an unknown id is dropped by expandBundles rather than breaking the spawn.
 *
 * De-duplicated on READ, and the stored row is left alone. A chat's column could hold
 * `"allow":["Bash(node build.cjs:*)","Edit","Edit","Edit","Edit"]`, one copy per
 * click of the same grant. The writers de-duplicate now too, but rows written before that still
 * exist, and rewriting them is a migration nobody asked for.
 */
function instancePermissionRules(instanceId: string): Record<string, string[]> {
  try {
    const row = db.prepare('SELECT permission_rules AS v FROM instances WHERE id = ?').get(instanceId) as
      | { v: string | null }
      | undefined
    if (!row?.v) return {}
    const parsed = JSON.parse(row.v)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue
      const list = dedupeRules(value)
      if (list.length > 0) out[key] = list
    }
    return out
  } catch {
    return {}
  }
}

/** Union that keeps order and drops duplicates, so a rule set twice over is still one rule. */
function unionRules(appWide: string[], perChat: string[] | undefined): string[] {
  return dedupeRules([...appWide, ...(perChat ?? [])])
}

/** Per-chat override for one of the CLI settings, or '' when the chat inherits. */
function instanceOverride(instanceId: string, column: 'output_style' | 'language'): string {
  try {
    const row = db.prepare(`SELECT ${column} AS v FROM instances WHERE id = ?`).get(instanceId) as
      | { v: string | null }
      | undefined
    return (row?.v ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * Resolve the Claude CLI settings this spawn should run under: the compaction hook, whatever
 * the user set in Settings -> Claude Behaviour (with the chat's own override winning over the
 * app-wide value), and the permission rules from Settings -> Permission Rules.
 *
 * Everything has to go in ONE file. `--settings` is not repeatable: passing it twice makes
 * the last one win and silently drops the first (verified against CLI 2.1.238), so a second
 * managed file would quietly disable the compaction hook.
 */
export function cliSettingsArgs(instanceId: string): string[] {
  try {
    const settings: Record<string, unknown> = {}

    const hooks = compactionHookBlock()
    if (hooks) settings.hooks = hooks

    // 'Default' is the CLI's own prompt, expressed by sending no key at all.
    const outputStyle = instanceOverride(instanceId, 'output_style') || readStringSetting('outputStyle')
    if (outputStyle && outputStyle !== 'Default') settings.outputStyle = outputStyle

    const language = instanceOverride(instanceId, 'language') || readStringSetting('language')
    if (language) settings.language = language

    // Permission rules. Two separate mechanisms, deliberately kept apart in the UI too:
    //
    //  - `permissions.allow/deny/ask` are deterministic pattern rules, matched BEFORE the
    //    auto-mode classifier is consulted, so a matching call never reaches it at all. These
    //    demonstrably work through this file: with `Bash(git push:*)` allowed, a push that auto
    //    mode otherwise answered with "This command requires approval" ran and moved the remote
    //    They are globs, not plain prefixes, so a deny can catch `--force` at the
    //    end of a line. Precedence, measured against CLI 2.1.263: deny beats ask,
    //    ask beats allow, and an ask raises the blocking can_use_tool request even under Auto
    //    mode. `ask` is the only one of the three that gates a call WITHOUT the agent ever
    //    being handed a refusal it can narrate a workaround for.
    //  - `autoMode.*` are plain-English rules for the classifier itself. The CLI only trusts
    //    these from userSettings, flagSettings and policySettings, and explicitly IGNORES an
    //    `autoMode` block from a repo's .claude/settings.json (a repo is attacker-controllable).
    //    This managed file is the flagSettings source, so they reach the CLI. Whether they change
    //    anything is another matter: in the same session none of allow, hard_deny or an
    //    environment block moved a verdict. They ship because the CLI reads them and the Settings
    //    page exposes them, but nothing here should depend on them.
    //
    // Either way this is additive: the CLI keeps permission rules per source and unions them, so
    // nothing set in ~/.claude or the repo is dropped by our writing a block of our own.
    // Per-chat rules ADD to the app-wide ones. Denies are evaluated before allows by the
    // CLI regardless of which side they came from, so a chat can grant itself something the
    // app does not have, and still cannot escape an app-wide deny.
    const chatRules = instancePermissionRules(instanceId)

    // PROJECT rules: the middle scope behind "Allow always". The chat's folder and
    // every folder above it by path, unioned (services/folder-rules.ts). A third additive source,
    // sitting between app-wide and per-chat in breadth and behaving exactly like the other two:
    // it can grant this project something the app does not have, and it can no more escape an
    // app-wide deny than a per-chat grant can.
    //
    // The client mirrors this union in `effectiveRules` (client/src/utils/permissionMatch.ts). The
    // two have to agree or the refusal card names the wrong cause, e.g. a `node -e` call
    // explained as allowed by a rule the running CLI had already thrown away.
    const projectRules = mergedFolderRules(folderRuleChainForInstance(instanceId))

    // Bundles are stored as ids and expanded HERE rather than copied into the rule lists when
    // the toggle is clicked. That way a bundle whose contents improve in a later version
    // applies to everyone on the next turn, and the Settings page keeps showing six readable
    // toggles instead of two hundred glob patterns nobody asked to see.
    //
    // A project can carry bundles too. Nothing writes them today (the scope picker saves allow
    // patterns and only allow patterns), but the column takes the same shape as the other two and
    // leaving the union incomplete here is how the per-chat deploy toggle silently did nothing for
    // a week: the fence below is computed from this list, so a source missing from it gets fenced
    // out of the very thing it was granting.
    const activeBundles = [
      ...readStringArraySetting('permissionBundles'),
      ...(projectRules.bundles ?? []),
      ...(chatRules.bundles ?? []),
    ]
    const bundleAllow = expandBundles(activeBundles)

    const allow = unionRules(
      unionRules(
        unionRules(bundleAllow, readStringArraySetting('permissionAllowRules')),
        projectRules.allow,
      ),
      chatRules.allow,
    )

    // The destructive fence defaults ON: an absent setting counts as enabled, so only an
    // explicit false removes it. That is what separates "allow everything except destructive"
    // from "allow everything", and it is the whole reason both buttons can be honest.
    const fence = readBoolSetting('blockDestructive', true) ? DESTRUCTIVE_FENCE : []

    // Plug the deploy hole in the "run scripts" grant, but only once some grant is actually on:
    // with no bundles configured at all, OrcStrator adds nothing and the CLI's own defaults
    // stand, so a fresh install does not silently start gating `npm run deploy`.
    //
    // Computed from the UNION of app-wide, project and per-chat bundles, so granting deploy to one
    // chat really does grant it. Doing this from the app-wide list alone would leave an app-wide
    // rule in that chat's file, and both ask and deny beat an allow, so the per-chat toggle
    // would have looked like it worked and done nothing.
    const deployFence = activeBundles.length > 0 && !activeBundles.includes('deploy')
      ? DEPLOY_FENCE
      : []
    const deny = unionRules(
      unionRules(
        unionRules([...fence], readStringArraySetting('permissionDenyRules')),
        projectRules.deny,
      ),
      chatRules.deny,
    )

    // The deploy fence is an ASK, not a deny (see DEPLOY_FENCE). A deny refuses the call, the
    // agent is told so mid-turn and routes around it, and the operator's grant then arrives too
    // late to matter. An ask holds the turn open on the can_use_tool control request, which is
    // the path PermissionBanner already answers, and Allow runs the original command unchanged.
    //
    // Ordered ask-first so a user's own ask rules cannot be shadowed by the fence and vice
    // versa, and filtered against `deny` because a deny for the same command BEATS an ask
    // (measured against CLI 2.1.263). Leaving an overlap in would silently turn a gate the
    // operator can click through back into the refusal this whole change removes.
    //
    // `askOnce` is the refusal card's "Allow once". Auto mode refused a call and
    // nothing is paused, so there is no request to approve. The card saves a one-time ask rule for
    // that call and sends the retry note: the retry then stops on the banner instead of going back
    // to the classifier, and one click runs it. The server deletes the rule the moment its banner
    // is answered (see pending-permissions.ts), so it asks once, not forever. It rides the same
    // deny filter as every other ask below.
    const askRaw = unionRules(
      unionRules(
        unionRules(
          unionRules([...deployFence], readStringArraySetting('permissionAskRules')),
          projectRules.ask,
        ),
        chatRules.ask,
      ),
      chatRules.askOnce,
    )
    const ask = askRaw.filter(rule => !deny.includes(rule))

    if (allow.length > 0 || deny.length > 0 || ask.length > 0) {
      settings.permissions = {
        ...(allow.length > 0 && { allow }),
        ...(deny.length > 0 && { deny }),
        ...(ask.length > 0 && { ask }),
      }
    }

    // Snake_case is the CLI's own spelling for these keys, not a slip.
    const autoAllow = unionRules(unionRules(readStringArraySetting('autoModeAllow'), projectRules.autoAllow), chatRules.autoAllow)
    const autoSoftDeny = unionRules(unionRules(readStringArraySetting('autoModeSoftDeny'), projectRules.autoSoftDeny), chatRules.autoSoftDeny)
    const autoHardDeny = unionRules(unionRules(readStringArraySetting('autoModeHardDeny'), projectRules.autoHardDeny), chatRules.autoHardDeny)
    if (autoAllow.length > 0 || autoSoftDeny.length > 0 || autoHardDeny.length > 0) {
      settings.autoMode = {
        ...(autoAllow.length > 0 && { allow: autoAllow }),
        ...(autoSoftDeny.length > 0 && { soft_deny: autoSoftDeny }),
        ...(autoHardDeny.length > 0 && { hard_deny: autoHardDeny }),
      }
    }

    if (Object.keys(settings).length === 0) return []

    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })
    // Per-instance file: two chats can run different output styles at the same time, and a
    // shared file would be whatever the last spawn wrote.
    const file = join(SETTINGS_DIR, `${instanceId}.settings.json`)
    writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8')
    return ['--settings', file]
  } catch (err) {
    console.warn('[cli-settings] failed to write managed settings file:', err)
    return []
  }
}

/**
 * True unless the `contextCompactionHook` setting is explicitly turned off. Default ON:
 * an absent setting counts as enabled, so the hook ships on for everyone; only a stored
 * `false` opts out. (A DB read error still fails to OFF — when we can't tell, don't inject.)
 */
export function compactionEnabled(): boolean {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'contextCompactionHook'").get() as
      | { value: string }
      | undefined
    return !row || JSON.parse(row.value) !== false
  } catch {
    return false
  }
}

/**
 * True unless `compactionLossless` is explicitly turned off. Default ON. Lossless mode keeps the
 * JSON-minify / ANSI / dup-collapse / image-strip transforms (none remove anything the model can
 * read) but skips the lossy head/tail elision. Only a stored `false` allows elision. Unsure -> ON.
 */
export function compactionLossless(): boolean {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'compactionLossless'").get() as
      | { value: string }
      | undefined
    return !row || JSON.parse(row.value) !== false
  } catch {
    return true
  }
}

/** Tier-1 subagent-offloading steer, appended to the system prompt only when compaction is on. */
export const SUBAGENT_OFFLOAD_NUDGE =
  'Context efficiency: when a step needs bulky exploration — reading many files, broad codebase ' +
  'searches, or anything returning large tool output you only need a conclusion from — delegate it ' +
  'to a subagent via the Task/Agent tool. The heavy context then stays in the subagent and only its ' +
  'distilled result returns to you, keeping your own context window lean. Do NOT delegate small or ' +
  "tightly-coupled steps — the subagent overhead isn't worth it there."
