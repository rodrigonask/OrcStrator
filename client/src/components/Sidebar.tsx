import { useState, useCallback } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useInstances } from '../context/InstancesContext'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'
import { ConnectionStatus } from './ConnectionStatus'
import { FolderGroup } from './FolderGroup'
import { FolderBrowserModal } from './FolderBrowserModal'
import { ProjectEditModal } from './ProjectEditModal'

import type { FolderConfig } from '@shared/types'

function SortableFolderGroup({ folder }: { folder: FolderConfig }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: folder.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <div ref={setNodeRef} style={style}>
      <FolderGroup folder={folder} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  )
}

export function Sidebar() {
  const { folders } = useInstances()
  const { editingFolderId, showFolderBrowser, settings } = useUI()
  const { dispatch } = useAppDispatch()
  const [collapsed, setCollapsed] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const sortedFolders = [...folders].sort((a, b) => {
    if (a.stealthMode && !b.stealthMode) return -1
    if (!a.stealthMode && b.stealthMode) return 1
    return a.sortOrder - b.sortOrder
  })

  const handleFolderDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = sortedFolders.map(f => f.id)
    const oldIndex = ids.indexOf(active.id as string)
    const newIndex = ids.indexOf(over.id as string)
    const reordered = arrayMove(ids, oldIndex, newIndex)
    dispatch({ type: 'REORDER_FOLDERS', payload: reordered })
    api.reorderFolders(reordered).catch(console.error)
  }, [sortedFolders, dispatch])


  return (
    <>
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-header-left">
            <ConnectionStatus />
            <button
              className="sidebar-title"
              onClick={() => {
                dispatch({ type: 'SELECT_INSTANCE', payload: null })
                dispatch({ type: 'SET_VIEW', payload: 'chat' })
              }}
            >
              <span className="font-pixel" style={{ fontSize: '10px' }}>Orcstrator</span>
            </button>
          </div>
          <button
            className="sidebar-collapse-btn"
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? '\u25B6' : '\u25C0'}
          </button>
        </div>

        <div className="sidebar-folders">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleFolderDragEnd}>
            <SortableContext items={sortedFolders.map(f => f.id)} strategy={verticalListSortingStrategy}>
              {sortedFolders.map(folder => (
                <SortableFolderGroup key={folder.id} folder={folder} />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        <div className="sidebar-add-folder">
          <button
            className="add-folder-btn"
            onClick={() => dispatch({ type: 'OPEN_FOLDER_BROWSER' })}
          >
            <span className="font-mono" style={{ fontSize: '12px' }}>+</span>
            <span className="font-mono" style={{ fontSize: '12px' }}>Add Folder</span>
          </button>
        </div>

      </aside>

      {editingFolderId && (() => {
        const folder = folders.find(f => f.id === editingFolderId)
        return folder ? (
          <ProjectEditModal
            folder={folder}
            onClose={() => dispatch({ type: 'CLOSE_PROJECT_EDIT' })}
          />
        ) : null
      })()}

      {showFolderBrowser && (
        <FolderBrowserModal
          rootFolder={settings.rootFolder}
          onClose={() => dispatch({ type: 'CLOSE_FOLDER_BROWSER' })}
          onSelect={async (path) => {
            dispatch({ type: 'CLOSE_FOLDER_BROWSER' })
            try {
              const folder = await (await import('../api')).api.createFolder({ path, name: path.replace(/^.*[\\/]/, '') })
              dispatch({ type: 'ADD_FOLDER', payload: folder })
            } catch (err) {
              console.error('Failed to create folder:', err)
            }
          }}
        />
      )}
    </>
  )
}
