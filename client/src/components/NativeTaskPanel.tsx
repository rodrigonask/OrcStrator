import { useRef, useState, useEffect, useLayoutEffect, useSyncExternalStore } from 'react'
import { onComposerFocus } from '../systems/composer-focus'
import { useUI } from '../context/UIContext'
import { useInstances } from '../context/InstancesContext'
import { useCompact } from '../context/CompactContext'
import type { NativeTask } from '@orcstrator/shared'

// Claude Code's own task list, rendered the way its terminal panel renders it.
//
// The data comes straight from ~/.claude/tasks/<session-id>/*.json via the server's
// native-tasks watcher. We display it and nothing else: no local edits, no reordering,
// no OrcStrator-side state. If it looks wrong here, it is wrong in the CLI too.
//
// Glyphs and styling are matched to the CLI's own renderer:
//   pending      ◻  plain
//   in_progress  ◼  terracotta, bold label
//   completed    ✔  green, strikethrough + dim
// Header wording is the CLI's too: "N tasks (Y done, E in progress, Z open)",
// with the middle clause dropped when nothing is in progress.

const GLYPH: Record<NativeTask['status'], string> = {
  pending: '◻',     // ◻ white medium square
  in_progress: '◼', // ◼ black medium square
  completed: '✔',   // ✔ heavy check mark
}

function summarise(tasks: NativeTask[]): string {
  const done = tasks.filter(t => t.status === 'completed').length
  const running = tasks.filter(t => t.status === 'in_progress').length
  const open = tasks.filter(t => t.status === 'pending').length
  const noun = tasks.length === 1 ? 'task' : 'tasks'
  const middle = running > 0 ? `${running} in progress, ` : ''
  return `${tasks.length} ${noun} (${done} done, ${middle}${open} open)`
}

// Tile header count: just "done/total". The full sentence swings between 186.9px and
// 319.3px as the ", N in progress" clause appears and disappears, which happens at least
// twice a turn, and that is a live-updating number that moves. This changes width only
// when a digit count does, and tabular figures hold that steady. The long form is one
// hover away on the header's tooltip. Whether anything is running is carried by the
// marker span next to it, which reserves its width whether or not it has a glyph in it.
function summariseCompact(tasks: NativeTask[]): string {
  const done = tasks.filter(t => t.status === 'completed').length
  return `${done}/${tasks.length}`
}

// The one row Ultra Compact keeps when the list folds to a single line.
//
// "What is it doing right now" is the whole reason this panel earns space in a tile, so
// the line shows the running task; with nothing running it shows what is up next, and
// with nothing left it says so rather than going blank (a blank strip reads as broken,
// and the count beside it would be the only clue the list still exists).
function liveTask(tasks: NativeTask[]): { task: NativeTask | null; glyph: string; state: string } {
  const running = tasks.find(t => t.status === 'in_progress')
  if (running) return { task: running, glyph: GLYPH.in_progress, state: 'in_progress' }
  const next = tasks.find(t => t.status === 'pending')
  if (next) return { task: next, glyph: GLYPH.pending, state: 'pending' }
  return { task: null, glyph: GLYPH.completed, state: 'completed' }
}

// Open/closed, and when a closed panel is allowed to open itself again.
//
// Stored per instance as the TASK COUNT at the moment it was closed, not a boolean. That
// one detail is what makes "closed" mean "I have seen this, put it away" instead of
// "never show me this chat again": the panel stays closed while the list is unchanged,
// and the moment the next turn creates a task the count moves past the mark and it comes
// back on its own. Closing is a dismissal, not a mute.
//
// Persisted, because it used to be component state and reset every time GridView
// unmounted. One module-level store rather than per-component state, so a tile and the
// chat view can never disagree about the same instance.
const COLLAPSE_KEY = 'orcstrator.taskPanelCollapsedAt'

function loadCollapsed(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return {}
    // Drop anything that is not a number, including the booleans written by the previous
    // version of this key's older sibling.
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

let collapsedMap: Record<string, number> = loadCollapsed()
const collapseListeners = new Set<() => void>()

function subscribeCollapsed(fn: () => void): () => void {
  collapseListeners.add(fn)
  return () => { collapseListeners.delete(fn) }
}

// Identity only changes when the map does, which is what useSyncExternalStore requires.
function getCollapsedSnapshot(): Record<string, number> {
  return collapsedMap
}

function setCollapsedAt(instanceId: string, count: number | null): void {
  if (count === null) {
    if (!(instanceId in collapsedMap)) return
    const { [instanceId]: _drop, ...rest } = collapsedMap
    collapsedMap = rest
  } else {
    if (collapsedMap[instanceId] === count) return
    collapsedMap = { ...collapsedMap, [instanceId]: count }
  }
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedMap))
  } catch {
    // Storage full or blocked: the choice still applies for this session.
  }
  for (const fn of collapseListeners) fn()
}

// A completed task stops being worth screen space after a while, but the CLI never prunes
// the session's task directory, so a long chat accumulates its entire history, most of it
// long finished. Anything unfinished stays visible no matter how old it
// is (a task stuck in progress for hours is the one you most need to see); completed work
// drops out of the window an hour after it finished. Nothing is removed from the list,
// it just sits above the window, one scroll away.
const RECENT_MS = 60 * 60 * 1000
// Used when the server is too old to send updatedAt: fall back to a plain row count, so
// the panel still stops eating the tile before the server catches up.
const FALLBACK_ROWS = 8

export function NativeTaskPanel({ dense }: { dense?: boolean } = {}) {
  const { selectedInstanceId, settings } = useUI()
  const { instances } = useInstances()
  // Dense variant for grid tiles, where vertical space is scarce (GridTile provides the
  // context). `dense` overrides it, so a MAXIMIZED tile can opt back out: the whole
  // rationale for compact is that tile height is scarce, and at 1416x1206 it is not.
  const contextCompact = useCompact()
  const compact = dense ?? contextCompact
  // Ultra Compact folds the whole panel to one line. Only in a tile: the chat view has
  // the height to show the list properly, and `compact` is already false when a tile is
  // maximized, which is exactly when the full list should come back.
  const ultra = compact && settings.ultraCompact === true
  // Deliberately NOT the persisted collapse map. That map means "I have seen this list,
  // dismiss it until something changes"; this is just "show me the rest for a second",
  // and conflating the two would make one glance at the list permanently dismiss it.
  const [ultraOpen, setUltraOpen] = useState(false)
  // Open unless this instance was explicitly closed. See the store above.
  const collapsedByInstance = useSyncExternalStore(
    subscribeCollapsed,
    getCollapsedSnapshot,
    getCollapsedSnapshot,
  )

  const instance = instances.find(i => i.id === selectedInstanceId)
  const instanceId = instance?.id
  const tasks = instance?.nativeTasks ?? []
  const allDone = tasks.length > 0 && tasks.every(t => t.status === 'completed')

  // Closed only while the list is unchanged since the dismissal; a new task reopens it.
  const collapsedAt = instanceId !== undefined ? collapsedByInstance[instanceId] : undefined
  const collapsed = collapsedAt !== undefined && tasks.length <= collapsedAt

  // Going to reply folds away a list with nothing left to watch. A list with anything
  // running or queued stays, because that is what you want in the corner of your eye
  // while you type.
  useEffect(() => {
    return onComposerFocus(id => {
      if (id !== instanceId || !allDone) return
      setCollapsedAt(id, tasks.length)
    })
  }, [instanceId, allDone, tasks.length])

  // A finished list goes stale the moment the next turn begins.
  //
  // This is the rule; the click above is just a shortcut that fires earlier. Relying on
  // the click alone was not enough, because the composer focuses itself when a chat is
  // selected, so a reply typed without ever pressing the textarea dismissed nothing, and
  // a completed list rode along expanded through turns that never touched a task.
  //
  // Deciding it at the START of the turn rather than the end is what makes it hold: if
  // the turn goes on to create a task the count passes the mark and the panel reopens on
  // its own, and if it never creates one there is nothing to show and it stays shut for
  // the whole turn and after it. Anything still pending or running is left alone at any
  // age, because that is the list worth watching.
  const prevStateRef = useRef(instance?.state)
  useEffect(() => {
    const prev = prevStateRef.current
    prevStateRef.current = instance?.state
    if (prev === 'running' || instance?.state !== 'running') return
    if (!instanceId || !allDone) return
    setCollapsedAt(instanceId, tasks.length)
  }, [instanceId, instance?.state, allDone, tasks.length])

  // Where the visible window starts. Everything before this index stays rendered and
  // scrollable, it is just above the fold.
  const firstRecent = (() => {
    if (tasks.length === 0) return 0
    const byCount = Math.max(0, tasks.length - FALLBACK_ROWS)
    const hasTimes = tasks.some(t => t.updatedAt != null)
    if (!hasTimes) {
      // Old server, no timestamps: never hide unfinished work, otherwise show the tail.
      const firstOpen = tasks.findIndex(t => t.status !== 'completed')
      return firstOpen >= 0 ? Math.min(firstOpen, byCount) : byCount
    }
    const cutoff = Date.now() - RECENT_MS
    const i = tasks.findIndex(
      t => t.status !== 'completed' || (t.updatedAt != null && t.updatedAt >= cutoff),
    )
    // Nothing recent at all: the list is pure history, so show its tail.
    return i >= 0 ? i : byCount
  })()

  const listRef = useRef<HTMLUListElement>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return // collapsed, or nothing rendered
    const rows = list.children
    if (firstRecent <= 0 || firstRecent >= rows.length) {
      list.style.height = ''
      list.scrollTop = list.scrollHeight
      return
    }
    // Size the window to the recent block and park it at the bottom, so the rows on
    // screen are the current ones and the history sits just above. Measured rather than
    // computed from a row height, because a long subject wraps to two or three lines.
    const row = rows[firstRecent] as HTMLElement
    const offsetInContent = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
    list.style.height = `${Math.ceil(list.scrollHeight - offsetInContent)}px`
    list.scrollTop = list.scrollHeight
  }, [firstRecent, tasks.length, collapsed, compact, ultraOpen])

  // The Ultra Compact list floats over the transcript, so it has to behave like the
  // overlay it is: anything outside it, or Escape, puts it away. Without this it would be
  // a panel you can only close by finding the same 22px strip again, while it sits on top
  // of the messages you opened it to stop covering.
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ultraOpen) return
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setUltraOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setUltraOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [ultraOpen])

  // Leaving the mode (or maximizing the tile) must not strand an overlay that no longer
  // has a strip to close it.
  useEffect(() => { if (!ultra) setUltraOpen(false) }, [ultra])

  if (!instance || tasks.length === 0) return null

  // A task's blockedBy list keeps every dependency forever, including ones already
  // finished, so rendering it raw leaves "blocked by #3" sitting under a task whose
  // blocker completed minutes ago. The CLI treats blockedBy as OPEN blockers only, so
  // resolve against the live statuses and show what is actually still in the way.
  const completedIds = new Set(tasks.filter(t => t.status === 'completed').map(t => t.id))

  // Closing marks the list as seen at its current length; opening clears the mark.
  const toggle = () => setCollapsedAt(instance.id, collapsed ? null : tasks.length)

  const showList = ultra ? ultraOpen : !collapsed
  const live = liveTask(tasks)

  const list = (
    <ul className="native-task-list" ref={listRef}>
      {tasks.map(task => {
        const openBlockers = task.blockedBy.filter(id => !completedIds.has(id))
        return (
          <li key={task.id} className={`native-task-row is-${task.status}`}>
            <span className="native-task-glyph" aria-hidden="true">{GLYPH[task.status]}</span>
            <span className="native-task-subject">
              {task.subject}
              {openBlockers.length > 0 && (
                <span className="native-task-blocked">
                  {' › blocked by '}
                  {openBlockers.map(id => `#${id}`).join(', ')}
                </span>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )

  // ── Ultra Compact: one 22px line, and the list opens UPWARD over the transcript ──
  // The title, the chevron column and every row but the live one come off the panel,
  // which takes it from roughly 200px to 22px. Nothing is lost, only moved one click
  // away, and opening it costs the transcript no height because the list is an overlay
  // rather than another row in the tile's column.
  if (ultra) {
    return (
      <div className="native-task-panel is-compact is-ultra" ref={panelRef}>
        {showList && list}
        <button
          className={`native-task-strip is-${live.state}${showList ? ' is-open' : ''}`}
          onClick={() => setUltraOpen(o => !o)}
          aria-expanded={showList}
          title={`${summarise(tasks)}. Click to ${showList ? 'hide' : 'show'} the full list.`}
        >
          <span className="native-task-glyph" aria-hidden="true">{live.glyph}</span>
          <span className="native-task-strip-subject">
            {live.task ? live.task.subject : 'All tasks done'}
          </span>
          <span className="native-task-count">{summariseCompact(tasks)}</span>
          <span className="native-task-strip-chevron" aria-hidden="true">{showList ? '▾' : '▸'}</span>
        </button>
      </div>
    )
  }

  return (
    <div className={`native-task-panel${compact ? ' is-compact' : ''}`}>
      <button
        className="native-task-header"
        onClick={toggle}
        aria-expanded={!collapsed}
        title={`${summarise(tasks)}. Click to ${collapsed ? 'show' : 'hide'}.`}
      >
        <span className={`native-task-chevron ${collapsed ? 'is-collapsed' : ''}`}>{'▾'}</span>
        <span className="native-task-title">Tasks</span>
        {compact && (
          <span className="native-task-live" aria-hidden="true">
            {tasks.some(t => t.status === 'in_progress') ? '◼' : ''}
          </span>
        )}
        <span className="native-task-count">
          {compact ? summariseCompact(tasks) : summarise(tasks)}
        </span>
      </button>

      {showList && list}
    </div>
  )
}
