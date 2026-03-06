import { useState, useCallback, useEffect, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { PipelineTask, PipelineColumn, TaskComment } from '@shared/types'
import { PIPELINE_COLUMNS } from '@shared/constants'
import { usePipeline } from '../../context/PipelineContext'
import { rest } from '../../api/rest'
import { useUI } from '../../context/UIContext'
import { useInstances } from '../../context/InstancesContext'
import { useAppDispatch } from '../../context/AppDispatchContext'

marked.setOptions({ breaks: true })

function AgentLabel({ agentId }: { agentId?: string | null }) {
  const { instances } = useInstances()
  const { dispatch } = useAppDispatch()
  if (!agentId || agentId === 'system') return <span className="orc-label">The Orc</span>
  if (agentId === 'human') return <strong>human</strong>
  const instance = instances.find(i => i.id === agentId)
  const label = instance ? instance.name : agentId.slice(0, 8) + '...'
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    dispatch({ type: 'SELECT_INSTANCE', payload: agentId })
    dispatch({ type: 'SET_VIEW', payload: 'chat' })
  }
  return (
    <strong>
      <a
        href={`/?instance=${agentId}`}
        onClick={handleClick}
        title={agentId}
        style={{ color: 'inherit', textDecoration: 'underline dotted', cursor: 'pointer' }}
      >
        {label}
      </a>
    </strong>
  )
}

function renderMd(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string, {
    ALLOWED_TAGS: ['p','br','strong','em','code','pre','ul','ol','li','blockquote','h1','h2','h3','h4','h5','h6','a','s','del'],
    ALLOWED_ATTR: ['href', 'target'],
  })
}

interface TaskDetailPanelProps {
  task: PipelineTask
  onClose: () => void
}

const PRIORITY_LABELS: Record<number, string> = {
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
}

export function TaskDetailPanel({ task, onClose }: TaskDetailPanelProps) {
  const { updateTask, moveTask, claimTask, blockTask, unblockTask, deleteTask } = usePipeline()
  const { activePipelineId } = useUI()
  const { folders } = useInstances()
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [editingDesc, setEditingDesc] = useState(false)
  const [priority, setPriority] = useState(task.priority)
  const [labelInput, setLabelInput] = useState('')
  const [labels, setLabels] = useState<string[]>([...task.labels])
  const [comments, setComments] = useState<TaskComment[]>([])
  const [commentBody, setCommentBody] = useState('')
  const [postingComment, setPostingComment] = useState(false)
  const commentsEndRef = useRef<HTMLDivElement>(null)

  const projectId = activePipelineId || folders[0]?.id || ''

  useEffect(() => {
    if (!projectId) return
    rest.getTaskComments(projectId, task.id).then(setComments).catch(() => {})
  }, [projectId, task.id])

  useEffect(() => {
    commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [comments])

  const handleSave = useCallback(async () => {
    try {
      await updateTask(task.id, { title, description, priority, labels })
    } catch (err) {
      console.error('Failed to update task:', err)
    }
    onClose()
  }, [updateTask, task.id, title, description, priority, labels, onClose])

  const handleMove = useCallback(async (column: PipelineColumn) => {
    try {
      await moveTask(task.id, column)
    } catch (err) {
      console.error('Failed to move task:', err)
    }
    onClose()
  }, [moveTask, task.id, onClose])

  const handleClaim = useCallback(async (agent: string) => {
    try {
      await claimTask(task.id, agent)
    } catch (err) {
      console.error('Failed to claim task:', err)
    }
  }, [claimTask, task.id])

  const handleBlock = useCallback(async () => {
    const isBlocked = task.labels.includes('blocked')
    try {
      if (isBlocked) {
        setLabels(l => l.filter(lb => lb !== 'blocked'))
        await unblockTask(task.id)
      } else {
        setLabels(l => [...l, 'blocked'])
        await blockTask(task.id, 'Manually blocked')
      }
    } catch (err) {
      console.error('Failed to toggle block:', err)
    }
  }, [blockTask, unblockTask, task.id, task.labels])

  const handleDelete = useCallback(async () => {
    if (confirm(`Delete task "${task.title}"?`)) {
      try {
        await deleteTask(task.id)
      } catch (err) {
        console.error('Failed to delete task:', err)
      }
      onClose()
    }
  }, [deleteTask, task.id, task.title, onClose])

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

  const handleAddComment = useCallback(async () => {
    if (!commentBody.trim() || !projectId) return
    setPostingComment(true)
    try {
      const comment = await rest.addTaskComment(projectId, task.id, { author: 'human', body: commentBody.trim() })
      setComments(c => [...c, comment])
      setCommentBody('')
    } catch (err) {
      console.error('Failed to post comment:', err)
    } finally {
      setPostingComment(false)
    }
  }, [commentBody, projectId, task.id])

  const isBlocked = labels.includes('blocked')

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="task-detail-overlay">
      <div className="task-detail-backdrop" onClick={onClose} />
      <div className="task-detail-panel">
        <div className="task-detail-header">
          <span className="modal-title">Task Detail</span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <div className="task-detail-body">
          {task.column === 'staging' && task.title.startsWith('[ACTION NEEDED]') && (
            <div style={{
              background: 'rgba(245,158,11,0.12)',
              border: '1px solid rgba(245,158,11,0.4)',
              borderRadius: 8,
              padding: '12px 14px',
              marginBottom: 12,
              fontSize: 13,
            }}>
              <div style={{ fontWeight: 600, color: '#f59e0b', marginBottom: 6 }}>
                Action required from you
              </div>
              <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, color: 'var(--text-primary)' }}>
                <li>Read the agent note in the description and comments below</li>
                <li>Complete the required action (edit a file, add a credential, etc.)</li>
                <li>Add a comment confirming what you did</li>
                <li>
                  Use <strong>Move to...</strong> to route it forward:
                  <ul style={{ paddingLeft: 16, marginTop: 2 }}>
                    <li><strong>build</strong> — agent resumes implementation</li>
                    <li><strong>done</strong> — fully resolved, no further agent action</li>
                  </ul>
                </li>
              </ol>
            </div>
          )}
          {/* Title */}
          <div className="task-detail-section">
            <input
              className="task-detail-title-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Task title"
            />
          </div>

          {/* Description */}
          <div className="task-detail-section">
            <div className="task-detail-section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Description</span>
              <button
                className="btn btn-sm"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => setEditingDesc(e => !e)}
              >
                {editingDesc ? 'Preview' : 'Edit'}
              </button>
            </div>
            {editingDesc ? (
              <textarea
                className="task-detail-description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Task description (markdown supported)"
                autoFocus
              />
            ) : (
              <div
                className="task-detail-description-preview"
                dangerouslySetInnerHTML={{ __html: description ? renderMd(description) : '<p style="color:var(--text-muted)">No description yet. Click Edit to add one.</p>' }}
              />
            )}
          </div>

          {/* Meta */}
          <div className="task-detail-section">
            <div className="task-detail-meta">
              <span className="task-detail-meta-label">Column</span>
              <span className="task-detail-meta-value">{task.column}</span>

              <span className="task-detail-meta-label">Priority</span>
              <select
                className="form-select"
                value={priority}
                onChange={e => setPriority(Number(e.target.value) as 1 | 2 | 3 | 4)}
                style={{ maxWidth: 140 }}
              >
                {[1, 2, 3, 4].map(p => (
                  <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
                ))}
              </select>

              <span className="task-detail-meta-label">Agent</span>
              <span className="task-detail-meta-value">
                {task.assignedAgent ? <AgentLabel agentId={task.assignedAgent} /> : 'Unassigned'}
              </span>

              <span className="task-detail-meta-label">Created</span>
              <span className="task-detail-meta-value">{formatTime(task.createdAt)}</span>
            </div>
          </div>

          {/* Labels */}
          <div className="task-detail-section">
            <div className="task-detail-section-label">Labels</div>
            <div className="label-input-container">
              {labels.map(label => (
                <span key={label} className="label-tag">
                  {label}
                  <button className="label-tag-remove" onClick={() => removeLabel(label)}>x</button>
                </span>
              ))}
              <input
                className="label-input"
                placeholder="Add label..."
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

          {/* Attachments */}
          {task.attachments && task.attachments.length > 0 && (
            <div className="task-detail-section">
              <div className="task-detail-section-label">Screenshots</div>
              <div className="screenshot-thumbs">
                {task.attachments.map(a => (
                  <a key={a.id} href={a.dataUrl} target="_blank" rel="noreferrer" className="screenshot-thumb">
                    <img src={a.dataUrl} alt={a.name} title={a.name} />
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Comments */}
          <div className="task-detail-section">
            <div className="task-detail-section-label">Comments</div>
            <div className="task-comments-list">
              {comments.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>No comments yet.</div>
              )}
              {comments.map(c => (
                <div key={c.id} className={`task-comment ${c.author === 'human' ? 'task-comment-human' : 'task-comment-agent'}`}>
                  <div className="task-comment-header">
                    <span className={`task-comment-author ${c.author === 'human' ? '' : `role-${c.author}`}`}>{c.author}</span>
                    <span className="task-comment-time">{formatTime(c.createdAt)}</span>
                  </div>
                  <div
                    className="task-comment-body"
                    dangerouslySetInnerHTML={{ __html: renderMd(c.body) }}
                  />
                </div>
              ))}
              <div ref={commentsEndRef} />
            </div>
            <div className="task-comment-input-row">
              <textarea
                className="task-comment-input"
                placeholder="Add a comment... (markdown supported)"
                value={commentBody}
                onChange={e => setCommentBody(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    handleAddComment()
                  }
                }}
                rows={3}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={handleAddComment}
                disabled={postingComment || !commentBody.trim()}
                style={{ marginTop: 6, alignSelf: 'flex-end' }}
              >
                {postingComment ? 'Posting...' : 'Comment'}
              </button>
            </div>
          </div>

          {/* History */}
          <div className="task-detail-section">
            <div className="task-detail-section-label">History</div>
            <div className="task-history">
              {task.history.map((entry, i) => (
                <div key={i} className="task-history-item">
                  <div className="task-history-dot" />
                  <span className="task-history-time">{formatTime(entry.timestamp)}</span>
                  <span>
                    <AgentLabel agentId={entry.agent} />{' '}
                    {entry.action}
                    {entry.from && entry.to && ` from ${entry.from} to ${entry.to}`}
                    {entry.note && ` - ${entry.note}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="task-detail-actions">
          <button className="btn btn-primary btn-sm" onClick={handleSave}>
            Save Changes
          </button>

          {/* Move dropdown */}
          <select
            className="form-select"
            value=""
            onChange={e => {
              if (e.target.value) handleMove(e.target.value as PipelineColumn)
            }}
            style={{ maxWidth: 130, fontSize: 12, padding: '4px 8px' }}
          >
            <option value="">Move to...</option>
            {PIPELINE_COLUMNS.filter(c => c !== task.column).map(col => (
              <option key={col} value={col}>{col}</option>
            ))}
          </select>

          {/* Claim */}
          <select
            className="form-select"
            value=""
            onChange={e => {
              if (e.target.value) handleClaim(e.target.value)
            }}
            style={{ maxWidth: 130, fontSize: 12, padding: '4px 8px' }}
          >
            <option value="">Claim as...</option>
            <option value="planner">Planner</option>
            <option value="builder">Builder</option>
            <option value="tester">Tester</option>
            <option value="promoter">Promoter</option>
          </select>

          <button
            className={`btn btn-sm ${isBlocked ? 'btn-primary' : ''}`}
            onClick={handleBlock}
          >
            {isBlocked ? 'Unblock' : 'Block'}
          </button>

          <button className="btn btn-sm btn-danger" onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
