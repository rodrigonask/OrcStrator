import { memo, useContext, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { FolderConfig, InstanceConfig } from '@shared/types'
import { InstancesContext, useInstance, useInstancesSelector } from '../context/InstancesContext'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useAllTasks } from '../context/AllTasksContext'
import { api } from '../api'
import { rest } from '../api/rest'
import { InstanceItem } from './InstanceItem'
import { useConfirm } from './ConfirmModal'
import { CreateTaskModal } from './pipeline/CreateTaskModal'
import { scheduledCardsForChats } from './CloseScheduledDialog'
import { randomName } from '../utils/naming'
import { folderColor } from '../utils/folderColor'
import { IconPipeline, IconFolder, IconChatPlus } from './icons'

/**
 * One sentence for the Close All and Renew All confirms: how many scheduled cards fire on
 * the chats about to go. Closing those chats does not delete the cards; each keeps running
 * in a fresh chat in this project from its next fire on. Fetched at click time rather than
 * kept live, because this is the only moment the folder needs to know. Empty on failure:
 * a missing sentence must never block the confirm.
 *
 * This project's own board is the right and the only place to look. A card's target chat
 * can only be picked from the card's own project, so every card aimed at a chat in this
 * folder is on this folder's board.
 *
 * The `true` below is not optional and is not really about done cards: it is the flag that
 * makes this route answer with the FULL task shape. The light shape does now carry the
 * schedule columns the board pill needs (migration048 and the getTasksForProjectLight
 * column list), but it still drops the description, and a scheduled card with no
 * description is not enough to write the warning sentence from.
 */
async function scheduledOnChatsNote(projectId: string, instanceIds: string[]): Promise<string> {
  try {
    const tasks = await api.getProjectPipeline(projectId, true)
    // Only cards aimed AT one of these chats, via targetInstanceId and never instanceId:
    // one is the chat the next fire goes to, the other is whichever chat happened to work
    // the card last. A card aimed at the project (null) is unaffected by closing chats, it
    // opens its own on every fire regardless. Fired one-offs are excluded too, because the
    // sentence promises they "will keep running" and a spent one-off will not.
    const n = scheduledCardsForChats(tasks, instanceIds).length
    if (n === 0) return ''
    return ` ${n} scheduled card${n !== 1 ? 's' : ''} fire${n === 1 ? 's' : ''} on these chats and will keep running in new chats.`
  } catch {
    return ''
  }
}

const NO_ROWS: InstanceConfig[] = []

/** One project's chats, in sidebar order. */
function folderRows(all: InstanceConfig[], folderId: string): InstanceConfig[] {
  return all.filter(i => i.folderId === folderId).sort((a, b) => a.sortOrder - b.sortOrder)
}

// Memoized so a row re-renders only when ITS instance changes.
const SortableInstanceItem = memo(function SortableInstanceItem({ instanceId, extraClass }: { instanceId: string; extraClass?: string }) {
  const instance = useInstance(instanceId)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: instanceId })
  if (!instance) return null
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <div ref={setNodeRef} style={style}>
      <InstanceItem instance={instance} dragHandleProps={{ ...attributes, ...listeners }} extraClass={extraClass} />
    </div>
  )
})

function SortableChildFolder({ node, depth }: { node: FolderTreeNode; depth: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: node.folder.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <div ref={setNodeRef} className="folder-child-sortable" style={style}>
      <FolderGroup folder={node.folder} childNodes={node.children} depth={depth} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  )
}


interface FolderTreeNode {
  folder: FolderConfig
  children: FolderTreeNode[]
}

interface FolderGroupProps {
  folder: FolderConfig
  childNodes?: FolderTreeNode[]
  depth?: number
  dragHandleProps?: Record<string, unknown>
}

export function FolderGroup({ folder, childNodes = [], depth = 0, dragHandleProps }: FolderGroupProps) {
  // This folder's rows only: a chat in another project streaming does not re-render it.
  const folderId = folder.id
  // The folder subscribes to its row ids and a "running" flag only; each row reads its own
  // instance. Actions read the full rows at the moment they run (readRows).
  const instancesStore = useContext(InstancesContext)
  const readRows = useCallback(() => folderRows(instancesStore.getState().instances, folderId), [instancesStore, folderId])
  const idKey = useInstancesSelector(s => folderRows(s.instances, folderId).map(i => i.id).join(','))
  const hasRunning = useInstancesSelector(s => s.instances.some(i => i.folderId === folderId && i.state === 'running'))
  const { settings } = useUI()
  const { dispatch } = useAppDispatch()
  const { pendingByProject } = useAllTasks()
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [showCreateTask, setShowCreateTask] = useState(false)
  const [showReleaseConfirm, setShowReleaseConfirm] = useState(false)
  const [dyingIds, setDyingIds] = useState<Set<string>>(new Set())

  const { confirm, alert } = useConfirm()
  // A project action the server refused (a chat whose agent would not stop) says why, instead of
  // only reaching the console.
  const sayWhy = useCallback((err: unknown, title: string) => {
    console.error(`${title}:`, err)
    void alert(err instanceof Error ? err.message : String(err), title)
  }, [alert])

  // A stable id list for the sortable rows: SortableContext hands it to every row through context,
  // so a fresh array per render re-rendered every row on every progress tick.
  const instanceIds = useMemo(() => (idKey ? idKey.split(',') : []), [idKey])
  const expanded = folder.expanded
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const sortedChildNodes = useMemo(() =>
    [...childNodes].sort((a, b) => a.folder.sortOrder - b.folder.sortOrder),
    [childNodes]
  )

  const handleChildFolderDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = sortedChildNodes.map(n => n.folder.id)
    const oldIndex = ids.indexOf(active.id as string)
    const newIndex = ids.indexOf(over.id as string)
    const reordered = arrayMove(ids, oldIndex, newIndex)
    dispatch({ type: 'REORDER_FOLDERS', payload: reordered })
    api.reorderFolders(reordered).catch(console.error)
  }, [sortedChildNodes, dispatch])

  const handleInstanceDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = instanceIds
    const oldIndex = ids.indexOf(active.id as string)
    const newIndex = ids.indexOf(over.id as string)
    const reordered = arrayMove(ids, oldIndex, newIndex)
    dispatch({ type: 'REORDER_INSTANCES', payload: { folderId: folder.id, ids: reordered } })
    api.reorderInstances(reordered).catch(console.error)
  }, [instanceIds, dispatch, folder.id])

  const toggleExpanded = useCallback(() => {
    dispatch({ type: 'TOGGLE_FOLDER', folderId: folder.id })
    api.updateFolder(folder.id, { expanded: !folder.expanded }).catch(console.error)
  }, [dispatch, folder.id, folder.expanded])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const handleEdit = useCallback(() => {
    dispatch({ type: 'OPEN_PROJECT_EDIT', folderId: folder.id })
    closeContextMenu()
  }, [dispatch, folder.id, closeContextMenu])

  const handleAddInstance = useCallback(async () => {
    closeContextMenu()
    try {
      const instance = await api.createInstance({
        folderId: folder.id,
        name: randomName(settings.namingThemes ?? (settings.namingTheme ? [settings.namingTheme] : ['memes'])),
        cwd: folder.path,
      })
      dispatch({ type: 'ADD_INSTANCE', payload: instance })
      dispatch({ type: 'SELECT_INSTANCE', payload: instance.id })
      // New chat opens straight into the grid as a focused tile
      dispatch({ type: 'SET_VIEW', payload: 'grid' })
      dispatch({ type: 'GRID_ADD', payload: { id: instance.id, maxTiles: settings.maxGridTiles ?? 12 } })
      if (!folder.expanded) {
        dispatch({ type: 'TOGGLE_FOLDER', folderId: folder.id })
        api.updateFolder(folder.id, { expanded: true }).catch(console.error)
      }
    } catch (err) {
      console.error('Failed to create instance:', err)
    }
  }, [dispatch, folder, closeContextMenu])

  const handlePipeline = useCallback(() => {
    dispatch({ type: 'SET_VIEW', payload: 'pipeline' })
    dispatch({ type: 'SET_PIPELINE_PROJECT', projectId: folder.id })
    closeContextMenu()
  }, [dispatch, folder.id, closeContextMenu])

  // Capture without leaving where you are: no view change, no board, just the modal with
  // this project already selected. showCreateTask and the modal below already existed;
  // nothing in the UI had ever reached them.
  const handleNewTask = useCallback(() => {
    setShowCreateTask(true)
    closeContextMenu()
  }, [closeContextMenu])

  // Hide keeps EVERYTHING: it flips the project's hidden flag and nothing else. It used to
  // call the delete route, so one click wiped every card, routine and chat.
  // It must never reach api.deleteFolder; the test in server/test/hide-never-deletes
  // reads this handler to hold that line.
  const handleHide = useCallback(async () => {
    closeContextMenu()
    try {
      await api.hideFolder(folder.id)
      dispatch({ type: 'UPDATE_FOLDER', payload: { id: folder.id, updates: { hidden: true } } })
    } catch (err) {
      console.error('Failed to hide project:', err)
    }
  }, [dispatch, folder.id, closeContextMenu])

  // Delete is the permanent one, and it says so, with the counts, before anything goes.
  const handleDelete = useCallback(async () => {
    closeContextMenu()
    let what = 'every card, routine, comment and chat in it'
    try {
      const s = await api.getFolderDeleteSummary(folder.id)
      const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
      const parts = [
        s.cards > 0 && plural(s.cards, 'card'),
        s.routines > 0 && plural(s.routines, 'routine'),
        s.comments > 0 && plural(s.comments, 'comment'),
        s.chats > 0 && `${plural(s.chats, 'chat')} and ${s.chats === 1 ? 'its' : 'their'} messages`,
      ].filter(Boolean) as string[]
      what = parts.length === 0 ? 'the project from OrcStrator'
        : parts.length === 1 ? parts[0]
        : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    } catch { /* the generic sentence above still names what is lost */ }
    const name = folder.displayName || folder.name
    const ok = await confirm(
      `Delete "${name}" permanently? This removes ${what}. It cannot be undone. The folder on your computer is not touched. To keep everything and only take the project out of the sidebar, use Hide Project instead.`,
      'Delete project',
      { confirmLabel: 'Delete project', danger: true },
    )
    if (!ok) return
    try {
      await api.deleteFolder(folder.id, folder.id)
      dispatch({ type: 'REMOVE_FOLDER', folderId: folder.id })
    } catch (err) {
      sayWhy(err, 'Could not delete the project')
    }
  }, [dispatch, folder.id, folder.displayName, folder.name, closeContextMenu, confirm, sayWhy])

  const handlePauseAll = useCallback(async () => {
    closeContextMenu()
    try {
      const instances = readRows()
      const result = await api.pauseAll(folder.id)
      // Not a chat the server could not stop: it is still running, and says so.
      const notStopped = new Set(result.notStopped ?? [])
      for (const inst of instances) {
        if (notStopped.has(inst.id)) continue
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id: inst.id, updates: { state: 'idle' } } })
      }
      if (notStopped.size > 0) {
        const n = notStopped.size
        void alert(`${n} chat${n === 1 ? '' : 's'} could not be stopped and ${n === 1 ? 'is' : 'are'} still running. Try again, or open ${n === 1 ? 'it' : 'each one'} and use Force reset in its \u2630 menu.`, 'Not everything was paused')
      }
    } catch (err) {
      sayWhy(err, 'Could not pause the chats')
    }
  }, [folder.id, readRows, dispatch, closeContextMenu, sayWhy, alert])

  const handleReleaseAll = useCallback(async () => {
    setShowReleaseConfirm(false)
    try {
      const result = await api.releaseAll(folder.id)
      for (const id of result.instanceIds) {
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates: { state: 'idle', sessionId: undefined, activeTaskId: undefined, activeTaskTitle: undefined, taskStartedAt: undefined } } })
      }
    } catch (err) {
      sayWhy(err, 'Could not release the sessions')
    }
  }, [folder.id, dispatch, sayWhy])

  const handleOpenFolder = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    closeContextMenu()
    rest.openFolder(folder.id).catch(console.error)
  }, [folder.id, closeContextMenu])

  const handleCloseAll = useCallback(async () => {
    closeContextMenu()
    const instances = readRows()
    const dirtyInsts = instances.filter(i => (i.dirtyCount ?? 0) > 0)
    const dirtyFiles = dirtyInsts.reduce((s, i) => s + (i.dirtyCount ?? 0), 0)
    const dirtyNote = dirtyInsts.length > 0
      ? ` ⚠ ${dirtyInsts.length} of them have uncommitted work (${dirtyFiles}+ file${dirtyFiles !== 1 ? 's' : ''}) that will lose its session.`
      : ''
    const scheduledNote = await scheduledOnChatsNote(folder.id, instances.map(i => i.id))
    const ok = await confirm(`Close all ${instances.length} chat${instances.length !== 1 ? 's' : ''} in ${folder.displayName || folder.name}? This will kill all processes and remove all chats.${dirtyNote}${scheduledNote}`)
    if (!ok) return
    try {
      const result = await rest.closeAll(folder.id)
      for (const id of result.instanceIds) {
        dispatch({ type: 'REMOVE_INSTANCE', payload: id })
      }
    } catch (err) {
      sayWhy(err, 'Could not close the chats')
    }
  }, [folder.id, readRows, folder.displayName, folder.name, dispatch, closeContextMenu, confirm, sayWhy])

  const handleRenew = useCallback(async () => {
    closeContextMenu()
    const instances = readRows()
    const dirtyInsts = instances.filter(i => (i.dirtyCount ?? 0) > 0)
    const dirtyFiles = dirtyInsts.reduce((s, i) => s + (i.dirtyCount ?? 0), 0)
    const dirtyNote = dirtyInsts.length > 0
      ? ` ⚠ ${dirtyInsts.length} have uncommitted work (${dirtyFiles}+ file${dirtyFiles !== 1 ? 's' : ''}): commit before renewing or the session that made it is gone.`
      : ''
    const scheduledNote = await scheduledOnChatsNote(folder.id, instances.map(i => i.id))
    const ok = await confirm(
      `Renew all ${instances.length} chat${instances.length !== 1 ? 's' : ''} in ${folder.displayName || folder.name}? This will close all sessions and create fresh ones, and their chat history in OrcStrator is cleared.${dirtyNote}${scheduledNote}`,
      'Renew all chats',
      { confirmLabel: 'Renew and clear history', danger: true },
    )
    if (!ok) return
    try {
      const newNames = instances.map(() => randomName(settings.namingThemes ?? (settings.namingTheme ? [settings.namingTheme] : ['memes'])))
      const result = await api.renewFolder(folder.id, { newNames })

      // 1. Play the death animation on all old instances
      setDyingIds(new Set(result.oldInstanceIds))

      // 2. After anim-remove finishes (1.2s), remove them all
      await new Promise(r => setTimeout(r, 1300))
      setDyingIds(new Set())
      for (const id of result.oldInstanceIds) {
        dispatch({ type: 'REMOVE_INSTANCE', payload: id })
      }

      // 3. Brief pause, then add new instances one by one (each triggers anim-spawn)
      await new Promise(r => setTimeout(r, 200))
      for (const inst of result.newInstances) {
        dispatch({ type: 'ADD_INSTANCE', payload: {
          id: inst.id as string,
          folderId: inst.folder_id as string,
          name: inst.name as string,
          cwd: inst.cwd as string,
          sessionId: undefined,
          state: 'idle',
          agentId: inst.agent_id as string | undefined,
          idleRestartMinutes: inst.idle_restart_minutes as number,
          sortOrder: inst.sort_order as number,
          createdAt: inst.created_at as number,
          overdriveTasks: 0,
        } })
        await new Promise(r => setTimeout(r, 300))
      }
    } catch (err) {
      setDyingIds(new Set())
      sayWhy(err, 'Could not renew the chats')
    }
  }, [folder.id, folder.displayName, folder.name, readRows, settings.namingTheme, dispatch, closeContextMenu, confirm, sayWhy])

  // Only read while the release dialog is open, which is when it renders the names.
  const releaseRows = showReleaseConfirm ? readRows() : NO_ROWS
  const statusClass = folder.status === 'paused' ? 'paused'
    : folder.status === 'archived' ? 'archived'
    : hasRunning ? 'active'
    : 'all-idle'

  // Pending-task badge. Projects nest in the sidebar, so a collapsed parent would
  // otherwise hide its children's pending work entirely: when collapsed the badge rolls up
  // descendants, when expanded it shows only this project's own count (the children carry
  // their own badges). The title spells out which of the two is on screen.
  const ownPending = pendingByProject[folder.id] || 0
  const descendantPending = useMemo(() => {
    let sum = 0
    const walk = (nodes: FolderTreeNode[]) => {
      for (const n of nodes) {
        sum += pendingByProject[n.folder.id] || 0
        walk(n.children)
      }
    }
    walk(childNodes)
    return sum
  }, [childNodes, pendingByProject])
  const rolledUp = !expanded && descendantPending > 0
  const pendingTasks = rolledUp ? ownPending + descendantPending : ownPending
  const pendingTitle = rolledUp
    ? `${pendingTasks} open tasks (${ownPending} here, ${descendantPending} in sub-projects)`
    : `${pendingTasks} open task${pendingTasks === 1 ? '' : 's'}`

  // The tools cluster. One pill carries the board: its icon plus the open-task count, so
  // the number never stands alone and the board is always one click away (icon only at
  // zero). Folder and new-chat follow. It sits directly after the title in flow, so nothing
  // floats over the row; the CSS gates it behind row hover except the pill with a count.
  // The cluster swallows clicks so pressing a tool never toggles the row.
  const renderTools = (compact: boolean) => (
    <div className="folder-tools" onClick={(e) => e.stopPropagation()}>
      <div className="folder-btn-wrap">
        <button
          className={`folder-tool folder-tool-pill${pendingTasks > 0 ? ' has-count' : ''}`}
          onClick={handlePipeline}
        >
          <IconPipeline size={compact ? 11 : 12} />
          {pendingTasks > 0 && <span className="folder-tool-count">{pendingTasks}</span>}
        </button>
        <span className="folder-btn-tip">{pendingTasks > 0 ? `Pipeline board · ${pendingTitle}` : 'Pipeline board'}</span>
      </div>
      <div className="folder-btn-wrap">
        <button className="folder-tool" onClick={handleOpenFolder}><IconFolder size={compact ? 12 : 13} /></button>
        <span className="folder-btn-tip">Open folder</span>
      </div>
      <div className="folder-btn-wrap">
        <button className="folder-tool" onClick={handleAddInstance}><IconChatPlus size={compact ? 12 : 13} /></button>
        <span className="folder-btn-tip">New chat</span>
      </div>
    </div>
  )

  const safeDragProps = useMemo(() => {
    if (!dragHandleProps) return {}
    const props = { ...(dragHandleProps as Record<string, unknown>) }
    const origPointerDown = props.onPointerDown as ((e: React.PointerEvent) => void) | undefined
    if (origPointerDown) {
      props.onPointerDown = (e: React.PointerEvent) => {
        if (e.button === 2) return // let right-click through for context menu
        origPointerDown(e)
      }
    }
    return props
  }, [dragHandleProps])

  // Compact child row for nested folders (depth > 0)
  if (depth > 0) {
    return (
      <div className="folder-child-group" style={{ '--folder-color': folderColor(folder) } as React.CSSProperties}>
        <div
          className="folder-child-row"
          onClick={toggleExpanded}
          onContextMenu={handleContextMenu}
          {...safeDragProps}
        >
          <span className="folder-emoji" style={{ fontSize: 14, width: 18 }}>{folder.emoji || '\uD83D\uDCC1'}</span>
          <span className="folder-child-name">{folder.displayName || folder.name}</span>
          {renderTools(true)}
          <div className={`folder-status ${statusClass}`} />
        </div>
        {expanded && (
          <div className="folder-child-instances">
            <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleInstanceDragEnd}>
              <SortableContext items={instanceIds} strategy={verticalListSortingStrategy}>
                {instanceIds.map(id => (
                  <SortableInstanceItem
                    key={id}
                    instanceId={id}
                    extraClass={dyingIds.has(id) ? 'anim-remove' : undefined}
                  />
                ))}
              </SortableContext>
            </DndContext>
            {instanceIds.length === 0 && (
              <div style={{ padding: '4px 12px 4px 52px', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                No chats
              </div>
            )}
            {sortedChildNodes.length > 0 && (
              <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleChildFolderDragEnd}>
                <SortableContext items={sortedChildNodes.map(n => n.folder.id)} strategy={verticalListSortingStrategy}>
                  {sortedChildNodes.map(child => (
                    <SortableChildFolder key={child.folder.id} node={child} depth={(depth || 0) + 1} />
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </div>
        )}

        {contextMenu && createPortal(
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 199 }}
              onClick={closeContextMenu}
              onContextMenu={(e) => { e.preventDefault(); closeContextMenu() }}
            />
            <div
              className="context-menu"
              style={{ top: contextMenu.y, left: contextMenu.x }}
              onClick={e => e.stopPropagation()}
            >
              <button className="context-menu-item" onClick={handleOpenFolder}>Open in Explorer</button>
              <button className="context-menu-item" onClick={handleEdit}>Edit Project</button>
              <button className="context-menu-item" onClick={handleNewTask}>New Task Here</button>
              <button className="context-menu-item" onClick={handleAddInstance}>Add Chat</button>
              <button className="context-menu-item" onClick={handlePipeline}>Pipeline</button>
              <div className="context-menu-separator" />
              <button className="context-menu-item" onClick={handlePauseAll}>Pause All</button>
              <button className="context-menu-item" onClick={() => { setShowReleaseConfirm(true); closeContextMenu() }}>Release All...</button>
              <button className="context-menu-item" onClick={handleRenew}>Renew All</button>
              <button className="context-menu-item danger" onClick={handleCloseAll}>Close All</button>
              <div className="context-menu-separator" />
              <button className="context-menu-item" onClick={handleHide} title="Take it out of the sidebar. Nothing is deleted; bring it back from Hidden projects.">Hide Project</button>
              <button className="context-menu-item danger" onClick={handleDelete}>Delete Project...</button>
            </div>
          </>,
          document.body
        )}

        {showCreateTask && (
          <CreateTaskModal projectId={folder.id} onClose={() => setShowCreateTask(false)} />
        )}

        {showReleaseConfirm && createPortal(
          <div className="modal-overlay" onClick={() => setShowReleaseConfirm(false)}>
            <div className="modal-panel release-confirm-modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Release All Sessions</span>
                <button className="modal-close" onClick={() => setShowReleaseConfirm(false)}>×</button>
              </div>
              <div className="modal-body">
                <p>This will close {releaseRows.length} session{releaseRows.length !== 1 ? 's' : ''} in <strong>{folder.displayName || folder.name}</strong>. Sessions will be reset and can be restarted.</p>
                {releaseRows.length > 0 && (
                  <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13, color: 'var(--text-secondary)' }}>
                    {releaseRows.map(i => <li key={i.id}>{i.name}</li>)}
                  </ul>
                )}
              </div>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setShowReleaseConfirm(false)}>Cancel</button>
                <button className="btn btn-danger-solid" onClick={handleReleaseAll}>Release All</button>
              </div>
            </div>
          </div>,
          document.body
        )}
      </div>
    )
  }

  return (
    <div className={`folder-group${folder.stealthMode ? ' stealth' : ''}`} style={{ '--folder-color': folderColor(folder) } as React.CSSProperties}>
      <div
        className="folder-header"
        {...(safeDragProps as React.HTMLAttributes<HTMLDivElement>)}
        onClick={toggleExpanded}
        onContextMenu={handleContextMenu}
      >
        <div
          className="folder-color-bar"
          style={{ backgroundColor: folderColor(folder) }}
        />
        <span className="folder-emoji">{folder.emoji || (folder.stealthMode ? '👻' : '\uD83D\uDCC1')}</span>
        <div className="folder-info">
          <div className="folder-title-row">
            <div className="folder-name">
              {folder.displayName || folder.name}
              {folder.stealthMode && (
                <span
                  className="stealth-tooltip-icon"
                  title="Conversations in this folder do not save memory or persist context between sessions."
                >👻</span>
              )}
            </div>
            {renderTools(false)}
          </div>
          {folder.client && <div className="folder-client" style={{ fontFamily: 'var(--font-mono)' }}>{folder.client}</div>}
        </div>
        <div className={`folder-status ${statusClass}`} />

      </div>

      {expanded && (
        <>
          <div className="folder-instances">
            <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleInstanceDragEnd}>
              <SortableContext items={instanceIds} strategy={verticalListSortingStrategy}>
                {instanceIds.map(id => (
                  <SortableInstanceItem
                    key={id}
                    instanceId={id}
                    extraClass={dyingIds.has(id) ? 'anim-remove' : undefined}
                  />
                ))}
              </SortableContext>
            </DndContext>
            {instanceIds.length === 0 && childNodes.length === 0 && (
              <div className="instance-item" style={{ cursor: 'default' }}>
                <span className="instance-info">
                  <span className="instance-preview" style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>No chats</span>
                </span>
              </div>
            )}
          </div>
          {sortedChildNodes.length > 0 && (
            <div className="folder-children">
              <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleChildFolderDragEnd}>
                <SortableContext items={sortedChildNodes.map(n => n.folder.id)} strategy={verticalListSortingStrategy}>
                  {sortedChildNodes.map(child => (
                    <SortableChildFolder key={child.folder.id} node={child} depth={(depth || 0) + 1} />
                  ))}
                </SortableContext>
              </DndContext>
            </div>
          )}
        </>
      )}

      {contextMenu && createPortal(
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 199 }}
            onClick={closeContextMenu}
            onContextMenu={(e) => { e.preventDefault(); closeContextMenu() }}
          />
          <div
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={e => e.stopPropagation()}
          >
            <button className="context-menu-item" onClick={handleOpenFolder}>
              Open in Explorer
            </button>
            <button className="context-menu-item" onClick={handleEdit}>
              Edit Project
            </button>
            <button className="context-menu-item" onClick={handleNewTask}>
              New Task Here
            </button>
            <button className="context-menu-item" onClick={handleAddInstance}>
              Add Chat
            </button>
            <button className="context-menu-item" onClick={handlePipeline}>
              Pipeline Project
            </button>
            <div className="context-menu-separator" />
            <button className="context-menu-item" onClick={handlePauseAll}>
              Pause All
            </button>
            <button className="context-menu-item" onClick={() => { setShowReleaseConfirm(true); closeContextMenu() }}>
              Release All...
            </button>
            <button className="context-menu-item" onClick={handleRenew}>
              Renew All
            </button>
            <button className="context-menu-item danger" onClick={handleCloseAll}>
              Close All
            </button>
            <div className="context-menu-separator" />
            <button className="context-menu-item" onClick={handleHide} title="Take it out of the sidebar. Nothing is deleted; bring it back from Hidden projects.">
              Hide Project
            </button>
            <button className="context-menu-item danger" onClick={handleDelete}>
              Delete Project...
            </button>
          </div>
        </>,
        document.body
      )}

      {showCreateTask && (
        <CreateTaskModal
          projectId={folder.id}
          onClose={() => setShowCreateTask(false)}
        />
      )}

      {showReleaseConfirm && createPortal(
        <div className="modal-overlay" onClick={() => setShowReleaseConfirm(false)}>
          <div className="modal-panel release-confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Release All Sessions</span>
              <button className="modal-close" onClick={() => setShowReleaseConfirm(false)}>×</button>
            </div>
            <div className="modal-body">
              <p>This will close {releaseRows.length} session{releaseRows.length !== 1 ? 's' : ''} in <strong>{folder.displayName || folder.name}</strong>. Sessions will be reset and can be restarted.</p>
              {releaseRows.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13, color: 'var(--text-secondary)' }}>
                  {releaseRows.map(i => <li key={i.id}>{i.name}</li>)}
                </ul>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowReleaseConfirm(false)}>Cancel</button>
              <button className="btn btn-danger-solid" onClick={handleReleaseAll}>Release All</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
