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
import { api } from '../api'
import { InstanceItem } from './InstanceItem'
import { LaunchTeamModal } from './LaunchTeamModal'
import { CreateTaskModal } from './pipeline/CreateTaskModal'
import { randomName } from '../utils/naming'

function SortableInstanceItem({ instance, folderOrchestratorActive }: { instance: InstanceConfig; folderOrchestratorActive: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: instance.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <div ref={setNodeRef} style={style}>
      <InstanceItem instance={instance} folderOrchestratorActive={folderOrchestratorActive} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  )
}


interface FolderGroupProps {
  folder: FolderConfig
  dragHandleProps?: Record<string, unknown>
}

export function FolderGroup({ folder, dragHandleProps }: FolderGroupProps) {
  const { instances: allInstances } = useInstances()
  const { settings } = useUI()
  const { dispatch } = useAppDispatch()
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirmOrchestrate, setConfirmOrchestrate] = useState(false)
  const [showLaunchTeam, setShowLaunchTeam] = useState(false)
  const [showCreateTask, setShowCreateTask] = useState(false)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [orchStatus, setOrchStatus] = useState<{ idleAgents: number; pendingTasks: number } | null>(null)
  const [showReleaseConfirm, setShowReleaseConfirm] = useState(false)

  const instances = [...allInstances.filter(i => i.folderId === folder.id)]
    .sort((a, b) => a.sortOrder - b.sortOrder)
  const expanded = folder.expanded
  const isOrchestratorActive = folder.orchestratorActive || false

  const instanceSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

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
  }, [dispatch, folder.id])

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
        name: randomName(settings.namingTheme || 'fruits'),
        cwd: folder.path,
      })
      dispatch({ type: 'ADD_INSTANCE', payload: instance })
      dispatch({ type: 'SELECT_INSTANCE', payload: instance.id })
      if (!folder.expanded) {
        dispatch({ type: 'TOGGLE_FOLDER', folderId: folder.id })
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

  const handleRemove = useCallback(async () => {
    try {
      await api.deleteFolder(folder.id)
      dispatch({ type: 'REMOVE_FOLDER', folderId: folder.id })
    } catch (err) {
      console.error('Failed to hide folder:', err)
    }
    closeContextMenu()
  }, [dispatch, folder, closeContextMenu])

  const handleOrchestrateClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isOrchestratorActive) {
      // Deactivate immediately
      try {
        await api.deactivateOrchestrator(folder.id)
        dispatch({ type: 'UPDATE_FOLDER', payload: { id: folder.id, updates: { orchestratorActive: false } } })
        setOrchStatus(null)
      } catch (err) {
        console.error('Failed to deactivate orchestrator:', err)
      }
    } else {
      setConfirmOrchestrate(true)
    }
  }, [isOrchestratorActive, folder.id, dispatch])

  const handleConfirmActivate = useCallback(async () => {
    setConfirmOrchestrate(false)
    try {
      await api.activateOrchestrator(folder.id)
      dispatch({ type: 'UPDATE_FOLDER', payload: { id: folder.id, updates: { orchestratorActive: true } } })
      const status = await api.getOrchestratorStatus(folder.id)
      setOrchStatus({ idleAgents: status.idleAgents, pendingTasks: status.pendingTasks })
    } catch (err) {
      console.error('Failed to activate orchestrator:', err)
    }
  }, [folder.id, dispatch])

  const handlePauseAll = useCallback(async () => {
    closeContextMenu()
    try {
      await api.pauseAll(folder.id)
      dispatch({ type: 'UPDATE_FOLDER', payload: { id: folder.id, updates: { orchestratorActive: false } } })
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
        dispatch({ type: 'UPDATE_INSTANCE', payload: { id, updates: { state: 'idle', sessionId: undefined } } })
      }
    } catch (err) {
      console.error('Failed to release all:', err)
    }
  }, [folder.id, dispatch])

  const hasRunning = instances.some(i => i.state === 'running')
  const statusClass = folder.status === 'paused' ? 'paused'
    : folder.status === 'archived' ? 'archived'
    : hasRunning ? 'active'
    : 'all-idle'

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

  return (
    <div className={`folder-group${folder.stealthMode ? ' stealth' : ''}`}>
      <div
        className="folder-header"
        {...(safeDragProps as React.HTMLAttributes<HTMLDivElement>)}
        onClick={toggleExpanded}
        onContextMenu={handleContextMenu}
      >
        <div
          className="folder-color-bar"
          style={{ backgroundColor: folder.stealthMode ? '#374151' : (folder.color || '#7c3aed') }}
        />
        <span className="folder-emoji">{folder.emoji || (folder.stealthMode ? '👻' : '\uD83D\uDCC1')}</span>
        <div className="folder-info">
          <div className="folder-name">
            {folder.displayName || folder.name}
            {folder.stealthMode && (
              <span
                className="stealth-tooltip-icon"
                title="Conversations in this folder do not save memory or persist context between sessions."
              >👻</span>
            )}
          </div>
          {folder.client && <div className="folder-client">{folder.client}</div>}
          {isOrchestratorActive && orchStatus && (
            <div className={`orchestrator-status-line${orchStatus.pendingTasks === 0 ? ' idle' : ''}`}>
              {orchStatus.pendingTasks} tasks queued
            </div>
          )}
        </div>
        <div className={`folder-status ${statusClass}`} />

        {/* Folder action buttons */}
        <div className="folder-action-group">
          <button
            className="pipeline-board-btn"
            title="Open pipeline board"
            onClick={(e) => { e.stopPropagation(); handlePipeline() }}
          >
            ▤
          </button>
          <button
            className={`orchestrator-toggle-btn ${isOrchestratorActive ? 'active' : ''}`}
            title={isOrchestratorActive ? 'The Orc is active — click to stop' : 'Activate The Orc'}
            onClick={handleOrchestrateClick}
          >
            {isOrchestratorActive ? (
              <span className="orch-pulse">⚡</span>
            ) : (
              '⚡'
            )}
          </button>
          <div
            className="folder-add-dropdown"
            onMouseEnter={() => setShowAddMenu(true)}
            onMouseLeave={() => setShowAddMenu(false)}
          >
            <button
              className="folder-add-btn"
              onClick={(e) => { e.stopPropagation(); setShowAddMenu(v => !v) }}
            >
              +
            </button>
            {showAddMenu && (
              <div className="folder-add-menu" onClick={e => e.stopPropagation()}>
                <button
                  className="folder-add-menu-item"
                  onClick={() => { setShowAddMenu(false); setShowCreateTask(true) }}
                >
                  New Task
                </button>
                <button
                  className="folder-add-menu-item"
                  onClick={() => { setShowAddMenu(false); handleAddInstance() }}
                >
                  New Instance
                </button>
              </div>
            )}
          </div>
        </div>
        <span className={`folder-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
      </div>

      {expanded && (
        <div className="folder-instances">
          <DndContext sensors={instanceSensors} collisionDetection={closestCenter} onDragEnd={handleInstanceDragEnd}>
            <SortableContext items={instances.map(i => i.id)} strategy={verticalListSortingStrategy}>
              {instances.map(inst => (
                <SortableInstanceItem
                  key={inst.id}
                  instance={inst}
                  folderOrchestratorActive={isOrchestratorActive}
                />
              ))}
            </SortableContext>
          </DndContext>
          {instances.length === 0 && (
            <div className="instance-item" style={{ opacity: 0.5, cursor: 'default' }}>
              <span className="instance-info">
                <span className="instance-preview">No instances</span>
              </span>
            </div>
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
            <button className="context-menu-item" onClick={handleEdit}>
              Edit Project
            </button>
            <button className="context-menu-item" onClick={handleAddInstance}>
              Add Instance
            </button>
            <button className="context-menu-item" onClick={handlePipeline}>
              Pipeline Board
            </button>
            <button className="context-menu-item" onClick={() => { setShowLaunchTeam(true); closeContextMenu() }}>
              Launch a Team
            </button>
            <div className="context-menu-separator" />
            <button className="context-menu-item" onClick={handlePauseAll}>
              Pause All
            </button>
            <button className="context-menu-item" onClick={() => { setShowReleaseConfirm(true); closeContextMenu() }}>
              Release All...
            </button>
            <div className="context-menu-separator" />
            <button className="context-menu-item danger" onClick={handleRemove}>
              Hide Folder
            </button>
          </div>
        </>,
        document.body
      )}

      {/* Orchestrate confirmation modal */}
      {confirmOrchestrate && (
        <div className="modal-overlay" onClick={() => setConfirmOrchestrate(false)}>
          <div className="modal-panel orchestrate-confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Hand Over Control?</span>
              <button className="modal-close" onClick={() => setConfirmOrchestrate(false)}>x</button>
            </div>
            <div className="modal-body">
              <p className="orchestrate-confirm-text">
                The Orc will claim all tagged agent sessions and direct their every move.
              </p>
              <p className="orchestrate-confirm-subtext">
                You can watch — you just can't interfere.
                <br />
                <em>The agents will be fine. Probably.</em>
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setConfirmOrchestrate(false)}>
                Actually, Never Mind
              </button>
              <button className="btn btn-primary" onClick={handleConfirmActivate}>
                Feed Them to the Machine
              </button>
            </div>
          </div>
        </div>
      )}

      {showLaunchTeam && (
        <LaunchTeamModal
          folder={folder}
          onClose={() => setShowLaunchTeam(false)}
        />
      )}

      {showCreateTask && (
        <CreateTaskModal
          projectId={folder.id}
          onClose={() => setShowCreateTask(false)}
        />
      )}

      {showReleaseConfirm && (
        <div className="modal-overlay" onClick={() => setShowReleaseConfirm(false)}>
          <div className="modal-panel" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Release All Sessions</span>
              <button className="modal-close" onClick={() => setShowReleaseConfirm(false)}>×</button>
            </div>
            <div className="modal-body">
              <p>This will close {instances.length} session{instances.length !== 1 ? 's' : ''} in <strong>{folder.displayName || folder.name}</strong>. Sessions will be reset and can be restarted.</p>
              {instances.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13 }}>
                  {instances.map(i => <li key={i.id}>{i.name}</li>)}
                </ul>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowReleaseConfirm(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleReleaseAll}>Release All</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
