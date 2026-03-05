import { useState, useCallback } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { ConnectionStatus } from './ConnectionStatus'
import { FolderGroup } from './FolderGroup'
import { FolderBrowserModal } from './FolderBrowserModal'
import { ProjectEditModal } from './ProjectEditModal'
import { SettingsModal } from './SettingsModal'
import { LevelBar } from './tour/LevelBar'
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
  const { state, dispatch } = useApp()
  const [collapsed, setCollapsed] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const sortedFolders = [...state.folders].sort((a, b) => {
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


  const usage = state.usage
  const primaryBucket = usage?.buckets?.[0]
  const usagePercent = primaryBucket?.percentage ?? 0
  const usageLabel = primaryBucket?.label ?? 'Usage'
  const usageReset = primaryBucket?.resetCountdown

  const usageBarClass = usagePercent >= 90 ? 'danger' : usagePercent >= 70 ? 'warning' : ''

  return (
    <>
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-header-left">
            <ConnectionStatus />
            <span className="sidebar-title">NasKlaude</span>
          </div>
          <button
            className="sidebar-collapse-btn"
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? '\u25B6' : '\u25C0'}
          </button>
        </div>

        <div className="sidebar-usage">
          <div className="usage-label">
            <span>{usageLabel}</span>
            <span>{Math.round(usagePercent)}%</span>
          </div>
          <div className="usage-bar-track">
            <div
              className={`usage-bar-fill ${usageBarClass}`}
              style={{ width: `${Math.min(usagePercent, 100)}%` }}
            />
          </div>
          {usageReset && <div className="usage-reset">Resets {usageReset}</div>}
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
            <span>+</span>
            <span>Add Folder</span>
          </button>
        </div>

        <LevelBar />

        <div className="sidebar-footer">
          <button
            className="settings-btn"
            onClick={() => dispatch({ type: 'OPEN_SETTINGS' })}
          >
            <span>&#x2699;</span>
            <span className="sidebar-footer-text">Settings</span>
          </button>
        </div>
      </aside>

      {state.showSettings && <SettingsModal onClose={() => dispatch({ type: 'CLOSE_SETTINGS' })} />}

      {state.editingFolderId && (() => {
        const folder = state.folders.find(f => f.id === state.editingFolderId)
        return folder ? (
          <ProjectEditModal
            folder={folder}
            onClose={() => dispatch({ type: 'CLOSE_PROJECT_EDIT' })}
          />
        ) : null
      })()}

      {state.showFolderBrowser && (
        <FolderBrowserModal
          rootFolder={state.settings.rootFolder}
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
