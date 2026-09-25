// Transient "flash this tile" signal. Fired when the user clicks a chat in the
// sidebar that's already open in the grid, so its tile pulses and they can spot
// it. Decoupled from React state so it doesn't churn UIContext on every click.
//
// Two kinds, because they answer two different questions:
//   'locate'    "where is the tile I just clicked?"  Short accent ring, 0.6s.
//   'scheduled' "a scheduled run just showed up."    Longer bright-yellow glow, ~1s,
//               driven by systems/surface-queue.ts, which decides WHEN it can play.
//
// This bus is fire-and-forget on purpose: if no tile for that id is mounted (the grid
// is unmounted while another view is on screen) the signal is simply dropped. Anything
// that must NOT be dropped goes through the surface queue, never straight through here.

export type TileFlashKind = 'locate' | 'scheduled'

type Listener = (id: string, kind: TileFlashKind) => void

const listeners = new Set<Listener>()

export function flashTile(id: string, kind: TileFlashKind = 'locate'): void {
  for (const fn of listeners) {
    try { fn(id, kind) } catch { /* swallow */ }
  }
}

export function onTileFlash(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
