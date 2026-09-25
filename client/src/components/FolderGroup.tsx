import { useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { FolderConfig, InstanceConfig } from '@shared/types'
import { useInstances } from '../context/InstancesContext'
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

function SortableInstanceItem({ instance, extraClass }: { instance: InstanceConfig; extraClass?: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: instance.id })
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
}

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
  const { instances: allInstances } = useInstances()
  const { settings } = useUI()
  const { dispatch } = useAppDispatch()
  const { pendingByProject } = useAllTasks()
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [showCreateTask, setShowCreateTask] = useState(false)
  const [showReleaseConfirm, setShowReleaseConfirm] = useState(false)
  const [dyingIds, setDyingIds] = useState<Set<string>>(new Set())

  const { alert, confirm } = useConfirm()

  const instances = [...allInstances.filter(i => i.folderId === folder.id)]
    .sort((a, b) => a.sortOrder - b.sortOrder)
  const expanded = folder.expanded
  const isCloudSynced = folder.cloudSync || false
  const cloudConfigured = !!(settings.cloudSyncUrl && settings.cloudSyncKey)

  const handleCloudSyncToggle = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!cloudConfigured) {
      await alert('Configure Cloud Sync in Settings > Advanced first.')
      return
    }
    const newVal = !isCloudSynced
    dispatch({ type: 'UPDATE_FOLDER', payload: { id: folder.id, updates: { cloudSync: newVal } } })
    api.updateFolder(folder.id, { cloudSync: newVal } as Partial<FolderConfig>)
    if (newVal) {
      // Trigger initial sync
      rest.triggerSync(folder.id).catch(() => {})
    }
  }, [cloudConfigured, isCloudSynced, folder.id, dispatch, alert])

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
    const ids = instances.map(i => i.id)
    const oldIndex = ids.indexOf(active.id as string)
    const newIndex = ids.indexOf(over.id as string)
    const reordered = arrayMove(ids, oldIndex, newIndex)
    dispatch({ type: 'REORDER_INSTANCES', payload: { folderId: folder.id, ids: reordered } })
    api.reorderInstances(reordered).catch(console.error)
  }, [instances, dispatch, folder.id])

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

  const handleRemove = useCallback(async () => {
    try {
      await api.deleteFolder(folder.id)
      dispatch({ type: 'REMOVE_FOLDER', folderId: folder.id })
    } catch (err) {
      console.error('Failed to hide folder:', err)
    }
    closeContextMenu()
  }, [dispatch, folder, closeContextMenu])

  const handlePauseAll = useCallback(async () => {
    closeContextMenu()
    try {
      await api.pauseAll(folder.id)
      for (const inst of instances) {
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id: inst.id, updates: { state: 'idle' } } })
      }
    } catch (err) {
      console.error('Failed to pause all:', err)
    }
  }, [folder.id, instances, dispatch, closeContextMenu])

  const handleReleaseAll = useCallback(async () => {
    setShowReleaseConfirm(false)
    try {
      const result = await api.releaseAll(folder.id)
      for (const id of result.instanceIds) {
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates: { state: 'idle', sessionId: undefined, activeTaskId: undefined, activeTaskTitle: undefined, taskStartedAt: undefined } } })
      }
    } catch (err) {
      console.error('Failed to release all:', err)
    }
  }, [folder.id, dispatch])

  const handleOpenFolder = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    closeContextMenu()
    rest.openFolder(folder.id).catch(console.error)
  }, [folder.id, closeContextMenu])

  const handleCloseAll = useCallback(async () => {
    closeContextMenu()
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
      console.error('Failed to close all:', err)
    }
  }, [folder.id, instances, folder.displayName, folder.name, dispatch, closeContextMenu, confirm])

  const handleRenew = useCallback(async () => {
    closeContextMenu()
    const dirtyInsts = instances.filter(i => (i.dirtyCount ?? 0) > 0)
    const dirtyFiles = dirtyInsts.reduce((s, i) => s + (i.dirtyCount ?? 0), 0)
    const dirtyNote = dirtyInsts.length > 0
      ? ` ⚠ ${dirtyInsts.length} have uncommitted work (${dirtyFiles}+ file${dirtyFiles !== 1 ? 's' : ''}): commit before renewing or the session that made it is gone.`
      : ''
    const scheduledNote = await scheduledOnChatsNote(folder.id, instances.map(i => i.id))
    const ok = await confirm(`Renew all ${instances.length} chat${instances.length !== 1 ? 's' : ''} in ${folder.displayName || folder.name}? This will close all sessions and create fresh ones.${dirtyNote}${scheduledNote}`)
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
      console.error('Failed to renew folder:', err)
      setDyingIds(new Set())
    }
  }, [folder.id, folder.displayName, folder.name, instances, settings.namingTheme, dispatch, closeContextMenu, confirm])

  const hasRunning = instances.some(i => i.state === 'running')
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
      {!compact && cloudConfigured && (
        <div className="folder-btn-wrap">
          <button
            className={`folder-tool cloud-sync-btn ${isCloudSynced ? 'active' : ''}`}
            onClick={handleCloudSyncToggle}
            style={{ opacity: isCloudSynced ? 1 : undefined, color: isCloudSynced ? 'var(--accent)' : undefined }}
          >{'☁'}</button>
          <span className="folder-btn-tip">{isCloudSynced ? 'Cloud synced' : 'Sync to cloud'}</span>
        </div>
      )}
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
              <SortableContext items={instances.map(i => i.id)} strategy={verticalListSortingStrategy}>
                {instances.map(inst => (
                  <SortableInstanceItem
                    key={inst.id}
                    instance={inst}
                    extraClass={dyingIds.has(inst.id) ? 'anim-remove' : undefined}
                  />
                ))}
              </SortableContext>
            </DndContext>
            {instances.length === 0 && (
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
              <button className="context-menu-item danger" onClick={handleRemove}>Hide Project</button>
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
                <p>This will close {instances.length} session{instances.length !== 1 ? 's' : ''} in <strong>{folder.displayName || folder.name}</strong>. Sessions will be reset and can be restarted.</p>
                {instances.length > 0 && (
                  <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13, color: 'var(--text-secondary)' }}>
                    {instances.map(i => <li key={i.id}>{i.name}</li>)}
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
              <SortableContext items={instances.map(i => i.id)} strategy={verticalListSortingStrategy}>
                {instances.map(inst => (
                  <SortableInstanceItem
                    key={inst.id}
                    instance={inst}
                    extraClass={dyingIds.has(inst.id) ? 'anim-remove' : undefined}
                  />
                ))}
              </SortableContext>
            </DndContext>
            {instances.length === 0 && childNodes.length === 0 && (
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
            <button className="context-menu-item danger" onClick={handleRemove}>
              Hide Project
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
              <p>This will close {instances.length} session{instances.length !== 1 ? 's' : ''} in <strong>{folder.displayName || folder.name}</strong>. Sessions will be reset and can be restarted.</p>
              {instances.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13, color: 'var(--text-secondary)' }}>
                  {instances.map(i => <li key={i.id}>{i.name}</li>)}
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
