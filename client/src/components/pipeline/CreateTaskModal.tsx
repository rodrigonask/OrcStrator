import { useState, useCallback, useRef } from 'react'
import type { PipelineColumn, TaskAttachment } from '@shared/types'
import { PIPELINE_COLUMNS } from '@shared/constants'
import { rest } from '../../api/rest'

interface CreateTaskModalProps {
  projectId: string
  onClose: () => void
}

export function CreateTaskModal({ projectId, onClose }: CreateTaskModalProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [column, setColumn] = useState<PipelineColumn>('backlog')
  const [priority, setPriority] = useState<1 | 2 | 3 | 4>(3)
  const [labelInput, setLabelInput] = useState('')
  const [labels, setLabels] = useState<string[]>([])
  const [attachments, setAttachments] = useState<TaskAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
      await rest.createTask(projectId, {
        title: title.trim(),
        description,
        column,
        priority,
        labels,
        attachments,
      })
    } catch (err) {
      console.error('Failed to create task:', err)
    }
    onClose()
  }, [projectId, title, description, column, priority, labels, attachments, onClose])

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
          <span className="input-hint" style={{ marginRight: 'auto', alignSelf: 'center' }}>Ctrl+Enter to save</span>
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
