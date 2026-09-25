import { useCallback } from 'react'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { flashTile } from '../systems/tile-flash'
import type { InstanceConfig } from '@shared/types'

/**
 * "Take me to this chat", from any of the active-session surfaces (top-bar chips, the
 * ultra-compact rail). In chat view that means selecting it; anywhere else it means
 * dropping it into the grid and going there. A chat that was already an open tile gets
 * the locate flash instead of silently doing nothing.
 *
 * Extracted from TopBar so the rail cannot drift from the chips it replaces.
 */
export function useOpenInstance(): (inst: InstanceConfig) => void {
  const { view, gridInstanceIds } = useUI()
  const { dispatch, selectInstance, addToGrid } = useAppDispatch()

  return useCallback((inst: InstanceConfig) => {
    if (view === 'chat') {
      selectInstance(inst.id)
    } else {
      const alreadyOpen = gridInstanceIds.includes(inst.id)
      addToGrid(inst.id)
      if (view !== 'grid') {
        dispatch({ type: 'SET_VIEW', payload: 'grid' })
        if (alreadyOpen) setTimeout(() => flashTile(inst.id), 80)
      } else if (alreadyOpen) {
        flashTile(inst.id)
      }
    }
    dispatch({ type: 'CLOSE_SETTINGS' })
  }, [view, gridInstanceIds, selectInstance, addToGrid, dispatch])
}
