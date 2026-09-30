import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useInstancesSelector, type InstancesContextValue } from '../context/InstancesContext'
import { shallowEqual } from '../context/store'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'
import { DEFAULT_MODEL_ID } from '@shared/constants'
import { FolderGroup } from './FolderGroup'
import { FolderBrowserModal } from './FolderBrowserModal'
import { ProjectEditModal } from './ProjectEditModal'
import { InstanceItem } from './InstanceItem'
import { PlanLimitsWidget } from './PlanLimitsWidget'
import { UsageRail } from './UsageRail'
import { usePinnedChats } from '../hooks/usePinnedChats'
import { useGoHome } from '../hooks/useGoHome'

import type { FolderConfig, InstanceConfig } from '@shared/types'

interface FolderTreeNode {
  folder: FolderConfig
  children: FolderTreeNode[]
}

function buildFolderTree(folders: FolderConfig[]): FolderTreeNode[] {
  const normalize = (p: string | null | undefined) => (p ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')

  // Sort by path length so parents come before children
  const sorted = [...folders].sort((a, b) => (a.path ?? '').length - (b.path ?? '').length)

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
    <div ref={setNodeRef} className="folder-sortable" style={style}>
      <FolderGroup folder={node.folder} childNodes={node.children} depth={0} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  )
}

/**
 * @param railToggle Ultra Compact only. When given, the sidebar grows its own
 *   collapse/expand button at the top. The mode's other control cluster is the rail on
 *   the OPPOSITE edge of the screen, and putting the left sidebar's toggle over there
 *   meant a full-width mouse trip to move a panel you were already looking at. The
 *   button that changes this panel now lives on this panel.
 */
export function Sidebar({ collapsed, railToggle }: { collapsed: boolean; railToggle?: () => void }) {
  // Folders and the pinned rows only: a running chat's progress does not re-render the whole
  // project tree.
  const folders = useInstancesSelector(s => s.folders)
  const { editingFolderId, showFolderBrowser, settings } = useUI()
  const { dispatch } = useAppDispatch()
  const goHome = useGoHome()
  const { pinnedIds } = usePinnedChats()
  const selectPinned = useCallback(
    (s: InstancesContextValue) => pinnedIds.map(id => s.instances.find(i => i.id === id)).filter((i): i is InstanceConfig => !!i),
    [pinnedIds],
  )
  const pinnedInstances = useInstancesSelector(selectPinned, shallowEqual)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // Hidden projects stay in state (their chats, cards and routines are all still there) and
  // are only left out of the tree. They are listed, with an Unhide, under the tree.
  const hiddenFolders = folders.filter(f => f.hidden)
  const [showHidden, setShowHidden] = useState(false)
  // Hiding makes a project vanish from the tree; opening the list at that moment shows where it
  // went, so a first-time user does not think it was deleted.
  // Only a project that was VISIBLE a moment ago and is hidden now opens the list: the first load
  // of the app also takes the hidden count from 0 to N, and that must not pop it open every time.
  const visibleIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (hiddenFolders.some(f => visibleIdsRef.current.has(f.id))) setShowHidden(true)
    visibleIdsRef.current = new Set(folders.filter(f => !f.hidden).map(f => f.id))
  }, [folders, hiddenFolders])

  const sortedFolders = [...folders].filter(f => !f.hidden).sort((a, b) => {
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
        {railToggle && (
          <div className="sidebar-rail-head">
            {/* Ultra Compact has no top bar, so this is where the app's name lives while
                the mode is on. The mark alone in the 32px strip, mark plus wordmark once
                expanded, and it clicks home in both, exactly like the bar's brand. */}
            {/* Not .sidebar-title: that class is display:none under any .collapsed
                sidebar, which is precisely the state this button has to survive. */}
            <button
              className="sidebar-rail-brand"
              title="Home: mission control grid"
              onClick={goHome}
            >
              <span className="orc-logo" />
              <span className="sidebar-wordmark font-pixel">OrcStrator</span>
            </button>
            <button
              className="sidebar-nav-btn rail-collapse"
              onClick={railToggle}
              title={collapsed ? 'Show the projects sidebar' : 'Collapse the projects sidebar'}
            >
              {collapsed ? '▶' : '◀'}
            </button>
          </div>
        )}

        {/* Plan limits as three rings, directly under the chevron. Only in the strip:
            expanded, the full PlanLimitsWidget above says the same thing in words. */}
        {railToggle && collapsed && <UsageRail />}

        {!collapsed && (
          <div className="sidebar-plan-limits">
            <PlanLimitsWidget />
          </div>
        )}

        {pinnedInstances.length > 0 && (
          <div className="sidebar-pinned">
            <div className="sidebar-pinned-label">Pinned</div>
            {pinnedInstances.map(inst => (
              <InstanceItem key={inst.id} instance={inst} />
            ))}
          </div>
        )}

        <div className="sidebar-folders">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleFolderDragEnd}>
            <SortableContext items={folderTree.map(n => n.folder.id)} strategy={verticalListSortingStrategy}>
              {folderTree.map(node => (
                <SortableFolderGroup key={node.folder.id} node={node} />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        {!collapsed && hiddenFolders.length > 0 && (
          <div className="sidebar-hidden-projects">
            <button
              className="sidebar-hidden-toggle"
              onClick={() => setShowHidden(v => !v)}
              title="Projects you hid. Nothing in them was deleted."
            >
              {showHidden ? '\u25BE' : '\u25B8'} Hidden projects ({hiddenFolders.length})
            </button>
            {showHidden && hiddenFolders.map(f => (
              <div key={f.id} className="sidebar-hidden-row">
                {/* Two hidden projects can share a name; the folder tells them apart. */}
                <span className="sidebar-hidden-name" title={f.path}>
                  {f.emoji || '\uD83D\uDCC1'} {f.displayName || f.name}
                  {hiddenFolders.some(o => o.id !== f.id && (o.displayName || o.name) === (f.displayName || f.name)) && (
                    <span className="sidebar-hidden-path"> {(f.path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()}</span>
                  )}
                </span>
                <button
                  className="sidebar-hidden-unhide"
                  onClick={async () => {
                    try {
                      await api.unhideFolder(f.id)
                      dispatch({ type: 'UPDATE_FOLDER', payload: { id: f.id, updates: { hidden: false } } })
                    } catch (err) {
                      console.error('Failed to unhide project:', err)
                    }
                  }}
                >
                  Unhide
                </button>
              </div>
            ))}
          </div>
        )}


        <div className="sidebar-add-folder">
          <button
            className="add-folder-btn"
            onClick={() => dispatch({ type: 'OPEN_FOLDER_BROWSER' })}
          >
            <span className="font-mono" style={{ fontSize: '11px' }}>Add Existing</span>
          </button>
          <button
            className="add-folder-btn"
            onClick={async () => {
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
                  flags: [`--model=${DEFAULT_MODEL_ID}`],
                })
              } catch (err) {
                console.error('Failed to create new project instance:', err)
              }
            }}
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
            // Adding a folder that is already a HIDDEN project brings that project back, with its
            // cards and chats, instead of failing: the server refuses a second project for one folder.
            // Case is ignored only for Windows-style paths (a drive letter); POSIX paths are case-sensitive.
            const norm = (x: string) => {
              const n = x.replace(/\\/g, '/').replace(/\/+$/, '')
              return /^[a-zA-Z]:\//.test(n) ? n.toLowerCase() : n
            }
            const sameFolder = (a: string, b: string) => norm(a) === norm(b)
            const existing = folders.find(f => f.path && sameFolder(f.path, path))
            if (existing) {
              if (existing.hidden) {
                api.unhideFolder(existing.id).catch(console.error)
                dispatch({ type: 'UPDATE_FOLDER', payload: { id: existing.id, updates: { hidden: false } } })
              }
              return
            }
            try {
              const result = await api.createFolderOrFindOwner({ path, name: path.replace(/^.*[\\/]/, '') })
              if ('folder' in result) {
                dispatch({ type: 'ADD_FOLDER', payload: result.folder })
              } else if (result.hidden) {
                // Another spelling of a hidden project's folder: bring that project back.
                await api.unhideFolder(result.ownerId)
                dispatch({ type: 'UPDATE_FOLDER', payload: { id: result.ownerId, updates: { hidden: false } } })
              }
            } catch (err) {
              console.error('Failed to create folder:', err)
            }
          }}
        />
      )}
    </>
  )
}
