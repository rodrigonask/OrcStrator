import { createContext, useContext } from 'react'
import type { FolderConfig, InstanceConfig } from '@shared/types'

export interface InstancesContextValue {
  folders: FolderConfig[]
  instances: InstanceConfig[]
}

export const InstancesContext = createContext<InstancesContextValue>({ folders: [], instances: [] })

export function useInstances(): InstancesContextValue {
  return useContext(InstancesContext)
}
