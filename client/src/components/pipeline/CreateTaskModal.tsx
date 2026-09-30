import { useState, useCallback, useMemo, useRef } from 'react'
import type { PipelineColumn, TaskAttachment, PipelineTask } from '@shared/types'
import { DEFAULT_COLUMN_LABELS } from '@shared/constants'
import { rest } from '../../api/rest'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useSingleFlight } from '../../hooks/useSingleFlight'
import { useInstances } from '../../context/InstancesContext'
import { TaskSettings, type TaskSettingsHandle } from './TaskSettings'

const ALLOWED_COLUMNS: PipelineColumn[] = ['backlog', 'ready']

// ─────────────────────────────────────────────────────────────────────────────
// ONE modal for every card.
//
// There used to be two screens and a three-item Add menu, where two of the three items
// opened the SAME routine form seeded with a value that form already had a select for.
// A schedule is not a different kind of object any more, it is a property of a card, so
// it is a switch inside the one form: Now, Once at, or Repeating.
//
// This is the CREATE surface. Editing a saved card happens in the task detail panel,
// which mounts the same TaskSettings inline rather than stacking a second dialog on top
// of itself. The identity fields come first here and the settings after, because a card
// being captured is a title and a sentence long before it is a schedule.
// ─────────────────────────────────────────────────────────────────────────────

interface CreateTaskModalProps {
  /** Pre-selected project. The user can still retarget from inside the modal. */
  projectId: string
  /** Present = edit this card instead of creating one. Must be the FULL row: the board's
   *  light copy carries no run settings, and saving one back blanks them. */
  task?: PipelineTask
  onClose: () => void
  /** Called after a successful save, so the opener can refresh without waiting for the WS. */
  onSaved?: () => void
}

export function CreateTaskModal({ projectId, task, onClose, onSaved }: CreateTaskModalProps) {
  useEscapeKey(onClose)
  const { folders } = useInstances()
  const editing = !!task

  // Capture is meant to be fast, and the fastest capture is the one you do not have to
  // abandon. The project arrives pre-selected from wherever the modal was opened, but it
  // stays editable: hitting the hotkey while the wrong chat is focused should cost a
  // dropdown, not a cancel and a retry.
  const [targetProjectId, setTargetProjectId] = useState(task?.projectId || projectId)
  const sortedFolders = useMemo(
    () => [...folders].sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name)),
    [folders]
  )
  const [title, setTitle] = useState(task?.title || '')
  const [description, setDescription] = useState(task?.description || '')
  const [column, setColumn] = useState<PipelineColumn>(
    task && ALLOWED_COLUMNS.includes(task.column) ? task.column : 'backlog'
  )
  const [priority, setPriority] = useState<1 | 2 | 3 | 4>(task?.priority || 3)
  const [labelInput, setLabelInput] = useState('')
  const [labels, setLabels] = useState<string[]>(task?.labels || [])
  const [attachments, setAttachments] = useState<TaskAttachment[]>(task?.attachments || [])
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // The schedule and the run settings live in their own component, which the detail panel
  // mounts too. It is asked for a payload on save rather than lifting forty pieces of
  // state up here, none of which this modal has any other use for.
  const settingsRef = useRef<TaskSettingsHandle>(null)

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

  // Single-flight: Enter pressed twice before the first save returns creates ONE card.
  const handleSave = useSingleFlight(async () => {
    setError(null)
    if (!title.trim() || !targetProjectId) return
    const settings = settingsRef.current?.build()
    if (!settings) { setError('The settings did not load. Close this and try again.'); return }
    if ('error' in settings) { setError(settings.error); return }

    const body = {
      title: title.trim(),
      description,
      priority,
      labels,
      attachments,
      ...settings,
    }

    setSaving(true)
    try {
      if (editing && task) {
        await rest.updateTask(task.projectId, task.id, body)
      } else {
        await rest.createTask(targetProjectId, { ...body, column })
      }
      onSaved?.()
      onClose()
    } catch (err) {
      setError((err as Error).message || 'Save failed')
    } finally {
      setSaving(false)
    }
  })

  // Enter creates, Shift+Enter is a newline. Two carve-outs:
  // - The label input owns Enter, where it commits a chip. Submitting the whole task from
  //   there would swallow the label the user was halfway through typing.
  // - Shift+Enter must reach the description textarea untouched.
  // Ctrl+Enter still works, since it is Enter without Shift.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if ((e.target as HTMLElement)?.classList?.contains('label-input')) return
    e.preventDefault()
    handleSave()
  }, [handleSave])

  return (
    <div className="modal-overlay create-task-modal" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()} onPaste={handlePaste} onKeyDown={handleKeyDown}>
        <div className="modal-header">
          <span className="modal-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
            {editing ? 'Edit Task' : 'Create Task'}
          </span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body">
          {/* Project */}
          <div className="form-group">
            <label className="form-label">Project</label>
            <select
              className="form-select"
              value={targetProjectId}
              onChange={e => setTargetProjectId(e.target.value)}
              disabled={editing}
            >
              {sortedFolders.map(f => (
                <option key={f.id} value={f.id}>
                  {f.emoji ? `${f.emoji} ` : ''}{f.displayName || f.name}
                </option>
              ))}
            </select>
          </div>

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
            {description.trimStart().startsWith('/') && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
                Starts with a slash command, so it is sent exactly as written, with no wrapper.
              </div>
            )}
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

          {/* Column + Priority row. Column is a create-time choice: on an edit the board
              itself is how a card moves, and a select here would fight the drag. */}
          <div className="form-row">
            {!editing && (
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
            )}
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

          <TaskSettings ref={settingsRef} task={task} projectId={targetProjectId} />

          {error && (
            <div style={{ fontSize: 11, color: 'var(--danger, #f87171)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <span className="input-hint" style={{ marginRight: 'auto', alignSelf: 'center', fontFamily: 'var(--font-mono)', fontSize: 7 }}>Enter to save &middot; Shift+Enter for a new line</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || !title.trim() || !targetProjectId}
          >
            {saving ? 'Saving...' : editing ? 'Save' : 'Create Task'}
          </button>
        </div>
      </div>
    </div>
  )
}
