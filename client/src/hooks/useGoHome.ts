import { useCallback } from 'react'
import { useAppDispatch } from '../context/AppDispatchContext'

/**
 * "Take me back to the grid" - what clicking the OrcStrator mark does.
 *
 * Extracted because the mark now appears in two places (the top bar's brand block, and
 * the sidebar's own head in Ultra Compact, where there is no top bar). A logo that goes
 * home in one mode and does nothing in the other is worse than no logo, so both render
 * the same button and call the same thing.
 */
export function useGoHome(): () => void {
  const { dispatch } = useAppDispatch()
  return useCallback(() => {
    dispatch({ type: 'CLOSE_SETTINGS' })
    dispatch({ type: 'CLOSE_FOLDER_BROWSER' })
    dispatch({ type: 'CLOSE_PROJECT_EDIT' })
    dispatch({ type: 'SELECT_INSTANCE', payload: null })
    dispatch({ type: 'SET_VIEW', payload: 'grid' })
  }, [dispatch])
}
