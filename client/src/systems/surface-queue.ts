// The deferred surface queue.
//
// A scheduled fire (a card carrying a schedule, or a wake-up) SURFACES its chat: the
// chat becomes a grid tile and owes the user exactly one glow. The tile part is done
// elsewhere, ungated, the moment the client learns about the surface. THIS module owns
// the glow, and the glow has one rule: it plays when the user can actually see it, and not
// before.
//
// "Can actually see it" means ALL of:
//   - the browser tab is visible          (document.visibilityState === 'visible')
//   - the window is in the foreground     (document.hasFocus())
//   - the Grid is the view on screen      (gate.view === 'grid', settings closed)
//   - the tile for that chat is mounted   (GridView unmounts entirely off the grid view)
//   - no OTHER tile is maximized over it  (gate.maximizedId is null or is this tile)
//
// Until every one of those holds, the surface WAITS here. It does not fire into an
// unmounted GridView and vanish, which is exactly what the plain flashTile() bus would
// do, and exactly the bug this file exists to prevent. The drain re-runs on every
// event that can flip one of those conditions.
//
// Each surface plays ONCE. The dedup key is `${instanceId}:${surfacedAt}`, held in
// localStorage: a page reload must not replay a glow already seen, but a NEW fire on the
// same chat (new surfacedAt) must glow again. Keying on the id alone breaks one of the
// two, and the pair is the only key that satisfies both.
//
// Not React state on purpose: the grid, the top bar and the app context all touch this
// and none of them should re-render each other for it. A tiny subscribe() exists for the
// one thing that wants to render the pending count (the Grid nav badge).

import { flashTile } from './tile-flash'

export interface SurfaceGate {
  view: string
  showSettings: boolean
  maximizedId: string | null
}

const STORAGE_KEY = 'orcstrator.flashedSurfaces'
const MAX_REMEMBERED = 200

/** Surfaces owed a glow, by instance id. A newer fire on the same chat replaces the older. */
const pending = new Map<string, number>()
/** Tile ids currently mounted in the grid. */
const mounted = new Set<string>()
let gate: SurfaceGate = { view: 'grid', showSettings: false, maximizedId: null }
const subscribers = new Set<() => void>()

function loadFlashed(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

let flashed: string[] = loadFlashed()

function keyOf(instanceId: string, surfacedAt: number): string {
  return `${instanceId}:${surfacedAt}`
}

export function hasFlashed(instanceId: string, surfacedAt: number): boolean {
  return flashed.includes(keyOf(instanceId, surfacedAt))
}

function rememberFlashed(key: string): void {
  flashed = [...flashed.filter(k => k !== key), key].slice(-MAX_REMEMBERED)
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(flashed)) } catch { /* quota, ignore */ }
}

function notify(): void {
  for (const fn of subscribers) {
    try { fn() } catch { /* swallow */ }
  }
}

function windowCanShow(): boolean {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'visible' && document.hasFocus()
}

function gridOnScreen(): boolean {
  return gate.view === 'grid' && !gate.showSettings
}

/**
 * Play every glow that can be seen right now. Safe to call as often as you like; a
 * surface that cannot play yet simply stays queued.
 */
export function drainSurfaces(): void {
  if (pending.size === 0) return
  if (!windowCanShow() || !gridOnScreen()) return
  // Re-read the remembered list at drain time, not only at load: with two tabs open the
  // other tab may have played this exact surface a moment ago, and the key it wrote is
  // the only thing that stops this tab playing it a second time.
  flashed = loadFlashed()
  let changed = false
  for (const [instanceId, surfacedAt] of Array.from(pending.entries())) {
    if (!mounted.has(instanceId)) continue
    if (gate.maximizedId && gate.maximizedId !== instanceId) continue
    pending.delete(instanceId)
    changed = true
    if (hasFlashed(instanceId, surfacedAt)) continue
    rememberFlashed(keyOf(instanceId, surfacedAt))
    flashTile(instanceId, 'scheduled')
  }
  if (changed) notify()
}

/** A chat surfaced at `surfacedAt`. Owes one glow unless that exact surface already played. */
export function enqueueSurface(instanceId: string, surfacedAt: number): void {
  if (hasFlashed(instanceId, surfacedAt)) return
  if (pending.get(instanceId) === surfacedAt) return
  pending.set(instanceId, surfacedAt)
  notify()
  drainSurfaces()
}

/** The surface was cleared (acked) before it ever played: nothing is owed any more. */
export function dropSurface(instanceId: string): void {
  if (pending.delete(instanceId)) notify()
}

export function setSurfaceGate(next: SurfaceGate): void {
  gate = next
  drainSurfaces()
}

export function tileMounted(instanceId: string): void {
  mounted.add(instanceId)
  drainSurfaces()
}

export function tileUnmounted(instanceId: string): void {
  mounted.delete(instanceId)
}

/** How many surfaces are still owed a glow. Drives the Grid nav badge. */
export function pendingSurfaceCount(): number {
  return pending.size
}

/** The chats still owed a glow. */
export function pendingSurfaceIds(): string[] {
  return Array.from(pending.keys())
}

export function subscribeSurfaces(fn: () => void): () => void {
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}

// The two events that flip "can the user see it": the tab becoming visible, and the window
// taking focus. Module-level, once per page load, like the reconnect hooks in api/ws.ts.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { drainSurfaces() })
  window.addEventListener('focus', () => { drainSurfaces() })
}
