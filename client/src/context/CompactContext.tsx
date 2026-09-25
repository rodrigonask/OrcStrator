import { createContext, useContext } from 'react'

/**
 * True when the chat components (MessageList / MessageInput / MessageBubble)
 * are rendered inside a dense grid tile. Provided by GridTile; defaults to
 * false so the full chat view is unaffected.
 */
export const CompactContext = createContext(false)

export function useCompact(): boolean {
  return useContext(CompactContext)
}
