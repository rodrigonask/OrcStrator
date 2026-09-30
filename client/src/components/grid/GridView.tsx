import { useEffect, useMemo, useRef, useCallback, type CSSProperties } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import { useUI } from '../../context/UIContext'
import { useInstancesSelector } from '../../context/InstancesContext'
import { shallowEqual } from '../../context/store'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { GridTile } from './GridTile'
import { ErrorBoundary } from '../ErrorBoundary'
import { useRenderCount } from '../../utils/renderCount'

/** Tile count → column count, capped at `maxCols` (a user setting; default 6 for
 *  ultrawide). Chats are tall content, so prefer full-height columns: lay tiles out
 *  in a single row until we hit the cap, then wrap into balanced rows.
 *  At maxCols=4 this reproduces the old layout exactly (5-6→3x2, 7-8→4x2). */
function columnsFor(count: number, maxCols: number): number {
  if (count <= 1) return 1
  const rows = Math.ceil(count / maxCols)        // fewest rows that fit within the cap
  return Math.min(maxCols, Math.ceil(count / rows)) // spread evenly across those rows
}

export function GridView() {
  useRenderCount('GridView')
  const { gridInstanceIds, gridFocusedId, gridMaximizedId, gridNotice, settings } = useUI()
  // Ids and names only: a running chat's progress updates do not re-render the grid.
  const names = useInstancesSelector(s => Object.fromEntries(s.instances.map(i => [i.id, i.name])) as Record<string, string>, shallowEqual)
  const maxGridColumns = settings.maxGridColumns ?? 6
  const maxTiles = settings.maxGridTiles ?? 12
  // Width cap for a maximized tile. 0 = full bleed (the pre-reading-pane behaviour).
  const readingWidth = settings.chatReadingWidth ?? 1200
  const { dispatch } = useAppDispatch()
  const containerRef = useRef<HTMLDivElement>(null)

  // Pointer-based tile reorder: the tile itself follows the cursor; siblings
  // shift live; drop animates into the slot. 8px activation distance keeps
  // header clicks / double-click rename working.
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const handleDragEnd = useCallback((e: DragEndEvent) => {
    const { active, over } = e
    if (over && active.id !== over.id) {
      dispatch({ type: 'GRID_REORDER', payload: { dragId: String(active.id), targetId: String(over.id) } })
    }
  }, [dispatch])

  // Only render tiles whose instance still exists (deletion race safety)
  const tileIds = useMemo(() => {
    const existing = new Set(Object.keys(names))
    return gridInstanceIds.filter(id => existing.has(id))
  }, [gridInstanceIds, names])

  const cols = columnsFor(tileIds.length, maxGridColumns)
  const rows = Math.ceil(tileIds.length / cols) || 1
  const maximizedId = gridMaximizedId && tileIds.includes(gridMaximizedId) ? gridMaximizedId : null

  // Auto-clear the eviction notice after 3s
  useEffect(() => {
    if (!gridNotice) return
    const t = setTimeout(() => dispatch({ type: 'CLEAR_GRID_NOTICE' }), 3000)
    return () => clearTimeout(t)
  }, [gridNotice, dispatch])

  // Ctrl+1..9 focuses tile N (tiles 10-12 have no single-digit key)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      const n = parseInt(e.key, 10)
      if (!n || n < 1 || n > 9) return
      const id = tileIds[n - 1]
      if (!id) return
      e.preventDefault()
      dispatch({ type: 'GRID_TOUCH', payload: id })
      const el = containerRef.current?.querySelector<HTMLElement>(`[data-instance-id="${id}"]`)
      el?.scrollIntoView({ block: 'nearest' })
      el?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [tileIds, dispatch])

  // F fills the screen with the chat you last clicked, and F again puts it back.
  //
  // The tile you clicked is already tracked (GRID_TOUCH on mousedown-capture), so this
  // needs no new selection concept: click a chat anywhere, press F. Escape still restores
  // too, so there are two ways out and no way to get stranded.
  //
  // Never while typing. A bare letter is a keystroke first and a shortcut second, so any
  // input, textarea or contenteditable target passes straight through, and so does any F
  // carrying a modifier (Ctrl+F is the browser's find, and taking it would be theft).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'f' && e.key !== 'F') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (maximizedId) {
        e.preventDefault()
        dispatch({ type: 'GRID_MAXIMIZE', payload: null })
        return
      }
      if (!gridFocusedId) return
      e.preventDefault()
      dispatch({ type: 'GRID_MAXIMIZE', payload: gridFocusedId })
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [maximizedId, gridFocusedId, dispatch])

  // Escape restores the grid when a tile is maximized, in ONE press.
  //
  // It used to take two: the tile's capture handler blurred the composer, and this
  // handler then bailed out because the event still carried the textarea as its target,
  // so the grid only came back on the next press. The blur-first step was defending a
  // case nobody has ("leave the field but stay full screen"), and it cost the case
  // everybody has, every time, since a maximized tile puts the cursor in the composer.
  // The blur still happens (the tile handler runs first); this just no longer stops
  // there.
  //
  // A rename input is exempt: its own Escape handler calls stopPropagation, which keeps
  // the event from reaching this listener at all, so cancelling a rename does not also
  // throw you out of full screen.
  useEffect(() => {
    if (!maximizedId) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) t.blur()
      dispatch({ type: 'GRID_MAXIMIZE', payload: null })
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [maximizedId, dispatch])

  // Scroll the focused tile into view when focus changes (e.g. sidebar click)
  useEffect(() => {
    if (!gridFocusedId) return
    containerRef.current
      ?.querySelector<HTMLElement>(`[data-instance-id="${gridFocusedId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [gridFocusedId])

  const evictedName = gridNotice
    ? (names[gridNotice.evictedId] ?? 'a chat')
    : null

  if (tileIds.length === 0) {
    return (
      <div className="grid-view grid-view-empty">
        <div className="grid-empty-hint">
          <div className="grid-empty-title">Mission Control</div>
          <div className="grid-empty-text">Click chats in the sidebar to open up to {maxTiles} live tiles</div>
          <div className="grid-empty-orc">The Orc grunts approvingly. Many battles, one war room.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="grid-view" ref={containerRef}>
      {gridNotice && evictedName && (
        <div className="grid-notice" key={gridNotice.at} role="status">
          <span className="grid-notice-mark" aria-hidden="true" />
          <span>
            <strong>Grid full at {maxTiles} tiles.</strong> Replaced the last one,
            {' '}“{evictedName}”. It keeps running, reopen it from the sidebar.
          </span>
        </div>
      )}
      <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={tileIds} strategy={rectSortingStrategy}>
          <div
            className={`grid-tiles${maximizedId ? ' grid-tiles-has-max' : ''}`}
            style={maximizedId ? {
              '--chat-reading-width': readingWidth > 0 ? `${readingWidth}px` : 'none',
            } as CSSProperties : {
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gridTemplateRows: `repeat(${rows}, 1fr)`,
            }}
          >
            {tileIds.map(id => (
              // One boundary per tile: a render error costs that tile, never the grid.
              <ErrorBoundary key={id} variant="tile" label={names[id]} onRemove={() => dispatch({ type: 'GRID_REMOVE', payload: id })}>
                <GridTile
                  instanceId={id}
                  focused={gridFocusedId === id}
                  maximized={maximizedId === id}
                  hidden={!!maximizedId && maximizedId !== id}
                />
              </ErrorBoundary>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}
