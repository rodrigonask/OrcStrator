import { useContext, useRef, useSyncExternalStore, type Context } from 'react'

/**
 * A tiny external store for a state slice that changes often.
 *
 * A React context whose value changes re-renders EVERY consumer. With several agents streaming
 * that meant every Grid tile re-rendered on every chunk of every chat. Instead the provider hands
 * out this store, whose identity never changes, and components subscribe through a selector: they
 * re-render only when their own selection changes. The reducers keep untouched entries by
 * reference (`{ ...state.messages, [id]: next }`, `instances.map(i => i.id === id ? {...} : i)`),
 * so a selector that reads one chat's entry returns the same reference for every other chat.
 */
export interface Store<S> {
  getState: () => S
  subscribe: (listener: () => void) => () => void
  /** Called by the provider after each committed change of the slice. */
  publish: (next: S) => void
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    publish: (next) => {
      if (next === state) return
      state = next
      for (const l of [...listeners]) l()
    },
  }
}

/**
 * Subscribe to a selection of a store held in `ctx`. Re-renders only when `equal(prev, next)` is
 * false; the default compares by reference, which suits per-chat entries. Pass `shallowEqual`
 * for a selector that builds a small array or object.
 */
export function useStoreSelector<S, T>(ctx: Context<Store<S>>, selector: (s: S) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const store = useContext(ctx)
  const cache = useRef<{ state: S; selector: (s: S) => T; value: T } | null>(null)
  const getSnapshot = (): T => {
    const s = store.getState()
    const c = cache.current
    if (c && c.state === s && c.selector === selector) return c.value
    const value = selector(s)
    if (c && equal(c.value, value)) {
      cache.current = { state: s, selector, value: c.value }
      return c.value
    }
    cache.current = { state: s, selector, value }
    return value
  }
  return useSyncExternalStore(store.subscribe, getSnapshot)
}

/** The whole state: re-renders on every change. Only for components that exist once. */
export function useStoreState<S>(ctx: Context<Store<S>>): S {
  const store = useContext(ctx)
  return useSyncExternalStore(store.subscribe, store.getState)
}

/** Shallow equality for arrays and plain objects: same keys, same values by reference. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const ka = Object.keys(a as object), kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}
