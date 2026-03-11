import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useFeatureGate } from '../hooks/useFeatureGate'
import { FeatureLockedModal } from './tour/FeatureLockedModal'
import { api } from '../api'

interface Command {
  name: string
  description: string
  shortcut?: string
  action: () => void
}

export function CommandMenu() {
  const { folders, instances } = useInstances()
  const { dispatch } = useAppDispatch()
  const pipelineGate = useFeatureGate('pipeline')
  const multiProjectGate = useFeatureGate('multi-project')
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const commands: Command[] = useMemo(() => [
    {
      name: '/new-instance',
      description: 'Create a new Claude instance in the selected folder',
      action: () => {
        const folderId = folders[0]?.id
        if (folderId) {
          api.createInstance({ folderId }).then(instance => {
            dispatch({ type: 'ADD_INSTANCE', payload: instance })
            dispatch({ type: 'SELECT_INSTANCE', payload: instance.id })
          }).catch(console.error)
        }
      },
    },
    {
      name: '/pipeline',
      description: 'Switch to the pipeline board view',
      action: () => { if (pipelineGate.check()) dispatch({ type: 'SET_VIEW', payload: 'pipeline' }) },
    },
    {
      name: '/monitor',
      description: 'Open process monitor — view instances, kill switch',
      action: () => dispatch({ type: 'SET_VIEW', payload: 'monitor' }),
    },
    {
      name: '/chat',
      description: 'Switch back to chat view',
      action: () => dispatch({ type: 'SET_VIEW', payload: 'chat' }),
    },
    {
      name: '/settings',
      description: 'Open application settings',
      action: () => dispatch({ type: 'OPEN_SETTINGS' }),
    },
    {
      name: '/pause-all',
      description: 'Pause all running instances',
      action: () => instances.forEach(i => api.pauseInstance(i.id)),
    },
    {
      name: '/resume-all',
      description: 'Resume all paused instances',
      action: () => instances.forEach(i => api.resumeInstance(i.id)),
    },
    {
      name: '/refresh-usage',
      description: 'Force refresh usage data',
      action: () => api.refreshUsage(),
    },
    {
      name: '/add-folder',
      description: 'Add a new project',
      action: () => { if (multiProjectGate.check()) dispatch({ type: 'OPEN_FOLDER_BROWSER' }) },
    },
  ], [folders, instances, dispatch])

  const filtered = useMemo(() => {
    if (!filter) return commands
    const lower = filter.toLowerCase()
    return commands.filter(
      c => c.name.toLowerCase().includes(lower) || c.description.toLowerCase().includes(lower)
    )
  }, [commands, filter])

  // Global keyboard shortcut: Shift+Space
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Don't trigger if typing in an input/textarea
        const tag = (e.target as HTMLElement).tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        setOpen(o => !o)
      }
      if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open])

  // Focus input on open
  useEffect(() => {
    if (open) {
      setFilter('')
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  // Reset active index on filter change
  useEffect(() => {
    setActiveIndex(0)
  }, [filter])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[activeIndex]) {
        filtered[activeIndex].action()
        setOpen(false)
      }
    }
  }, [filtered, activeIndex])

  if (!open) return (
    <>
      {pipelineGate.showLockedModal && pipelineGate.gate && (
        <FeatureLockedModal gate={pipelineGate.gate} onClose={pipelineGate.dismissModal} />
      )}
      {multiProjectGate.showLockedModal && multiProjectGate.gate && (
        <FeatureLockedModal gate={multiProjectGate.gate} onClose={multiProjectGate.dismissModal} />
      )}
    </>
  )

  return (
    <>
      <div className="command-menu-overlay" onClick={() => setOpen(false)}>
        <div className="command-menu" onClick={e => e.stopPropagation()}>
          <input
            ref={inputRef}
            className="command-menu-input"
            placeholder="Type a command..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="command-menu-list">
            {filtered.map((cmd, i) => (
              <div
                key={cmd.name}
                className={`command-menu-item ${i === activeIndex ? 'active' : ''}`}
                onClick={() => {
                  cmd.action()
                  setOpen(false)
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <div>
                  <div className="command-menu-item-name" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>{cmd.name}</div>
                  <div className="command-menu-item-desc" style={{ fontFamily: 'var(--font-mono)' }}>{cmd.description}</div>
                </div>
                {cmd.shortcut && (
                  <span className="command-menu-item-shortcut" style={{ fontFamily: 'var(--font-mono)', fontSize: 7 }}>{cmd.shortcut}</span>
                )}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="command-menu-item" style={{ cursor: 'default', opacity: 0.5 }}>
                <div className="command-menu-item-desc">No matching commands</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {pipelineGate.showLockedModal && pipelineGate.gate && (
        <FeatureLockedModal gate={pipelineGate.gate} onClose={pipelineGate.dismissModal} />
      )}
      {multiProjectGate.showLockedModal && multiProjectGate.gate && (
        <FeatureLockedModal gate={multiProjectGate.gate} onClose={multiProjectGate.dismissModal} />
      )}
    </>
  )
}
