// The right-click menu for a pipeline task card, shared by BOTH boards.
//
// It used to be inline in PipelineBoard, so the all-projects board had no menu at all:
// right-clicking a card there fell through to Chrome's own page menu, and Start, Move to,
// Stuck, Pause, Priority and Delete were reachable only after switching to the project.
//
// Every action is scoped to `task.projectId`, never to the active pipeline: the
// all-projects board has no active project (the sentinel id is not a real one), so an
// action resolved against it would 404 in silence.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PipelineTask, PipelineColumn, InstanceConfig } from '@shared/types'
import { PIPELINE_COLUMNS, DEFAULT_COLUMN_LABELS } from '@shared/constants'
import { usePipeline } from '../../context/PipelineContext'
import { useUI } from '../../context/UIContext'
import { useInstances } from '../../context/InstancesContext'
import { useOpenInstance } from '../../hooks/useOpenInstance'
import { useConfirm } from '../ConfirmModal'
import { rest } from '../../api'

/** Where the menu was opened, and on what. Null means no menu. */
export interface TaskMenuAnchor {
  x: number
  y: number
  task: PipelineTask
}

interface TaskContextMenuProps {
  anchor: TaskMenuAnchor
  onClose: () => void
}

export function TaskContextMenu({ anchor, onClose }: TaskContextMenuProps) {
  const t = anchor.task
  const { settings } = useUI()
  const { instances } = useInstances()
  const pipeline = usePipeline()
  const openInstance = useOpenInstance()
  const { confirm, alert } = useConfirm()
  const [subMenu, setSubMenu] = useState<'priority' | 'move' | 'start' | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const columnLabels = { ...DEFAULT_COLUMN_LABELS, ...(settings.columnLabels || {}) }

  // Keep the menu inside the viewport. Portalled to document.body (below), so clientX/Y
  // and position: fixed are both plain viewport pixels and no scale conversion is needed:
  // the old hand-rolled clamp existed only because the menu rendered inside .app, whose
  // zoom transform made it the containing block for position: fixed.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    let { x, y } = anchor
    if (x + rect.width > window.innerWidth - pad) x = Math.max(pad, window.innerWidth - rect.width - pad)
    if (y + rect.height > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - rect.height - pad)
    if (x !== anchor.x || y !== anchor.y) {
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }, [anchor])

  // Close on mousedown outside or Escape. Outside is decided by DOM containment rather
  // than by a React handler stopping propagation, because the menu is portalled and a
  // portal's synthetic events do not travel the same path as its native ones.
  useEffect(() => {
    const downHandler = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      onClose()
    }
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', downHandler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('mousedown', downHandler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [onClose])

  // Right-click Start. Mirrors the card's arrow button: a task already linked to an
  // instance opens that instance instead of starting a second one. A failure has to be
  // visible here, because the menu closes on click and a silently swallowed 409 (busy
  // instance) is indistinguishable from the click never registering.
  // Start and stay. Starting a task from the board does NOT navigate: the card shows
  // the run and you keep your place. Going to the instance is a separate, explicit menu
  // item, because those are two different intentions and only one of them is "leave".
  const handleStart = useCallback(async (instanceId?: string) => {
    onClose()
    try {
      await pipeline.startTask(t.id, instanceId, t.projectId)
    } catch (err) {
      await alert(err instanceof Error ? err.message : 'Failed to start task', 'Could not start')
    }
  }, [pipeline, alert, onClose, t])

  const handleOpenInstance = useCallback((inst: InstanceConfig) => {
    onClose()
    openInstance(inst)
  }, [openInstance, onClose])

  const handleMoveTo = useCallback((column: PipelineColumn) => {
    onClose()
    if (t.column === column) return
    pipeline.moveTask(t.id, column, t.projectId)
  }, [pipeline, onClose, t])

  const handleToggleLabel = useCallback((label: string) => {
    const has = t.labels.includes(label)
    const newLabels = has ? t.labels.filter(l => l !== label) : [...t.labels, label]
    pipeline.updateTask(t.id, { labels: newLabels }, t.projectId)
    onClose()
  }, [pipeline, onClose, t])

  const handleSetPriority = useCallback((p: PipelineTask['priority']) => {
    pipeline.updateTask(t.id, { priority: p }, t.projectId)
    onClose()
  }, [pipeline, onClose, t])

  // RUN NOW, which is not the same thing as Start.
  //
  // Start opens a chat and sends the card as a prompt, by hand, once. Run now fires the
  // SCHEDULE: the same prompt, the same target chat, the same fallback, recorded in the
  // card's run history so the result sits next to every automatic run. It is how somebody
  // finds out whether tonight's routine is going to work without waiting until tonight,
  // which is why it exists at all and why it is next to Start rather than buried.
  //
  // It does NOT consume the scheduled slot, and the run is recorded with kind='manual' so
  // it stays out of the failure ledger: three failed attempts at a prompt still being
  // written must not switch the schedule off underneath the person writing it.
  const [running, setRunning] = useState(false)
  const handleRunNow = useCallback(async () => {
    if (running) return
    setRunning(true)
    try {
      await rest.runTaskNow(t.projectId, t.id)
      onClose()
    } catch (err) {
      // The refusals are the interesting outcomes here and every one of them is a sentence
      // the server already wrote: the chat is busy, the chat is gone, the card has no
      // schedule. Swallowing them would make a click that did nothing look identical to a
      // click that did not register.
      onClose()
      await alert(err instanceof Error ? err.message : 'Could not run this card', 'Not run')
    } finally {
      setRunning(false)
    }
  }, [running, alert, onClose, t])

  const handleDelete = useCallback(async () => {
    const ok = await confirm(`Delete task "${t.title}"?`)
    if (!ok) return
    await pipeline.deleteTask(t.id, t.projectId)
    onClose()
  }, [pipeline, confirm, onClose, t])

  const isStuck = t.labels.includes('stuck')
  const isPaused = t.labels.includes('paused')
  const linked = t.instanceId ? instances.find(i => i.id === t.instanceId) : undefined
  const idle = instances.filter(i => i.folderId === t.projectId && i.state === 'idle' && i.id !== t.instanceId)

  // Portalled to document.body, like every other menu on the board: the zoom transform
  // on .app captures position: fixed, which both mispositions the menu and makes it
  // inflate the scroller it renders inside. Out of the tree, fixed means the viewport
  // again.
  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      style={{ top: anchor.y, left: anchor.x }}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      {/* Start, or open the instance this task is already running on */}
      {linked && (
        <button className="context-menu-item" onClick={() => handleOpenInstance(linked)}>
          Open {linked.name} in Grid
        </button>
      )}
      {!linked && (
        <button className="context-menu-item" onClick={() => void handleStart()}>
          Start new instance
        </button>
      )}
      {!linked && idle.length > 0 && (
        <div
          style={{ position: 'relative' }}
          onMouseEnter={() => setSubMenu('start')}
          onMouseLeave={() => setSubMenu(s => s === 'start' ? null : s)}
        >
          <button className="context-menu-item">
            Start on <span className="submenu-arrow">&#9656;</span>
          </button>
          {subMenu === 'start' && (
            <div className="context-menu context-menu-sub" onMouseDown={e => e.stopPropagation()}>
              {idle.map(i => (
                <button
                  key={i.id}
                  className="context-menu-item"
                  onClick={() => void handleStart(i.id)}
                >
                  {i.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Run the SCHEDULE now, on a card that has one. Hidden entirely on a card with no
          schedule, where it would mean nothing. */}
      {t.scheduleKind && (
        <button className="context-menu-item" onClick={() => void handleRunNow()} disabled={running}>
          {running ? 'Running…' : 'Run now'}
        </button>
      )}

      {/* Move to another column */}
      <div
        style={{ position: 'relative' }}
        onMouseEnter={() => setSubMenu('move')}
        onMouseLeave={() => setSubMenu(s => s === 'move' ? null : s)}
      >
        <button className="context-menu-item">
          Move to <span className="submenu-arrow">&#9656;</span>
        </button>
        {subMenu === 'move' && (
          <div className="context-menu context-menu-sub" onMouseDown={e => e.stopPropagation()}>
            {PIPELINE_COLUMNS.map(c => (
              <button
                key={c}
                className={`context-menu-item${t.column === c ? ' active' : ''}`}
                onClick={() => handleMoveTo(c)}
              >
                {columnLabels[c] || c} {t.column === c ? '✓' : ''}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="context-menu-separator" />

      {/* Stuck toggle */}
      <button className="context-menu-item" onClick={() => handleToggleLabel('stuck')}>
        {isStuck ? 'Unstuck' : 'Mark Stuck'}
      </button>

      {/* Pause toggle */}
      <button className="context-menu-item" onClick={() => handleToggleLabel('paused')}>
        {isPaused ? 'Unpause' : 'Pause'}
      </button>

      {/* Priority submenu */}
      <div
        style={{ position: 'relative' }}
        onMouseEnter={() => setSubMenu('priority')}
        onMouseLeave={() => setSubMenu(s => s === 'priority' ? null : s)}
      >
        <button className="context-menu-item">
          Priority <span className="submenu-arrow">&#9656;</span>
        </button>
        {subMenu === 'priority' && (
          <div className="context-menu context-menu-sub" onMouseDown={e => e.stopPropagation()}>
            {([1, 2, 3, 4] as const).map(p => (
              <button
                key={p}
                className={`context-menu-item${t.priority === p ? ' active' : ''}`}
                onClick={() => handleSetPriority(p)}
              >
                P{p} {t.priority === p ? '✓' : ''}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="context-menu-separator" />
      <button className="context-menu-item danger" onClick={() => void handleDelete()}>
        Delete task
      </button>
    </div>,
    document.body
  )
}
