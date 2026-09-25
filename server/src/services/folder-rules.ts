// Project-scope permission rules: the folder's own allow list, plus every folder above it.
//
// WHY THIS EXISTS. "Allow always" saved app-wide and nothing else, so a grant that only
// ever made sense for one repo ("run this project's build script", "edit under this checkout")
// became a grant every chat on the machine carried. The operator's real intent sat between the two
// scopes that existed: wider than one chat, narrower than the whole app. That is a project.
//
// INHERITANCE IS BY PATH, NOT BY A PARENT COLUMN. The `folders` table has no parent_id and never
// has: the sidebar derives its two levels of nesting from the paths themselves (buildFolderTree in
// client/src/components/Sidebar.tsx, which walks the registered folders and hangs each one off the
// deepest registered folder its path starts with). Resolving the chain the same way here is what
// makes the grant match the picture: if `C:\code\clients\acme` is drawn INSIDE
// `C:\code\clients`, then a chat in acme carries what clients grants. Introducing a parent_id
// for this would have created a second, silently different idea of what "inside" means.
//
// The chain is walked ROOT FIRST, so a settings file reads outermost grant to innermost, which is
// the order a person would write them in. It changes nothing functionally: every list is unioned,
// and a deny beats an allow wherever either came from.
import { db } from '../db.js'
import { dedupeRules, isAncestorPath, normalizeFolderPath } from '@orcstrator/shared'
import type { PermissionRuleSet } from '@orcstrator/shared'
import { normalisePermissionRules, parsePermissionRules } from './permission-rule-sets.js'
import { broadcastEvent } from '../ws/handler.js'

export interface FolderRuleSource {
  folderId: string
  /** What the sidebar calls it, for the read-only list in the Permissions modal. */
  folderName: string
  folderPath: string
  rules: PermissionRuleSet
}

interface FolderRow {
  id: string
  name: string | null
  display_name: string | null
  path: string | null
  permission_rules: string | null
}

function folderRow(folderId: string): FolderRow | undefined {
  return db
    .prepare('SELECT id, name, display_name, path, permission_rules FROM folders WHERE id = ?')
    .get(folderId) as FolderRow | undefined
}

function label(row: FolderRow): string {
  return (row.display_name || row.name || row.path || row.id).trim()
}

/**
 * This folder and every registered folder ABOVE it by path, outermost first.
 *
 * Folders with no rules of their own are left out: the caller either unions the lists (where an
 * empty one adds nothing) or lists them on screen (where an empty one is noise). A folder whose
 * `path` is blank, which the DB allows, can be neither an ancestor nor a descendant of anything,
 * so it only ever matches itself.
 */
export function folderRuleChain(folderId: string | null | undefined): FolderRuleSource[] {
  if (!folderId) return []
  try {
    const self = folderRow(folderId)
    if (!self) return []
    const selfPath = (self.path ?? '').trim()

    const rows = db
      .prepare('SELECT id, name, display_name, path, permission_rules FROM folders WHERE permission_rules IS NOT NULL')
      .all() as FolderRow[]

    const chain: FolderRuleSource[] = []
    for (const row of rows) {
      const rowPath = (row.path ?? '').trim()
      const applies = row.id === folderId || (!!rowPath && !!selfPath && isAncestorPath(rowPath, selfPath))
      if (!applies) continue
      const rules = parsePermissionRules(row.permission_rules)
      if (!rules) continue
      chain.push({ folderId: row.id, folderName: label(row), folderPath: rowPath, rules })
    }

    // Shortest normalised path first: the outermost project, then each one nested inside it.
    chain.sort((a, b) => normalizeFolderPath(a.folderPath).length - normalizeFolderPath(b.folderPath).length)
    return chain
  } catch (err) {
    // A chat must still spawn when this table read fails. Losing a project grant costs one
    // permission prompt; throwing here would cost the turn.
    console.warn('[folder-rules] could not resolve the project chain:', (err as Error).message)
    return []
  }
}

/** The chain for the folder a CHAT lives in, which is the only way the spawn path asks for it. */
export function folderRuleChainForInstance(instanceId: string): FolderRuleSource[] {
  try {
    const row = db.prepare('SELECT folder_id AS v FROM instances WHERE id = ?').get(instanceId) as
      | { v: string | null }
      | undefined
    return folderRuleChain(row?.v)
  } catch {
    return []
  }
}

/** Every bucket in the chain, unioned and de-duplicated, ready to merge with the other scopes. */
export function mergedFolderRules(chain: FolderRuleSource[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const source of chain) {
    for (const [key, value] of Object.entries(source.rules)) {
      if (!Array.isArray(value)) continue
      out[key] = dedupeRules([...(out[key] ?? []), ...value])
    }
  }
  for (const key of Object.keys(out)) {
    if (out[key].length === 0) delete out[key]
  }
  return out
}

/** One folder's own rules, with nothing inherited. What the PATCH route reads and writes. */
export function readFolderRules(folderId: string): PermissionRuleSet | undefined {
  const row = folderRow(folderId)
  return row ? parsePermissionRules(row.permission_rules) : undefined
}

/**
 * Store a folder's rules and tell every open tab.
 *
 * Normalised rather than stored as sent, same as the per-chat column: the spawn path reads this at
 * process start, where a malformed value costs the whole project its rules silently, and the CLI
 * drops an entire settings block that fails to parse. An all-empty set stores NULL, so "no project
 * rules" has one representation instead of three.
 */
export function writeFolderRules(folderId: string, rules: PermissionRuleSet): PermissionRuleSet | undefined {
  const stored = normalisePermissionRules(rules)
  db.prepare('UPDATE folders SET permission_rules = ? WHERE id = ?').run(stored, folderId)
  const next = parsePermissionRules(stored)
  // folder:updated copies only the fields present, so id plus the rules is a complete update.
  // null rather than undefined when nothing is left: JSON.stringify drops an undefined key and
  // every other tab would go on showing a rule that has just been removed.
  broadcastEvent({ type: 'folder:updated', payload: { id: folderId, permissionRules: next ?? null } })
  return next
}
