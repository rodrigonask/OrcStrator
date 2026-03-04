import { useState, useCallback } from 'react'
import type { PipelineColumn } from '@shared/types'
import { PIPELINE_COLUMNS } from '@shared/constants'
import { usePipeline } from '../../context/PipelineContext'

interface CreateTaskModalProps {
  projectId: string
  onClose: () => void
}

export function CreateTaskModal({ projectId, onClose }: CreateTaskModalProps) {
  const { dispatch } = usePipeline()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [column, setColumn] = useState<PipelineColumn>('backlog')
  const [priority, setPriority] = useState<1 | 2 | 3 | 4>(3)
  const [labelInput, setLabelInput] = useState('')
  const [labels, setLabels] = useState<string[]>([])

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

  const handleSave = useCallback(() => {
    if (!title.trim()) return
    dispatch({
      type: 'CREATE_TASK',
      task: {
        projectId,
        title: title.trim(),
        description,
        column,
        priority,
        labels,
      },
    })
    onClose()
  }, [dispatch, projectId, title, description, column, priority, labels, onClose])

  return (
    <div className="modal-overlay create-task-modal" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Create Task</span>
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

          {/* Column + Priority row */}
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Column</label>
              <select
                className="form-select"
                value={column}
                onChange={e => setColumn(e.target.value as PipelineColumn)}
              >
                {PIPELINE_COLUMNS.map(col => (
                  <option key={col} value={col}>
                    {col.charAt(0).toUpperCase() + col.slice(1)}
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
