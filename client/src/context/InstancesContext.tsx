import { createContext } from 'react'
import type { FolderConfig, InstanceConfig } from '@shared/types'
import { createStore, useStoreSelector, useStoreState, type Store } from './store'

export interface InstancesContextValue {
  folders: FolderConfig[]
  instances: InstanceConfig[]
}

/**
 * The context value is a store whose identity never changes (see ./store.ts). A running
 * chat updates its own instance row several times a second (turn progress, state), so anything
 * rendered per chat reads its own row through useInstance or useInstancesSelector.
 */
export type InstancesStore = Store<InstancesContextValue>

export function createInstancesStore(initial: InstancesContextValue = { folders: [], instances: [] }): InstancesStore {
  return createStore(initial)
}

export const InstancesContext = createContext<InstancesStore>(createInstancesStore())

export function useInstancesSelector<T>(selector: (s: InstancesContextValue) => T, equal?: (a: T, b: T) => boolean): T {
  return useStoreSelector(InstancesContext, selector, equal)
}

/** One chat's row. Re-renders only when that row changes. */
export function useInstance(id: string | null | undefined): InstanceConfig | undefined {
  return useInstancesSelector(s => (id ? s.instances.find(i => i.id === id) : undefined))
}

/** Every folder and instance: re-renders whenever any chat's row changes. Not for per-chat components. */
export function useInstances(): InstancesContextValue {
  return useStoreState(InstancesContext)
}
