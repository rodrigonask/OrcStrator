// Alt+N: capture a task from anywhere in the app.
//
// OrcStrator runs in a browser tab, not Electron, so this is an in-app hotkey and cannot
// be global to the OS. Alt+N was chosen because Chrome reserves most Ctrl and Ctrl+Shift
// letter combinations (Ctrl+N, Ctrl+T, Ctrl+Shift+N all open browser windows before the
// page ever sees the event), while the app already uses Alt+Arrow to cycle instances, so
// Alt is the modifier the browser leaves alone here.

import { useState, useEffect, useCallback } from 'react'
import { useUI } from '../../context/UIContext'
import { useInstances } from '../../context/InstancesContext'
import { isAllProjects } from '../../utils/pipelineView'
import { CreateTaskModal } from './CreateTaskModal'

export function QuickTaskHotkey() {
  const { selectedInstanceId, gridMaximizedId, gridFocusedId, gridInstanceIds, activePipelineId } = useUI()
  const { instances, folders } = useInstances()
  const [open, setOpen] = useState(false)

  // Which project the task lands in, in priority order.
  //
  // "The last selected instance" cannot mean selectedInstanceId alone: that is only set in
  // the single-chat view, and the Grid is where the work actually happens. Reading it
  // alone meant every Alt+N pressed from the Grid fell through to the first folder in the
  // list, which is the least likely project to be the right one.
  //   1. The maximized grid tile, then the focused one, then the most recent tile: in Grid
  //      these are what "the chat I am looking at" means.
  //   2. selectedInstanceId, for the single-chat view.
  //   3. The board's active project, unless that is the all-projects sentinel, which is
  //      not a real project id.
  //   4. The first folder, so the modal never opens with nothing selected.
  const defaultProjectId = useCallback((): string => {
    const candidates = [
      gridMaximizedId,
      gridFocusedId,
      gridInstanceIds[gridInstanceIds.length - 1],
      selectedInstanceId,
    ]
    for (const id of candidates) {
      if (!id) continue
      const inst = instances.find(i => i.id === id)
      if (inst?.folderId && folders.some(f => f.id === inst.folderId)) return inst.folderId
    }
    if (activePipelineId && !isAllProjects(activePipelineId) && folders.some(f => f.id === activePipelineId)) {
      return activePipelineId
    }
    return folders[0]?.id || ''
  }, [instances, selectedInstanceId, gridMaximizedId, gridFocusedId, gridInstanceIds, activePipelineId, folders])

  const [projectId, setProjectId] = useState('')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      // e.key under Alt can be a composed character on some layouts, so match the physical
      // key as well as the produced one.
      if (e.key !== 'n' && e.key !== 'N' && e.code !== 'KeyN') return
      e.preventDefault()
      setProjectId(defaultProjectId())
      setOpen(true)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [defaultProjectId])

  if (!open || !projectId) return null
  return <CreateTaskModal projectId={projectId} onClose={() => setOpen(false)} />
}
