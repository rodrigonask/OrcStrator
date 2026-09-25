// "The user just went to reply in this chat." Fired when a composer takes focus.
//
// The task panel listens: settling in to type is the moment a finished checklist stops
// being information and starts being furniture, so a panel whose work is all done folds
// itself away and gives the space back to the transcript. A panel with anything still
// running or queued stays put, because that is the thing worth glancing at while typing.
//
// Decoupled from React state on purpose, same as tile-flash: focus fires constantly and
// routing it through UIContext would re-render every tile in the grid for it.

type Listener = (instanceId: string) => void

const listeners = new Set<Listener>()

export function composerFocused(instanceId: string): void {
  for (const fn of listeners) {
    try { fn(instanceId) } catch { /* swallow */ }
  }
}

export function onComposerFocus(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
