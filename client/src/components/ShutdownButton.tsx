import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { IconPower } from './icons'
import { useInstances } from '../context/InstancesContext'
import { api } from '../api'

/**
 * Kill the server, with the confirm it deserves. Extracted from TopBar so the
 * ultra-compact rail can offer the same control without a second copy of a modal that
 * terminates every running agent.
 */
export function ShutdownButton({ className = 'sidebar-nav-btn sidebar-nav-shutdown' }: { className?: string }) {
  const { instances } = useInstances()
  const [showShutdown, setShowShutdown] = useState(false)
  const activeAgents = instances.filter(i => i.state === 'running').length

  const handleShutdownConfirm = useCallback(async () => {
    setShowShutdown(false)
    try {
      await api.terminate()
    } catch {
      // Server unreachable after terminate — expected
    }
  }, [])

  return (
    <>
      <button className={className} onClick={() => setShowShutdown(true)} title="Shutdown">
        <IconPower />
      </button>
      {showShutdown && createPortal(
        <div className="modal-overlay" onClick={() => setShowShutdown(false)}>
          <div className="modal-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 380 }}>
            <div className="modal-header">
              <span className="modal-title">Log out and TERMINATE THE SERVER?</span>
              <button className="modal-close" onClick={() => setShowShutdown(false)}>{'×'}</button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: 8 }}>
                This will kill all sessions and shut down the OrcStrator server process. You will need to restart the server manually.
              </p>
              {activeAgents > 0 && (
                <p style={{ color: 'var(--warning)', fontSize: 13, margin: 0 }}>
                  {'⚠'} {activeAgents} agent{activeAgents !== 1 ? 's are' : ' is'} currently running.
                </p>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowShutdown(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleShutdownConfirm}>Terminate Server</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
