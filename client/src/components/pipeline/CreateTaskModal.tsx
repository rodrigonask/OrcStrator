import { useState, useCallback, useRef, useEffect } from 'react'
import type { PipelineColumn, PipelineBlueprint, TaskAttachment } from '@shared/types'
import { DEFAULT_COLUMN_LABELS } from '@shared/constants'
import { rest } from '../../api/rest'
import { useAgentNames } from '../../hooks/useAgentNames'

const ALLOWED_COLUMNS: PipelineColumn[] = ['backlog', 'ready', 'scheduled']

interface CreateTaskModalProps {
  projectId: string
  onClose: () => void
}

export function CreateTaskModal({ projectId, onClose }: CreateTaskModalProps) {
  const agentNames = useAgentNames()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [column, setColumn] = useState<PipelineColumn>('backlog')
  const [priority, setPriority] = useState<1 | 2 | 3 | 4>(3)
  const [labelInput, setLabelInput] = useState('')
  const [labels, setLabels] = useState<string[]>([])
  const [attachments, setAttachments] = useState<TaskAttachment[]>([])
  const [skill, setSkill] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Blueprint selection
  const [blueprints, setBlueprints] = useState<PipelineBlueprint[]>([])
  const [selectedBlueprintId, setSelectedBlueprintId] = useState<string>('')
  const [stepInstructions, setStepInstructions] = useState<Record<string, string>>({})
  const [showSteps, setShowSteps] = useState(false)

  useEffect(() => {
    rest.getBlueprints().then(bps => {
      setBlueprints(bps)
      const defaultBp = bps.find(b => b.isDefault)
      if (defaultBp) setSelectedBlueprintId(defaultBp.id)
    }).catch(console.error)
  }, [])

  const selectedBlueprint = blueprints.find(b => b.id === selectedBlueprintId)

  const addLabel = useCallback(() => {
    const trimmed = labelInput.trim()
    if (trimmed && !labels.includes(trimmed)) {
      setLabels(l => [...l, trimmed])
    }
    setLabelInput('')
  }, [labelInput, labels])

  const removeLabel = useCallback((label: string) => {
    setLabels(l => l.filter(lb => lb !== label))
  }, [])

  const readFileAsDataUrl = (file: File): Promise<TaskAttachment> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve({
        id: crypto.randomUUID(),
        name: file.name,
        dataUrl: reader.result as string,
      })
      reader.onerror = reject
      reader.readAsDataURL(file)
    })

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/') && f.size <= 10 * 1024 * 1024)
    if (imageFiles.length === 0) return
    const newAttachments = await Promise.all(imageFiles.map(readFileAsDataUrl))
    setAttachments(prev => [...prev, ...newAttachments])
  }, [])

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const imageFiles: File[] = []
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length > 0) await addFiles(imageFiles)
  }, [addFiles])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    await addFiles(e.dataTransfer.files)
  }, [addFiles])

  const handleFileInput = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) await addFiles(e.target.files)
    e.target.value = ''
  }, [addFiles])

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  const handleSave = useCallback(async () => {
    if (!title.trim()) return
    try {
      const hasInstructions = Object.values(stepInstructions).some(v => v.trim())
      await rest.createTask(projectId, {
        title: title.trim(),
        description,
        column,
        priority,
        labels,
        attachments,
        skill: skill.trim() || undefined,
        pipelineId: selectedBlueprintId || undefined,
        stepInstructions: hasInstructions ? stepInstructions : undefined,
      } as any)
    } catch (err) {
      console.error('Failed to create task:', err)
    }
    onClose()
  }, [projectId, title, description, column, priority, labels, attachments, skill, selectedBlueprintId, stepInstructions, onClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSave()
    }
  }, [handleSave])

  return (
    <div className="modal-overlay create-task-modal" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()} onPaste={handlePaste} onKeyDown={handleKeyDown}>
        <div className="modal-header">
          <span className="modal-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>Create Task</span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body">
          {/* Title */}
          <div className="form-group">
            <label className="form-label">Title</label>
            <input
              className="form-input"
              placeholder="Task title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          {/* Description */}
          <div className="form-group">
            <label className="form-label">Description</label>
            <textarea
              className="form-textarea"
              placeholder="Describe the task (markdown supported)"
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={4}
            />
          </div>

          {/* Screenshots drop zone */}
          <div className="form-group">
            <label className="form-label">Screenshots</label>
            <div
              className={`screenshot-dropzone${isDragOver ? ' screenshot-dropzone--active' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              {attachments.length === 0 ? (
                <span className="screenshot-dropzone-hint">
                  Drop, paste (Ctrl+V), or click to browse
                </span>
              ) : (
                <div className="screenshot-thumbs">
                  {attachments.map(a => (
                    <div key={a.id} className="screenshot-thumb">
                      <img src={a.dataUrl} alt={a.name} />
                      <button
                        className="screenshot-thumb-remove"
                        onClick={e => { e.stopPropagation(); removeAttachment(a.id) }}
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <div className="screenshot-thumb-add" title="Add more">+</div>
                </div>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileInput}
            />
          </div>

          {/* Pipeline + Column + Priority row */}
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Pipeline</label>
              <select
                className="form-select"
                value={selectedBlueprintId}
                onChange={e => {
                  setSelectedBlueprintId(e.target.value)
                  setStepInstructions({})
                }}
              >
                <option value="">None</option>
                {blueprints.map(bp => (
                  <option key={bp.id} value={bp.id}>
                    {bp.name}{bp.isDefault ? ' (default)' : ''} — {bp.steps.length} step{bp.steps.length !== 1 ? 's' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Column</label>
              <select
                className="form-select"
                value={column}
                onChange={e => setColumn(e.target.value as PipelineColumn)}
              >
                {ALLOWED_COLUMNS.map(col => (
                  <option key={col} value={col}>
                    {DEFAULT_COLUMN_LABELS[col] || col}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Priority</label>
              <select
                className="form-select"
                value={priority}
                onChange={e => setPriority(Number(e.target.value) as 1 | 2 | 3 | 4)}
              >
                <option value={1}>Urgent</option>
                <option value={2}>High</option>
                <option value={3}>Medium</option>
                <option value={4}>Low</option>
              </select>
            </div>
          </div>

          {/* Step details (expandable, only when blueprint has >1 step) */}
          {selectedBlueprint && selectedBlueprint.steps.length > 1 && (
            <div className="form-group">
              <button
                className="btn btn-sm"
                style={{ fontSize: 11, fontFamily: 'var(--font-mono)', opacity: 0.8 }}
                onClick={() => setShowSteps(!showSteps)}
              >
                {showSteps ? '▼' : '▶'} Steps ({selectedBlueprint.steps.length})
              </button>
              {showSteps && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {selectedBlueprint.steps.map((step, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, minWidth: 24, color: 'var(--text-secondary)' }}>
                        {idx + 1}.
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, minWidth: 64, color: `var(--role-${step.role})` }}>
                        {agentNames[step.role] || step.role}
                      </span>
                      <input
                        className="form-input"
                        style={{ flex: 1, fontSize: 11 }}
                        placeholder={step.instruction || 'optional instruction'}
                        value={stepInstructions[String(idx + 1)] || ''}
                        onChange={e => setStepInstructions(prev => ({ ...prev, [String(idx + 1)]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Skill (only for scheduled column) */}
          {column === 'scheduled' && (
            <div className="form-group">
              <label className="form-label">Skill</label>
              <input
                className="form-input"
                placeholder="e.g. skool-commenter, google-ads-optimizer"
                value={skill}
                onChange={e => setSkill(e.target.value)}
              />
            </div>
          )}

          {/* Labels */}
          <div className="form-group">
            <label className="form-label">Labels</label>
            <div className="label-input-container">
              {labels.map(label => (
                <span key={label} className="label-tag">
                  {label}
                  <button className="label-tag-remove" onClick={() => removeLabel(label)}>x</button>
                </span>
              ))}
              <input
                className="label-input"
                placeholder="Add label and press Enter"
                value={labelInput}
                onChange={e => setLabelInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); addLabel() }
                  if (e.key === 'Backspace' && !labelInput && labels.length > 0) {
                    setLabels(l => l.slice(0, -1))
                  }
                }}
              />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <span className="input-hint" style={{ marginRight: 'auto', alignSelf: 'center', fontFamily: 'var(--font-mono)', fontSize: 7 }}>Ctrl+Enter to save</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!title.trim()}
          >
            Create Task
          </button>
        </div>
      </div>
    </div>
  )
}
