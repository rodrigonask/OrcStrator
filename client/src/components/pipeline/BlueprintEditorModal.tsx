import { useState, useEffect, useCallback } from 'react'
import type { PipelineBlueprint, BlueprintStep } from '@shared/types'
import { api } from '../../api'
import { useAgentNames } from '../../hooks/useAgentNames'

const ROLES = ['planner', 'builder', 'tester', 'promoter', 'scheduler'] as const
const MAX_STEPS = 7

interface BlueprintEditorModalProps {
  onClose: () => void
}

export function BlueprintEditorModal({ onClose }: BlueprintEditorModalProps) {
  const agentNames = useAgentNames()
  const [blueprints, setBlueprints] = useState<PipelineBlueprint[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editSteps, setEditSteps] = useState<BlueprintStep[]>([])
  const [editIsDefault, setEditIsDefault] = useState(false)
  const [error, setError] = useState('')

  const fetchBlueprints = useCallback(async () => {
    try {
      const bps = await api.getBlueprints()
      setBlueprints(bps)
      if (!selectedId && bps.length > 0) {
        selectBlueprint(bps[0])
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }, [selectedId])

  useEffect(() => { fetchBlueprints() }, [])

  function selectBlueprint(bp: PipelineBlueprint) {
    setSelectedId(bp.id)
    setEditName(bp.name)
    setEditSteps([...bp.steps])
    setEditIsDefault(bp.isDefault)
    setError('')
  }

  function startNew() {
    setSelectedId(null)
    setEditName('')
    setEditSteps([{ role: 'builder' }])
    setEditIsDefault(false)
    setError('')
  }

  function addStep() {
    if (editSteps.length >= MAX_STEPS) return
    setEditSteps(prev => [...prev, { role: 'builder' }])
  }

  function removeStep(idx: number) {
    if (editSteps.length <= 1) return
    setEditSteps(prev => prev.filter((_, i) => i !== idx))
  }

  function updateStep(idx: number, updates: Partial<BlueprintStep>) {
    setEditSteps(prev => prev.map((s, i) => i === idx ? { ...s, ...updates } : s))
  }

  function moveStep(idx: number, direction: -1 | 1) {
    const newIdx = idx + direction
    if (newIdx < 0 || newIdx >= editSteps.length) return
    setEditSteps(prev => {
      const copy = [...prev]
      ;[copy[idx], copy[newIdx]] = [copy[newIdx], copy[idx]]
      return copy
    })
  }

  async function handleSave() {
    if (!editName.trim()) { setError('Name is required'); return }
    if (editSteps.length === 0) { setError('At least one step is required'); return }
    setError('')
    try {
      if (selectedId) {
        await api.updateBlueprint(selectedId, { name: editName.trim(), steps: editSteps, isDefault: editIsDefault })
      } else {
        const created = await api.createBlueprint({ name: editName.trim(), steps: editSteps, isDefault: editIsDefault })
        setSelectedId(created.id)
      }
      await fetchBlueprints()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleDelete() {
    if (!selectedId) return
    try {
      await api.deleteBlueprint(selectedId)
      setSelectedId(null)
      await fetchBlueprints()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" style={{ maxWidth: 680, width: '90vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>Pipeline Blueprints</span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', gap: 16, minHeight: 300 }}>
          {/* Left panel: blueprint list */}
          <div style={{ minWidth: 160, borderRight: '1px solid var(--border)', paddingRight: 12 }}>
            {blueprints.map(bp => (
              <button
                key={bp.id}
                className={`btn btn-sm${selectedId === bp.id ? ' btn-primary' : ''}`}
                style={{ display: 'block', width: '100%', marginBottom: 4, fontFamily: 'var(--font-mono)', fontSize: 11, textAlign: 'left' }}
                onClick={() => selectBlueprint(bp)}
              >
                {bp.name}{bp.isDefault ? ' *' : ''}
                <span style={{ float: 'right', opacity: 0.5 }}>{bp.steps.length}s</span>
              </button>
            ))}
            <button
              className="btn btn-sm"
              style={{ display: 'block', width: '100%', marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 11 }}
              onClick={startNew}
            >
              + New Blueprint
            </button>
          </div>

          {/* Right panel: editor */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Name</label>
              <input
                className="form-input"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                placeholder="Blueprint name"
              />
            </div>

            <label style={{ fontSize: 11, fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={editIsDefault} onChange={e => setEditIsDefault(e.target.checked)} />
              Default blueprint
            </label>

            <div className="form-group">
              <label className="form-label">Steps ({editSteps.length}/{MAX_STEPS})</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {editSteps.map((step, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, minWidth: 20, color: 'var(--text-secondary)' }}>
                      {idx + 1}.
                    </span>
                    <select
                      className="form-select"
                      style={{ width: 110, fontSize: 11 }}
                      value={step.role}
                      onChange={e => updateStep(idx, { role: e.target.value })}
                    >
                      {ROLES.map(r => <option key={r} value={r}>{agentNames[r] || r}</option>)}
                    </select>
                    <input
                      className="form-input"
                      style={{ flex: 1, fontSize: 11 }}
                      placeholder="instruction (optional)"
                      value={step.instruction || ''}
                      onChange={e => updateStep(idx, { instruction: e.target.value || undefined })}
                    />
                    <button
                      className="btn btn-sm"
                      style={{ fontSize: 10, padding: '2px 4px' }}
                      disabled={idx === 0}
                      onClick={() => moveStep(idx, -1)}
                      title="Move up"
                    >
                      ^
                    </button>
                    <button
                      className="btn btn-sm"
                      style={{ fontSize: 10, padding: '2px 4px' }}
                      disabled={idx === editSteps.length - 1}
                      onClick={() => moveStep(idx, 1)}
                      title="Move down"
                    >
                      v
                    </button>
                    <button
                      className="btn btn-sm"
                      style={{ fontSize: 10, padding: '2px 4px', color: '#ef4444' }}
                      disabled={editSteps.length <= 1}
                      onClick={() => removeStep(idx)}
                      title="Remove step"
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
              {editSteps.length < MAX_STEPS && (
                <button
                  className="btn btn-sm"
                  style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 11 }}
                  onClick={addStep}
                >
                  + Add Step
                </button>
              )}
            </div>

            {error && (
              <div style={{ color: '#ef4444', fontSize: 11, fontFamily: 'var(--font-mono)' }}>{error}</div>
            )}
          </div>
        </div>
        <div className="modal-footer">
          {selectedId && (
            <button
              className="btn"
              style={{ color: '#ef4444', marginRight: 'auto' }}
              onClick={handleDelete}
            >
              Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={handleSave}>
            {selectedId ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
