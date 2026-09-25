// Reading and writing a stored PermissionRuleSet, in one place.
//
// Lives here rather than in routes/instances.ts because folders carry the same
// JSON blob in the same shape (folders.permission_rules, migration049) and services/folder-rules.ts
// has to read it. A service importing a route to get at the parser would make a cycle, and
// a second parser drifts: one learns about `bundles` and the other does not, so a per-chat
// grant saves as nothing.

import { dedupeRules } from '@orcstrator/shared'
import type { PermissionRuleSet } from '@orcstrator/shared'

/**
 * The buckets a rule set may carry, in the order the UI shows them.
 *
 * `bundles` must be listed here, and it is the one the UI leads with. The spawn
 * side reads `chatRules.bundles` and expands it (hook-injector), the modal writes it, the
 * matcher explains it, and this list is what every one of them has to pass through: left out,
 * the field is dropped on save, so a per-chat grant persists as nothing. Clicking "Deploy to live
 * sites and servers" for one chat would do visibly nothing, forever, which is not a UI that looks
 * broken so much as one that looks ignored.
 */
export const RULE_KEYS = ['bundles', 'allow', 'deny', 'ask', 'askOnce', 'autoAllow', 'autoSoftDeny', 'autoHardDeny'] as const

/**
 * Keep only the known lists, only their string entries, and only non-blank ones, each once.
 * Returns null when nothing survives, so "no rules" is one representation in the DB
 * rather than a choice between NULL, `{}` and `{allow:[]}`.
 *
 * Bundle ids ride the same string filter as the patterns. An id that is not a real bundle is
 * harmless: `expandBundles` drops what it does not recognise rather than failing the spawn.
 *
 * De-duplicated, because otherwise every click of the same grant appends another copy (a row
 * can end up holding `Edit` four times over). Existing rows are left as they are; the spawn side reads
 * them de-duplicated.
 */
export function normalisePermissionRules(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const out: Record<string, string[]> = {}
  for (const key of RULE_KEYS) {
    const raw = (input as Record<string, unknown>)[key]
    if (!Array.isArray(raw)) continue
    const list = dedupeRules(raw)
    if (list.length > 0) out[key] = list
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null
}

/**
 * Stored JSON back to an object, or undefined. Never throws: a corrupt row reads as "none".
 *
 * Shared because routes/state.ts builds the same instance shape for the fresh-tab load, the
 * folders route builds it for projects, and the spawn path reads it again at process start.
 */
export function parsePermissionRules(value: unknown): PermissionRuleSet | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PermissionRuleSet)
      : undefined
  } catch {
    return undefined
  }
}
