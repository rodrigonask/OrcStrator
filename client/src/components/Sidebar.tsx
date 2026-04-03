import { useState, useCallback } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useInstances } from '../context/InstancesContext'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useFeatureGate } from '../hooks/useFeatureGate'
import { api } from '../api'
import { ConnectionStatus } from './ConnectionStatus'
import { FolderGroup } from './FolderGroup'
import { FolderBrowserModal } from './FolderBrowserModal'
import { ProjectEditModal } from './ProjectEditModal'
import { FeatureLockedModal } from './tour/FeatureLockedModal'

import type { FolderConfig } from '@shared/types'

interface FolderTreeNode {
  folder: FolderConfig
  children: FolderTreeNode[]
}

function buildFolderTree(folders: FolderConfig[]): FolderTreeNode[] {
  const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')

  // Sort by path length so parents come before children
  const sorted = [...folders].sort((a, b) => a.path.length - b.path.length)

  const nodes: FolderTreeNode[] = []

  const findParent = (roots: FolderTreeNode[], normalPath: string): FolderTreeNode | null => {
    for (const node of roots) {
      const nodePath = normalize(node.folder.path)
      if (normalPath.startsWith(nodePath + '/') && normalPath !== nodePath) {
        const deeper = findParent(node.children, normalPath)
        return deeper || node
      }
    }
    return null
  }

  for (const folder of sorted) {
    const newNode: FolderTreeNode = { folder, children: [] }
    const parent = findParent(nodes, normalize(folder.path))
    if (parent) {
      parent.children.push(newNode)
    } else {
      nodes.push(newNode)
    }
  }

  return nodes
}

function SortableFolderGroup({ node }: { node: FolderTreeNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: node.folder.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <div ref={setNodeRef} style={style}>
      <FolderGroup folder={node.folder} childNodes={node.children} depth={0} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  )
}

export function Sidebar() {
  const { folders } = useInstances()
  const { editingFolderId, showFolderBrowser, settings } = useUI()
  const { dispatch } = useAppDispatch()
  const multiProjectGate = useFeatureGate('multi-project')
  const createProjectGate = useFeatureGate('create-project')
  const [collapsed, setCollapsed] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const sortedFolders = [...folders].sort((a, b) => {
    if (a.stealthMode && !b.stealthMode) return -1
    if (!a.stealthMode && b.stealthMode) return 1
    return a.sortOrder - b.sortOrder
  })

  const folderTree = buildFolderTree(sortedFolders)

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
            <div className="orc-logo" />
            <button
              className="sidebar-title"
              onClick={() => {
                dispatch({ type: 'SELECT_INSTANCE', payload: null })
                dispatch({ type: 'SET_VIEW', payload: 'chat' })
              }}
            >
              <span className="font-pixel" style={{ fontSize: '10px' }}>OrcStrator</span>
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

        <div className="sidebar-folders" data-tour-id="tour-projects">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleFolderDragEnd}>
            <SortableContext items={folderTree.map(n => n.folder.id)} strategy={verticalListSortingStrategy}>
              {folderTree.map(node => (
                <SortableFolderGroup key={node.folder.id} node={node} />
              ))}
            </SortableContext>
          </DndContext>
        </div>


        <div className="sidebar-add-folder" style={{ display: 'flex', gap: 4, padding: '8px 8px' }}>
          <button
            className="add-folder-btn"
            data-tour-id="tour-add-project"
            onClick={() => { if (multiProjectGate.check()) dispatch({ type: 'OPEN_FOLDER_BROWSER' }) }}
            style={{ flex: 1 }}
          >
            <span className="font-mono" style={{ fontSize: '11px' }}>Add Existing</span>
          </button>
          <button
            className="add-folder-btn"
            onClick={async () => {
              if (!createProjectGate.check()) return
              const root = settings.rootFolder
              if (!root) {
                dispatch({ type: 'OPEN_FOLDER_BROWSER' })
                return
              }
              const parentFolderId = folders[0]?.id
              if (!parentFolderId) {
                dispatch({ type: 'OPEN_FOLDER_BROWSER' })
                return
              }
              try {
                const inst = await api.createInstance({
                  folderId: parentFolderId,
                  name: 'New Project',
                  cwd: root,
                })
                dispatch({ type: 'ADD_INSTANCE', payload: inst })
                dispatch({ type: 'SELECT_INSTANCE', payload: inst.id })
                dispatch({ type: 'SET_VIEW', payload: 'chat' })
                api.sendMessage(inst.id, {
                  text: 'I want to create a new project in this directory. Ask me what kind of project I want to build, help me pick a name, then create the folder and scaffold it step by step.',
                  flags: ['--model=claude-opus-4-6'],
                })
              } catch (err) {
                console.error('Failed to create new project instance:', err)
              }
            }}
            style={{ flex: 1 }}
          >
            <span className="font-mono" style={{ fontSize: '11px' }}>Scaffold New</span>
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

      {multiProjectGate.showLockedModal && multiProjectGate.gate && (
        <FeatureLockedModal gate={multiProjectGate.gate} onClose={multiProjectGate.dismissModal} />
      )}
      {createProjectGate.showLockedModal && createProjectGate.gate && (
        <FeatureLockedModal gate={createProjectGate.gate} onClose={createProjectGate.dismissModal} />
      )}
    </>
  )
}
