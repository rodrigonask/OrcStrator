/**
 * How many messages a chat keeps in memory while it only grows at the bottom.
 *
 * The cap exists so a long-running chat does not grow the tab's memory forever. It must not undo
 * something the user did on purpose: a list LONGER than the cap is one the user paged
 * back through with "Load older", and trimming it back to 200 the moment a new message arrived
 * made the history they were reading vanish mid-read, and the "Load older" button with it.
 */
export const MESSAGE_CAP = 200

/**
 * Append one message, capping the list unless the user has paged back through it. Returns the new
 * list and whether older messages were dropped, so the caller can keep "Load older" available.
 *
 * `pagedBack` is an explicit flag set when "Load older" ran. Inferring it from the
 * length ("longer than the cap means paged back") was wrong the other way: a reconnect refetch
 * merged over a full list left it at 230, and it then never trimmed again.
 */
export function appendCapped<T>(existing: readonly T[], message: T, pagedBack = false, cap = MESSAGE_CAP): { list: T[]; trimmed: boolean } {
  const updated = [...existing, message]
  if (pagedBack || updated.length <= cap) return { list: updated, trimmed: false }
  return { list: updated.slice(-cap), trimmed: true }
}

/**
 * A refetch of the newest page, laid over what is already loaded (second path).
 *
 * When a turn ends, and after a reconnect, the chat refetches its newest 150 messages. Replacing
 * the list with that page threw away everything older the user had paged back to, the same
 * "history vanishes mid-read" the cap above caused, one step later. When the fetched page
 * overlaps what is loaded (its oldest message is one we already have), the older messages are
 * kept in front of it and the paging state is left as the user left it. No overlap means the
 * server's history moved on (cleared, renewed), and the fetched page replaces the list as before.
 */
export function mergeNewestPage<T extends { id?: string }>(
  existing: readonly T[],
  fetched: readonly T[],
  fetchedHasMore: boolean,
  existingHasMore: boolean | undefined,
): { list: T[]; hasMore: boolean; replaced: boolean } {
  if (fetched.length === 0 || existing.length === 0) return { list: [...fetched], hasMore: fetchedHasMore, replaced: true }
  const firstId = fetched[0].id
  const at = firstId ? existing.findIndex(m => m.id === firstId) : -1
  if (at === 0) return { list: [...fetched], hasMore: fetchedHasMore, replaced: false }
  if (at < 0) return { list: [...fetched], hasMore: fetchedHasMore, replaced: true }
  return { list: [...existing.slice(0, at), ...fetched], hasMore: existingHasMore ?? fetchedHasMore, replaced: false }
}
