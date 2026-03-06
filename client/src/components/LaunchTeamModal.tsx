import { useState, useCallback } from 'react'
import type { FolderConfig } from '@shared/types'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'

interface LaunchTeamModalProps {
  folder: FolderConfig
  onClose: () => void
}

const ROLES = ['planner', 'builder', 'tester', 'promoter'] as const
type Role = typeof ROLES[number]

interface TeamRow {
  role: Role
  specialization: string
  include: boolean
}

export function LaunchTeamModal({ folder, onClose }: LaunchTeamModalProps) {
  const { settings } = useUI()
  const { dispatch } = useAppDispatch()
  const agentNames = settings.orchestratorAgentNames || { planner: 'Planner', builder: 'Builder', tester: 'Tester', promoter: 'Promoter' }

  const [rows, setRows] = useState<TeamRow[]>(
    ROLES.map(role => ({ role, specialization: '', include: true }))
  )
  const [spawning, setSpawning] = useState(false)

  const updateRow = useCallback((idx: number, updates: Partial<TeamRow>) => {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, ...updates } : r))
  }, [])

  const selectedCount = rows.filter(r => r.include).length

  const handleSpawn = useCallback(async () => {
    const selected = rows.filter(r => r.include)
    if (selected.length === 0) return

    setSpawning(true)
    try {
      for (const row of selected) {
        const instance = await api.createInstance({
          folderId: folder.id,
          name: agentNames[row.role],
          cwd: folder.path,
        })
        // Set role, specialization, orchestratorManaged
        const updated = await api.updateInstance(instance.id, {
          agentRole: row.role,
          specialization: row.specialization || undefined,
          orchestratorManaged: true,
        })
        dispatch({ type: 'ADD_INSTANCE', payload: updated })
      }

      if (!folder.expanded) {
        dispatch({ type: 'TOGGLE_FOLDER', folderId: folder.id })
      }
      onClose()
    } catch (err) {
      console.error('Failed to spawn team:', err)
    } finally {
      setSpawning(false)
    }
  }, [rows, folder, agentNames, dispatch, onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel launch-team-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Launch a Team</span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body">
          <p className="launch-team-subtitle">
            Spawn pre-configured agents for <strong>{folder.displayName || folder.name}</strong>. All spawned agents will be marked as Orc-managed.
          </p>

          <div className="launch-team-grid">
            <div className="launch-team-header-row">
              <span>Role</span>
              <span>Specialization</span>
              <span>Include</span>
            </div>

            {rows.map((row, idx) => (
              <div key={row.role} className={`launch-team-row ${!row.include ? 'excluded' : ''}`}>
                <div className="launch-team-role">
                  <span className={`role-pill role-${row.role}`}>
                    {agentNames[row.role]}
                  </span>
                </div>
                <div className="launch-team-spec">
                  <input
                    className="form-input"
                    placeholder="e.g. frontend, auth, infra"
                    value={row.specialization}
                    disabled={!row.include}
                    onChange={e => updateRow(idx, { specialization: e.target.value })}
                  />
                </div>
                <div className="launch-team-include">
                  <input
                    type="checkbox"
                    checked={row.include}
                    onChange={e => updateRow(idx, { include: e.target.checked })}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="launch-team-footer-note">
            <span className="spawn-disabled-note" title="Coming soon — we're teaching it responsibility first">
              [ ] Allow The Orc to spawn new agents <em>(coming soon)</em>
            </span>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSpawn}
            disabled={selectedCount === 0 || spawning}
          >
            {spawning ? 'Spawning...' : `Spawn Selected (${selectedCount})`}
          </button>
        </div>
      </div>
    </div>
  )
}
