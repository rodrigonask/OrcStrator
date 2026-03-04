import { useState, useCallback } from 'react'
import type { FolderConfig } from '@shared/types'
import { useApp } from '../context/AppContext'
import { InstanceItem } from './InstanceItem'

interface FolderGroupProps {
  folder: FolderConfig
}

export function FolderGroup({ folder }: FolderGroupProps) {
  const { state, dispatch } = useApp()
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const instances = state.instances.filter(i => i.folderId === folder.id)
  const expanded = folder.expanded

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

  const handleAddInstance = useCallback(() => {
    dispatch({ type: 'ADD_INSTANCE', folderId: folder.id })
    closeContextMenu()
  }, [dispatch, folder.id, closeContextMenu])

  const handlePipeline = useCallback(() => {
    dispatch({ type: 'SET_VIEW', view: 'pipeline' })
    dispatch({ type: 'SET_PIPELINE_PROJECT', projectId: folder.id })
    closeContextMenu()
  }, [dispatch, folder.id, closeContextMenu])

  const handleRemove = useCallback(() => {
    if (confirm(`Remove folder "${folder.displayName || folder.name}"?`)) {
      dispatch({ type: 'REMOVE_FOLDER', folderId: folder.id })
    }
    closeContextMenu()
  }, [dispatch, folder, closeContextMenu])

  const statusClass = folder.status || 'active'

  return (
    <div className="folder-group">
      <div className="folder-header" onClick={toggleExpanded} onContextMenu={handleContextMenu}>
        <div
          className="folder-color-bar"
          style={{ backgroundColor: folder.color || '#7c3aed' }}
        />
        <span className="folder-emoji">{folder.emoji || '\uD83D\uDCC1'}</span>
        <div className="folder-info">
          <div className="folder-name">{folder.displayName || folder.name}</div>
          {folder.client && <div className="folder-client">{folder.client}</div>}
        </div>
        <div className={`folder-status ${statusClass}`} />
        <span className={`folder-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
      </div>

      {expanded && (
        <div className="folder-instances">
          {instances.map(inst => (
            <InstanceItem key={inst.id} instance={inst} />
          ))}
          {instances.length === 0 && (
            <div className="instance-item" style={{ opacity: 0.5, cursor: 'default' }}>
              <span className="instance-info">
                <span className="instance-preview">No instances</span>
              </span>
            </div>
          )}
        </div>
      )}

      {contextMenu && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 199 }}
            onClick={closeContextMenu}
          />
          <div
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
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
            <div className="context-menu-separator" />
            <button className="context-menu-item danger" onClick={handleRemove}>
              Remove Folder
            </button>
          </div>
        </>
      )}
    </div>
  )
}
