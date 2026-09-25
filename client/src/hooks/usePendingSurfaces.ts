import { useSyncExternalStore } from 'react'
import { pendingSurfaceCount, subscribeSurfaces } from '../systems/surface-queue'

/**
 * How many scheduled runs have surfaced and are still owed their glow, meaning the user
 * has not been on the grid, in front, since they fired. Drives the dot on the Grid nav button
 * so a fire that landed while the user was on the pipeline board is not a secret.
 */
export function usePendingSurfaces(): number {
  return useSyncExternalStore(subscribeSurfaces, pendingSurfaceCount, () => 0)
}
