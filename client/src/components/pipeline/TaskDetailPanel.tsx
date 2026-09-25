import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import DOMPurify from 'dompurify'
import type { PipelineTask, PipelineColumn, TaskComment } from '@shared/types'
import { PIPELINE_COLUMNS, DEFAULT_COLUMN_LABELS } from '@shared/constants'
import { usePipeline } from '../../context/PipelineContext'
import { rest } from '../../api/rest'
import { useUI } from '../../context/UIContext'
import { useOpenInstance } from '../../hooks/useOpenInstance'
import { useInstances } from '../../context/InstancesContext'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { useConfirm } from '../ConfirmModal'
import { TaskSettings, type TaskSettingsHandle } from './TaskSettings'
import { describeSchedule, computerZone } from '@shared/schedule-next'
import { MODELS } from '../../utils/modelOptions'
import { parseMarkdown } from '../../utils/markdown'

function AgentLabel({ agentId }: { agentId?: string | null }) {
  const { instances } = useInstances()
  const openInstance = useOpenInstance()
  if (!agentId || agentId === 'system') return <span className="orc-label">The Orc</span>
  if (agentId === 'human') return <span className="human-label">The Human</span>
  const instance = instances.find(i => i.id === agentId)
  const label = instance ? instance.name : agentId.slice(0, 8) + '...'
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    // Grid, not the legacy single-chat view. An author whose instance is gone stays
    // inert rather than navigating somewhere empty.
    if (instance) openInstance(instance)
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
  return DOMPurify.sanitize(parseMarkdown(text), {
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
  const { moveTask, startTask, blockTask, unblockTask, deleteTask } = usePipeline()
  const { confirm, alert } = useConfirm()
  const { activePipelineId, settings } = useUI()
  const columnLabels = { ...DEFAULT_COLUMN_LABELS, ...(settings.columnLabels || {}) }
  const colLabel = (key: string | undefined) => key ? (columnLabels[key as PipelineColumn] ?? key) : ''
  const { folders, instances } = useInstances()
  const { dispatch } = useAppDispatch()
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [editingDesc, setEditingDesc] = useState(false)
  const [priority, setPriority] = useState(task.priority)
  const [labelInput, setLabelInput] = useState('')
  const [labels, setLabels] = useState<string[]>([...task.labels])
  const [comments, setComments] = useState<TaskComment[]>([])
  const [commentBody, setCommentBody] = useState('')
  const [postingComment, setPostingComment] = useState(false)
  const [starting, setStarting] = useState(false)
  const [runningNow, setRunningNow] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const commentsEndRef = useRef<HTMLDivElement>(null)

  // THE FULL ROW, fetched once on mount.
  //
  // The board holds a lightweight copy of every card, which is the right thing for a board
  // and the wrong thing to edit: it carries no description and, until this panel started
  // mounting the settings, no run settings either. An edit form fed that copy reads every
  // missing field as unset and writes the blanks back, so opening a card and saving it used
  // to strip its model, its effort, its permissions and its spend limits. Nothing is
  // editable here until the real row has arrived.
  const [full, setFull] = useState<PipelineTask | null>(null)
  const settingsRef = useRef<TaskSettingsHandle>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Folded away is not the same as thrown away. Once the section has been opened it stays
  // MOUNTED and is only hidden, so folding it back up before pressing Save cannot quietly
  // drop the schedule somebody just built: an unmounted form takes its ref with it, and a
  // null ref sends no settings at all.
  const [settingsMounted, setSettingsMounted] = useState(false)

  // The task's OWN project, never the board's. They are the same thing on a project board,
  // but the all-projects board has no active project, and the panel opens there now: every
  // read and every mutation below has to be scoped to the task in front of the user, not to
  // whatever the sidebar happens to be pointing at.
  const projectId = task.projectId || activePipelineId || folders[0]?.id || ''

  const taskProject = folders.find(f => f.id === projectId)
  const taskProjectName = taskProject?.displayName || taskProject?.name || 'unknown project'

  const linkedInstance = task.instanceId ? instances.find(i => i.id === task.instanceId) : undefined
  const idleInstances = instances.filter(i => i.folderId === projectId && i.state === 'idle' && i.id !== task.instanceId)

  // The shared "take me to this chat" hook: it drops the instance into the grid and
  // goes there, with a locate flash when the tile is already open. Closing the panel
  // afterwards keeps the board from sitting underneath the tile you just opened.
  const openToGrid = useOpenInstance()

  const handleStart = useCallback(async (instanceId?: string) => {
    setStarting(true)
    setStartError(null)
    try {
      // Start, then stay. The panel keeps its place on the board and the linked
      // instance shows up as the "Open ..." button next to this one.
      await startTask(task.id, instanceId, projectId)
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Failed to start task')
    } finally {
      setStarting(false)
    }
  }, [startTask, task.id, projectId])

  // RUN NOW. Fires the SCHEDULE, not a hand-started chat: same prompt, same target chat,
  // same fallback, recorded in the card's run history with kind='manual' so it sits next to
  // every automatic run without counting toward the failure ledger or the run limit.
  //
  // The refusals are the interesting outcomes and the server has already written each one as
  // a sentence: the chat is busy, the chat is gone, the card has no schedule. They are shown
  // rather than swallowed, because a click that did nothing looks exactly like a click that
  // never registered.
  const handleRunNow = useCallback(async () => {
    if (runningNow) return
    setRunningNow(true)
    try {
      await rest.runTaskNow(projectId, task.id)
    } catch (err) {
      await alert(err instanceof Error ? err.message : 'Could not run this card', 'Not run')
    } finally {
      setRunningNow(false)
    }
  }, [runningNow, alert, projectId, task.id])

  // Fetch the full task on mount. The list endpoint omits the description and, historically,
  // every run setting. Kept whole rather than picked apart: the settings section below
  // mounts against it.
  //
  // THE DESCRIPTION IS TAKEN FROM IT UNCONDITIONALLY. It used to be taken only when it was
  // non-empty, and a failed fetch was swallowed, so the textbox kept the light copy's blank
  // and Save sent that blank back over the real text. On a raw_prompt routine the description
  // IS the prompt, so that was an empty message fired at the CLI on its next slot. Nothing can
  // have been typed into the description yet, because it cannot be edited until this lands.
  // A fetch that fails is said on screen and leaves the card unsaveable: a panel that could
  // not read the card has no business writing it.
  useEffect(() => {
    if (!projectId) return
    rest.getTask(projectId, task.id).then(fetched => {
      setFull(fetched)
      setDescription(fetched.description ?? '')
      setLoadError(null)
    }).catch(err => {
      setLoadError(
        `This card did not load (${err instanceof Error ? err.message : 'unknown error'}), so it cannot be saved. Close it and open it again.`
      )
    })
  }, [projectId, task.id])

  useEffect(() => {
    if (!projectId) return
    rest.getTaskComments(projectId, task.id).then(setComments).catch(() => {})
  }, [projectId, task.id])

  // Keep the comments list pinned to its newest entry WITHOUT using scrollIntoView.
  // scrollIntoView walks up and scrolls every scrollable ancestor, and because the UI
  // zoom puts a transform on `.app`, the viewport-sized VFX canvas overflows the app
  // box and makes `.app` programmatically scrollable. The result was that opening any
  // task dragged the entire shell out of view (top bar and sidebar gone) with no way to
  // scroll back, since `.app` has overflow hidden. Scroll the list container itself.
  // Skip the first pass: on mount the list is still empty, so there is nothing to pin.
  // The comments list has no max-height, so it is not its own scroll container: the
  // element that actually scrolls is .task-detail-body. Scroll THAT, and only after the
  // first load, so arriving at a task never buries its own title and description.
  const didLoadComments = useRef(false)
  useEffect(() => {
    if (!comments.length) return
    if (!didLoadComments.current) {
      didLoadComments.current = true
      return
    }
    const anchor = commentsEndRef.current
    const body = anchor?.closest('.task-detail-body') as HTMLElement | null
    if (!body || !anchor) return
    const target = anchor.offsetTop - body.clientHeight + 40
    body.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  }, [comments])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // ONE SAVE FOR THE WHOLE CARD. The settings section hands over its half of the body, or
  // the first thing wrong with it, and a rejected schedule keeps the panel open with the
  // reason on screen instead of closing over a save that never happened.
  //
  // rest.updateTask rather than the context's, deliberately: that one logs failures to the
  // console and returns, which is invisible to the person who just pressed Save. The board
  // refreshes from the WebSocket event either way.
  //
  // NOT BEFORE THE REAL ROW IS HERE. The button is disabled until then as well, but this is
  // the line that actually holds: a save from the light copy writes its blank description
  // over the card, and Enter, a double click or a future caller must not find a way round it.
  const handleSave = useCallback(async () => {
    if (!full) return
    setSaveError(null)
    const settings = settingsRef.current?.build()
    if (settings && 'error' in settings) { setSaveError(settings.error); return }
    try {
      await rest.updateTask(projectId, task.id, { title, description, priority, labels, ...(settings ?? {}) })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save this card')
      return
    }
    onClose()
  }, [full, task.id, projectId, title, description, priority, labels, onClose])

  const handleMove = useCallback(async (column: PipelineColumn) => {
    try {
      await moveTask(task.id, column, projectId)
    } catch (err) {
      console.error('Failed to move task:', err)
    }
    onClose()
  }, [moveTask, task.id, projectId, onClose])

  const handleBlock = useCallback(async () => {
    // Read the CURRENT labels, not task.labels. The task prop is the snapshot the board
    // held when the panel opened and it does not change while the panel is open, so the
    // old code took the "block" branch every time: the button flipped to Unblock (that
    // reads local state) but clicking it blocked again and appended a second "blocked"
    // chip. The task could never be unblocked from the panel.
    const currentlyBlocked = labels.includes('blocked')
    try {
      if (currentlyBlocked) {
        setLabels(l => l.filter(lb => lb !== 'blocked'))
        await unblockTask(task.id, projectId)
      } else {
        setLabels(l => (l.includes('blocked') ? l : [...l, 'blocked']))
        await blockTask(task.id, 'Manually blocked', projectId)
      }
    } catch (err) {
      console.error('Failed to toggle block:', err)
    }
  }, [blockTask, unblockTask, task.id, projectId, labels])

  const handleDelete = useCallback(async () => {
    const ok = await confirm(`Delete task "${task.title}"?`)
    if (!ok) return
    try {
      await deleteTask(task.id, projectId)
    } catch (err) {
      console.error('Failed to delete task:', err)
    }
    onClose()
  }, [deleteTask, task.id, projectId, task.title, onClose, confirm])

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

  // A card that already has a schedule opens with its settings showing: that is the card
  // somebody came here to change, and hiding it behind a disclosure is the second click
  // this whole change exists to remove.
  useEffect(() => {
    if (full?.scheduleKind) setSettingsOpen(true)
  }, [full])
  useEffect(() => {
    if (settingsOpen) setSettingsMounted(true)
  }, [settingsOpen])

  // What the folded section is hiding, said in the header, so the common case (checking
  // what a card runs as) does not need the click at all.
  const settingsSummary = useMemo(() => {
    const source = full ?? task
    const parts: string[] = []
    parts.push(
      source.scheduleKind
        ? describeSchedule({
            kind: source.scheduleKind,
            value: source.scheduleValue ?? '',
            days: source.scheduleDays,
            window: source.scheduleWindow,
            tz: source.scheduleTz,
            until: source.scheduleUntil,
          }, { computerZone: computerZone() })
        : 'runs when you start it'
    )
    if (source.scheduleKind && !source.scheduleEnabled) parts.push('paused')
    // `full` is what carries the model, so before it lands the summary simply does not
    // mention one rather than claiming the card is on the app default.
    if (full) parts.push(MODELS.find(m => m.id === full.model)?.label ?? 'app default model')
    return parts.join(' · ')
  }, [full, task])

  const isBlocked = labels.includes('blocked')

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  // When the work happened, which on a session log is not when the row was filed: the
  // date on the row is the moment the chat was closed, often weeks after the last turn.
  const workSpan = (() => {
    const { workStartedAt: a, workEndedAt: b } = task
    if (!a && !b) return null
    const day = (ts: number) => new Date(ts).toLocaleDateString()
    if (!a) return day(b!)
    if (!b) return day(a)
    return day(a) === day(b) ? day(a) : `${day(a)} - ${day(b)}`
  })()

  return (
    <div className="task-detail-overlay">
      <div className="task-detail-backdrop" onClick={onClose} />
      <div className="task-detail-panel">
        <div className="task-detail-header">
          <span className="modal-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>Task Detail</span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <div className="task-detail-body">
          {labels.includes('stuck') && (
            <div style={{
              background: 'color-mix(in srgb, #ef4444 10%, transparent)',
              border: '1px solid color-mix(in srgb, #ef4444 35%, transparent)',
              borderRadius: 8,
              padding: '12px 14px',
              marginBottom: 12,
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
            }}>
              <div style={{ fontWeight: 700, color: '#ef4444', marginBottom: 4, fontSize: 11 }}>STUCK — needs attention</div>
              <div style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                This task is stuck. Review the comments, fix the blocker, then move it to the correct column.
              </div>
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
              {/* Locked until the real row is here: until then `description` is the board's
                  blank, and anything typed over it would be typed over the wrong text. */}
              <button
                className="btn btn-sm"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => setEditingDesc(e => !e)}
                disabled={!full}
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
                dangerouslySetInnerHTML={{
                  __html: description
                    ? renderMd(description)
                    : `<p style="color:var(--text-muted)">${
                        full ? 'No description yet. Click Edit to add one.'
                          : loadError ? 'The description did not load.'
                          : 'Loading the description…'
                      }</p>`,
                }}
              />
            )}
          </div>

          {/* Start instance */}
          <div className="task-detail-section">
            <div className="task-detail-section-label">Work on it</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => handleStart()}
                disabled={starting}
                title="Spawn a fresh instance in this project with the task as its first prompt. You stay on the board."
              >
                {starting ? 'Starting…' : '▶ Start new instance'}
              </button>
              {idleInstances.length > 0 && (
                <select
                  className="form-select"
                  value=""
                  disabled={starting}
                  onChange={e => { if (e.target.value) handleStart(e.target.value) }}
                  style={{ maxWidth: 200, fontSize: 12, padding: '4px 8px' }}
                  title="Send the task to an idle instance in this project"
                >
                  <option value="">Send to idle instance…</option>
                  {idleInstances.map(i => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
              )}
              {linkedInstance && (
                <button
                  className="btn btn-sm"
                  onClick={() => { openToGrid(linkedInstance); onClose() }}
                  title="Open the instance working this task, as a Grid tile"
                >
                  Open {linkedInstance.name} {linkedInstance.state === 'running' ? '●' : ''}
                </button>
              )}
            </div>
            {startError && (
              <div style={{ color: '#ef4444', fontSize: 12, marginTop: 6, fontFamily: 'var(--font-mono)' }}>{startError}</div>
            )}
          </div>

          {/* Meta */}
          <div className="task-detail-section">
            <div className="task-detail-meta">
              {/* Which project this is. Free on a project board (it is the board you are
                  looking at) but the panel opens from the all-projects board now, where
                  a task carries no other clue about where it lives. */}
              <span className="task-detail-meta-label">Project</span>
              <span className="task-detail-meta-value">{taskProjectName}</span>

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

              {/* A session log is FILED when the chat closes, so "Created" would read as
                  the work date and be wrong by however long the tab sat open. */}
              <span className="task-detail-meta-label">{labels.includes('session-log') ? 'Logged' : 'Created'}</span>
              <span className="task-detail-meta-value">{formatTime(task.createdAt)}</span>

              {workSpan && (
                <>
                  <span className="task-detail-meta-label">Worked</span>
                  <span className="task-detail-meta-value">{workSpan}</span>
                </>
              )}
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

          {/* ── Settings: when it runs, and what it runs as ──────────────────────────
              Inline, in this panel, rather than behind a second dialog. A card's model and
              its schedule are properties of the card, so they belong on the card's own
              screen next to its title and its description. Folded by default because most
              visits here are to read the comments, and opened automatically for a card that
              already has a schedule, since that is the card somebody came to change. */}
          <div className="task-detail-section">
            <button
              type="button"
              className="advanced-toggle"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen(v => !v)}
            >
              {settingsOpen ? '▾' : '▸'} Settings
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-sans)', fontSize: 11, marginLeft: 8 }}>
                {settingsSummary}
              </span>
            </button>
            {settingsOpen && !full && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-mono)', marginTop: 10 }}>
                {loadError ? "This card's settings did not load." : "Loading this card's settings…"}
              </div>
            )}
            {settingsMounted && full && (
              <div style={{ marginTop: 10, display: settingsOpen ? undefined : 'none' }}>
                <TaskSettings ref={settingsRef} task={full} projectId={projectId} />
              </div>
            )}
          </div>

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
                    <span className={`task-comment-author ${c.author === 'human' ? 'human-label' : `role-${c.author}`}`}>{c.author === 'human' ? 'The Human' : c.author}</span>
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
              {(task.history ?? []).map((entry, i) => (
                <div key={i} className="task-history-item">
                  <div className="task-history-dot" />
                  <span className="task-history-time">{formatTime(entry.timestamp)}</span>
                  <span>
                    <AgentLabel agentId={entry.agent} />{' '}
                    {entry.action}
                    {entry.from && entry.to && ` from ${colLabel(entry.from)} to ${colLabel(entry.to)}`}
                    {entry.note && ` - ${entry.note}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="task-detail-actions">
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSave}
            disabled={!full}
            title={full ? undefined : loadError ? 'This card did not load, so it cannot be saved' : 'Loading the card…'}
          >
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

          <button
            className={`btn btn-sm ${isBlocked ? 'btn-primary' : ''}`}
            onClick={handleBlock}
          >
            {isBlocked ? 'Unblock' : 'Block'}
          </button>

          {/* This used to COPY the task into a brand new routine row: two disconnected
              objects, so editing one left the other stale. Then it opened a second dialog
              on top of this one. A schedule is a field on this card, so now it just scrolls
              to the field, in this panel, where it lives. */}
          {!settingsOpen && (
            <button
              className="btn btn-sm"
              onClick={() => setSettingsOpen(true)}
              title="Run this card on a schedule: every so many minutes or hours, at set times of day, or once at a date and time. Days, an active window and a timezone all apply on top."
            >
              {task.scheduleKind ? 'Schedule...' : 'Add schedule...'}
            </button>
          )}

          {/* Fire the schedule now, without waiting for its slot and without consuming it.
              The same prompt, the same target chat, the same fallback as an automatic run,
              recorded in the card's own run history. It is how somebody finds out whether
              tonight's routine works before tonight. Next to Schedule..., because that is
              where the person who just edited a schedule is looking. */}
          {task.scheduleKind && (
            <button
              className="btn btn-sm"
              onClick={() => void handleRunNow()}
              disabled={runningNow}
              title="Run this card right now, exactly as its schedule would. The next scheduled run is not affected."
            >
              {runningNow ? 'Running…' : 'Run now'}
            </button>
          )}

          <button className="btn btn-sm btn-danger" onClick={handleDelete}>
            Delete
          </button>

          {(saveError || loadError) && (
            <span style={{ color: '#ef4444', fontSize: 11, fontFamily: 'var(--font-mono)', flexBasis: '100%' }}>
              {saveError ?? loadError}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
