import { cwdToSlug } from './session-sanitizer.js'

/**
 * A readable label for a session slug with no project behind it (a removed worktree, a
 * folder never added). The configured root folder is dropped from the front, so only the
 * part under it shows, and a worktree suffix is split out.
 *
 * Only the prefix is stripped. The slug replaces every non-alphanumeric char with '-', so a
 * dash could be a separator OR part of a real name (orcstrator-v2), and decoding further
 * would just invent paths that never existed.
 *
 * rootFolder is the raw setting value. Empty means nothing is trimmed. If trimming would
 * leave nothing (the slug IS the root), the full slug is used instead.
 */
export function prettySlug(slug: string, rootFolder: string): string {
  const root = rootFolder.trim().replace(/[\\/]+$/, '')
  let trimmed = slug
  if (root) {
    const prefix = cwdToSlug(root).toLowerCase()
    if (slug.toLowerCase().startsWith(prefix)) {
      trimmed = slug.slice(prefix.length)
      if (trimmed.startsWith('-')) trimmed = trimmed.slice(1)
    }
  }
  if (!trimmed) trimmed = slug
  const [base, worktree] = trimmed.split('--claude-worktrees-')
  return worktree ? `${base} (worktree: ${worktree})` : base
}
