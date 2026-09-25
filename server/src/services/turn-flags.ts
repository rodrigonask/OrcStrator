import { db } from '../db.js'
import { resolveModelId, DEFAULT_MODEL_ID, DEFAULT_EFFORT } from '@orcstrator/shared'

// ─────────────────────────────────────────────────────────────────────────────
// ONE flag builder, used by BOTH the manual card start and the scheduled fire.
//
// It exists because there used to be two, and they drifted:
//
//   - task-runner.startTask pushed globalFlags + defaultModel, and never --effort.
//     So the Settings page's "default effort" applied to typed chat messages only
//     and was silently ignored by every card start.
//   - routine-scheduler's fire path called sendMessage with NO flags at all.
//     sendMessage does not read globalFlags itself (it builds argv from the array it
//     is handed), so a scheduled run got no --model, no --effort, and critically no
//     --dangerously-skip-permissions. A 3am fire that tripped a permission prompt sat
//     blocked behind a banner nobody was awake to click.
//
// Anything that starts a turn from a card goes through here. Add a second builder and
// the same class of bug comes straight back.
// ─────────────────────────────────────────────────────────────────────────────

/** The subset of a task row this needs. Accepts the DB row shape, snake_case included. */
export interface TaskFlagSettings {
  model?: string | null
  effort?: string | null
  permission_mode?: string | null
  max_budget_usd?: number | null
  fallback_model?: string | null
}

function getSetting<T>(key: string, fallback: T): T {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : fallback
  } catch {
    return fallback
  }
}

/** 'bypassPermissions' is spelled as its own flag; everything else rides --permission-mode. */
function permissionFlag(mode: string): string {
  return mode === 'bypassPermissions' ? '--dangerously-skip-permissions' : `--permission-mode=${mode}`
}

function isPermissionFlag(flag: string): boolean {
  return flag.startsWith('--permission-mode') || flag === '--dangerously-skip-permissions'
}

/**
 * Compose the CLI flags for a turn started from a task.
 *
 * Order, and why:
 *   1. the app-wide globalFlags, as the base
 *   2. the card's OWN settings, which beat the base
 *   3. the app-wide defaultModel / defaultEffort, filling only what is still unset
 *
 * A null on the card means INHERIT, never "off". That is the whole point of step 3: a card
 * with everything unset follows the Settings page, today and after the default changes.
 * Freezing today's default onto the card at creation time would make Settings a lie.
 *
 * A card-level permission mode STRIPS the conflicting global ones rather than being appended
 * after them, exactly as POST /instances/:id/send does, because the CLI takes the first it
 * sees and an un-stripped global would win over the card's own pick.
 */
export function buildTurnFlags(task: TaskFlagSettings): string[] {
  let flags = [...getSetting<string[]>('globalFlags', [])]

  const permMode = task.permission_mode?.trim()
  if (permMode) {
    flags = flags.filter(f => !isPermissionFlag(f))
    flags.push(permissionFlag(permMode))
  }

  const model = task.model?.trim()
  if (model) {
    flags = flags.filter(f => !f.startsWith('--model'))
    flags.push(`--model=${resolveModelId(model)}`)
  }

  const effort = task.effort?.trim()
  if (effort) {
    flags = flags.filter(f => !f.startsWith('--effort'))
    flags.push(`--effort=${effort}`)
  }

  if (task.max_budget_usd != null && Number.isFinite(task.max_budget_usd) && task.max_budget_usd > 0) {
    flags = flags.filter(f => !f.startsWith('--max-budget-usd'))
    flags.push(`--max-budget-usd=${task.max_budget_usd}`)
  }

  const fallback = task.fallback_model?.trim()
  if (fallback) {
    flags = flags.filter(f => !f.startsWith('--fallback-model'))
    flags.push(`--fallback-model=${resolveModelId(fallback)}`)
  }

  // Global defaults fill the gaps, and only the gaps. An unset setting is not "no
  // model": it means the app default, so the flag is always written. Leaving it off
  // used to hand the CLI's own idea of a default to the run, which is how a turn
  // could quietly come back on a model nothing in OrcStrator had chosen.
  if (!flags.some(f => f.startsWith('--model'))) {
    const defaultModel = getSetting<string>('defaultModel', 'default')
    const model = defaultModel && defaultModel !== 'default' ? resolveModelId(defaultModel) : DEFAULT_MODEL_ID
    flags.push(`--model=${model}`)
  }
  if (!flags.some(f => f.startsWith('--effort'))) {
    flags.push(`--effort=${getSetting<string>('defaultEffort', '') || DEFAULT_EFFORT}`)
  }

  return flags
}

/**
 * Per-task output style and language do NOT ride argv: they live in the managed --settings
 * file, which cliSettingsArgs builds by reading the INSTANCE row. So the card stamps its
 * values onto whatever chat this run landed on, the same way surface_silent is stamped at
 * spawn.
 *
 * Only a value the card actually SETS is written. An unset one leaves the chat's own
 * override alone: null means inherit, and clearing here would let an ordinary card silently
 * wipe a per-chat output style the user picked by hand in the chat's own settings.
 */
export function applyTaskCliSettings(instanceId: string, task: { output_style?: string | null; language?: string | null }): void {
  try {
    const outputStyle = task.output_style?.trim()
    const language = task.language?.trim()
    if (outputStyle) db.prepare('UPDATE instances SET output_style = ? WHERE id = ?').run(outputStyle, instanceId)
    if (language) db.prepare('UPDATE instances SET language = ? WHERE id = ?').run(language, instanceId)
  } catch (err) {
    console.warn(`[turn-flags] could not apply per-task CLI settings to instance ${instanceId.slice(0, 8)}:`, err)
  }
}
