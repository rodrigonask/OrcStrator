/**
 * The chats whose history must be refetched after the socket reconnects.
 *
 * Everything that happened while the socket was down (a laptop asleep, a server restart) only
 * exists on the server. The old handler refetched the SELECTED chat alone, so in Grid view an
 * answer that finished during the gap never reached its tile, and clicking the tile did not help
 * because a cached tile is not refetched on select: only a page reload showed it, and it looked
 * like the agent had done nothing. Every tile on screen is refetched now, selected one included,
 * each once.
 */
export function chatsToRefetchOnReconnect(selectedId: string | null | undefined, gridIds: readonly string[] | null | undefined): string[] {
  const out: string[] = []
  for (const id of [selectedId, ...(gridIds ?? [])]) {
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}
