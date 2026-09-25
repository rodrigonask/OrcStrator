import { useState, useRef, useCallback, useEffect } from 'react'
import { useUI } from '../context/UIContext'
import { useMessages } from '../context/MessagesContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { CliPromptBanner } from './CliPromptBanner'
import { PermissionBanner } from './PermissionBanner'
import { ConflictBanner } from './ConflictBanner'
import { useCompact } from '../context/CompactContext'
import { composerFocused } from '../systems/composer-focus'
import { formatModelBadge, permModeColor } from '../utils/modelBadge'
import { ModelSwitchWarning } from './ModelSwitchWarning'
import { isCacheWarm } from '../hooks/useCacheWarm'
import { PERM_KEY, permissionModeFlag } from '../utils/permMode'
import { api } from '../api'
import type { ChatMessage, PermissionMode } from '@shared/types'
import { resolveModelId, switchLosesThinking, DEFAULT_MODEL_ID, DEFAULT_EFFORT } from '@shared/constants'

// Both lists live in utils/modelOptions so the composer and the task modal offer exactly
// the same choices. A second copy drifts the first time a model ships.
import { MODELS, EFFORT_LEVELS } from '../utils/modelOptions'

const DRAFT_KEY = (id: string) => 'draft-' + id
const MODEL_KEY = (id: string) => 'model-' + id
const EFFORT_KEY = (id: string) => 'effort-' + id
// The post-compaction "now on X" note outlives a re-render: the turn:complete history
// refetch remounts the tile, which would wipe a plain useState note before it is read.
const SWITCH_NOTE_KEY = (id: string) => 'switch-note-' + id
const SWITCH_NOTE_MS = 6000

function readSwitchNote(instanceId: string | null | undefined): string | null {
  if (!instanceId) return null
  const raw = localStorage.getItem(SWITCH_NOTE_KEY(instanceId))
  if (!raw) return null
  try {
    const { text, at } = JSON.parse(raw) as { text: string; at: number }
    if (Date.now() - at < SWITCH_NOTE_MS) return text
  } catch { /* malformed — fall through and clear */ }
  localStorage.removeItem(SWITCH_NOTE_KEY(instanceId))
  return null
}
// PERM_KEY is shared with the plan-approval flow (ToolCallBlock) so approving a plan
// can honor the mode picked here — see utils/permMode.ts.

// Model/effort/permission picks must survive refreshes, new tabs, and browser
// restarts — localStorage, not sessionStorage (which is per-tab and made
// instances silently "switch" back to the Settings default model).
// One-time migration: adopt any value the current tab still has in sessionStorage.
function readPref(key: string): string | null {
  const v = localStorage.getItem(key)
  if (v !== null) return v
  const legacy = sessionStorage.getItem(key)
  if (legacy !== null) {
    localStorage.setItem(key, legacy)
    sessionStorage.removeItem(key)
  }
  return legacy
}

// Full model IDs that left the picker, mapped to what replaced them. A chat keeps its
// model in localStorage, so without this a chat last used on a retired model silently
// keeps launching it forever: the badge shows a model no row matches, and (for Fable 5)
// it keeps paying 4x the cache-read rate of the model it was replaced by.
const RETIRED_MODEL_IDS: Record<string, string> = {
  'claude-fable-5': 'claude-fable-5-1',
  'claude-opus-4-6': 'claude-opus-5',
  'claude-opus-4-7': 'claude-opus-5',
  'claude-sonnet-4-6': 'claude-sonnet-5',
}

/** Read a saved model pref, upgrading a retired ID to its replacement. */
function readModelPref(key: string, fallback: string): string {
  const v = readPref(key)
  if (v === null) return fallback
  const current = RETIRED_MODEL_IDS[v]
  if (!current) return v
  localStorage.setItem(key, current)
  return current
}

const PERMISSION_CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan Mode',
  auto: 'Auto Mode',
  bypassPermissions: 'Bypass',
  dontAsk: "Don't Ask",
}

// Rotating composer placeholder — advances one step per sent message so the hint
// stays fresh and quietly teaches paste/drop-to-attach (now that the paperclip is gone).
// Index lives in localStorage so it progresses across the whole session, not per tab.
const PLACEHOLDERS = [
  'Reply, or paste a screenshot',
  'Type a message…',
  'Attach an image — just paste or drop it in',
  'Drop an image anywhere in here',
  "Can't read files, but images? All day.",
  'Paste a screenshot straight from your clipboard',
]
const PH_KEY = 'composer-ph-index'

/**
 * autoFocus: take keyboard focus when this composer mounts. True in the chat view and for
 * a grid tile the user clicked into. A grid tile that was added BEHIND the user (a scheduled
 * run surfaced, a pipeline task started) passes false, or its composer would yank the caret
 * out of whatever they were typing the moment the tile appeared. Read once, at mount: a tile
 * that becomes focused later got that focus from a click, which already put the caret
 * where the click landed (possibly the rename input, which this must not override).
 */
export function MessageInput({ autoFocus = true }: { autoFocus?: boolean } = {}) {
  const autoFocusAtMount = useRef(autoFocus)
  const { selectedInstanceId: instanceId, settings, sessionCosts } = useUI()
  const { streamingContent, pendingCommand, pendingWakeups } = useMessages()
  const { instances } = useInstances()
  const { dispatch, sendMessage } = useAppDispatch()
  const compact = useCompact()
  // The model / effort / permission-mode picker is a single popover card opened
  // from the composer badge (used in both grid-tile and full-chat composers).
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  // 'default' in the settings dropdown means "whatever the app default is", so it
  // resolves here rather than being stored as a pinned model name.
  const defaultModelId = settings.defaultModel && settings.defaultModel !== 'default'
    ? resolveModelId(settings.defaultModel)
    : DEFAULT_MODEL_ID
  const defaultEffortId = settings.defaultEffort ?? DEFAULT_EFFORT

  const [text, setText] = useState(() => {
    if (!instanceId) return ''
    return sessionStorage.getItem(DRAFT_KEY(instanceId)) ?? ''
  })
  const defaultPermMode: PermissionMode = settings.permissionMode ?? 'bypassPermissions'
  const [permMode, setPermModeRaw] = useState<PermissionMode>(() => {
    if (!instanceId) return defaultPermMode
    return (readPref(PERM_KEY(instanceId)) as PermissionMode) || defaultPermMode
  })
  const [model, setModelRaw] = useState(() => {
    if (!instanceId) return defaultModelId
    return readModelPref(MODEL_KEY(instanceId), defaultModelId)
  })
  const [effort, setEffortRaw] = useState(() => {
    if (!instanceId) return defaultEffortId
    return readPref(EFFORT_KEY(instanceId)) ?? defaultEffortId
  })

  const setPermMode = useCallback((v: PermissionMode) => {
    setPermModeRaw(v)
    if (instanceId) localStorage.setItem(PERM_KEY(instanceId), v)
  }, [instanceId])

  const cyclePermMode = useCallback(() => {
    setPermModeRaw(prev => {
      const enabled = settings.permissionCycleModes && settings.permissionCycleModes.length > 0
        ? PERMISSION_CYCLE.filter(m => settings.permissionCycleModes!.includes(m))
        : PERMISSION_CYCLE
      const cycle = enabled.length > 0 ? enabled : PERMISSION_CYCLE
      const idx = cycle.indexOf(prev)
      const next = cycle[(idx + 1) % cycle.length]
      if (instanceId) localStorage.setItem(PERM_KEY(instanceId), next)
      return next
    })
  }, [instanceId, settings.permissionCycleModes])

  const setModel = useCallback((v: string) => {
    setModelRaw(v)
    if (instanceId) localStorage.setItem(MODEL_KEY(instanceId), v)
  }, [instanceId])

  const setEffort = useCallback((v: string) => {
    setEffortRaw(v)
    if (instanceId) localStorage.setItem(EFFORT_KEY(instanceId), v)
  }, [instanceId])

  // Model the user picked but hasn't confirmed yet — the switch warning is open.
  const [pendingModel, setPendingModel] = useState<string | null>(null)
  // Model to apply the moment the /compact turn finishes ("Compact first"). While this
  // is set the model is locked: switching mid-compaction would move the turn onto the
  // uncached model and burn exactly what compacting is meant to save.
  const [queuedModel, setQueuedModel] = useState<string | null>(null)
  // The queued switch fires on the running -> idle edge, so it must see the turn start
  // first. Without this the switch would fire immediately, while the chat is still idle.
  const compactStarted = useRef(false)
  // Short-lived "switched to X" note shown next to the badge. Not a chat message:
  // turn:complete refetches history from the server and replaces the message list,
  // so anything added client-side at that exact moment is wiped before it renders.
  const [switchNote, setSwitchNote] = useState<string | null>(() => readSwitchNote(instanceId))

  // A model change only goes through the warning when there is a live cache to lose: the
  // prompt cache belongs to the model that wrote it, so switching makes the next turn
  // re-send the whole conversation at full price. Two cases skip it, because in both the
  // switch costs nothing extra:
  //   - no session yet, so nothing has been cached at all;
  //   - the cache has already gone cold (TTL expired, or the chat never read from cache),
  //     in which case the next turn pays for the full history whichever model runs it, and
  //     "compact first" would itself be that cold, full-price turn.
  const requestModelChange = useCallback((v: string) => {
    if (queuedModel) return
    if (!instanceId || v === model) { setModel(v); return }
    const inst = instances.find(i => i.id === instanceId)
    if (!inst?.sessionId) { setModel(v); return }
    if (!isCacheWarm(sessionCosts[instanceId], settings.promptCache1h)) { setModel(v); return }
    setPendingModel(v)
  }, [instanceId, model, instances, setModel, queuedModel, sessionCosts, settings.promptCache1h])

  // Runs /compact on the CURRENT model, which is still cached and therefore cheap to
  // read. Deliberately does not switch afterwards: compacting on the new model would
  // be the expensive cache-miss turn the warning exists to avoid.
  const compactBeforeSwitch = useCallback((target: string) => {
    setPendingModel(null)
    if (!instanceId) return
    setQueuedModel(target)
    compactStarted.current = false
    const turnFlags = [`--model=${model}`, `--effort=${effort}`]
    turnFlags.push(permissionModeFlag(permMode))
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      instanceId,
      role: 'user',
      content: [{ type: 'text', text: '/compact' }],
      createdAt: Date.now(),
    }
    dispatch({ type: 'ADD_MESSAGE', payload: userMsg })
    dispatch({ type: 'SET_PENDING_COMMAND', payload: { instanceId, command: '/compact' } })
    api.sendCommand(instanceId, '/compact', turnFlags).then(res => {
      dispatch({ type: 'ADD_MESSAGE', payload: {
        id: crypto.randomUUID(), instanceId, role: 'assistant',
        content: [{ type: 'text', text: res.result }], createdAt: Date.now(),
      } })
      // Nothing to compact, or the turn never started: release the lock rather than
      // leaving the model pinned waiting for a turn that will never run.
      if (!res.ok) setQueuedModel(null)
    }).catch(() => {
      dispatch({ type: 'ADD_MESSAGE', payload: {
        id: crypto.randomUUID(), instanceId, role: 'assistant',
        content: [{ type: 'text', text: 'Compaction failed.' }], createdAt: Date.now(),
      } })
      setQueuedModel(null)
    }).finally(() => {
      dispatch({ type: 'CLEAR_PENDING_COMMAND', payload: instanceId })
    })
  }, [instanceId, model, effort, permMode, dispatch])
  const [images, setImages] = useState<{ base64: string; mediaType: string }[]>([])
  // Rotating placeholder index — advances on each send (see handleSend), persisted globally.
  const [phIndex, setPhIndex] = useState(() => {
    const v = Number(localStorage.getItem(PH_KEY))
    return Number.isInteger(v) && v >= 0 ? v % PLACEHOLDERS.length : 0
  })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevInstanceRef = useRef<string | null>(instanceId ?? null)

  const isStreaming = instanceId ? !!streamingContent?.[instanceId] : false
  const runningCommand = instanceId ? pendingCommand?.[instanceId] : undefined
  const isCommandPending = !!runningCommand

  const selectedInstance = instanceId ? instances.find(i => i.id === instanceId) : null
  const isRunning = selectedInstance?.state === 'running'
  // `/btw …` is the one input allowed to send mid-run — it steers the live turn
  // (see handleSend) instead of starting a new one, so it bypasses the streaming gate.
  const isBtw = text.trim().toLowerCase().startsWith('/btw ')

  // Apply a queued model switch on the compaction turn's running -> idle edge. The
  // /compact command returns as soon as the turn is dispatched, so the HTTP response
  // is not the finish line; the instance leaving 'running' is.
  useEffect(() => {
    if (!queuedModel || !instanceId) return
    if (isRunning) { compactStarted.current = true; return }
    if (!compactStarted.current) return
    compactStarted.current = false
    setModel(queuedModel)
    setQueuedModel(null)
    const name = MODELS.find(m => m.id === queuedModel)?.label.split(' (')[0] ?? queuedModel
    const text = `compacted, now on ${name}`
    localStorage.setItem(SWITCH_NOTE_KEY(instanceId), JSON.stringify({ text, at: Date.now() }))
    setSwitchNote(text)
  }, [queuedModel, isRunning, instanceId, setModel])

  useEffect(() => {
    if (!switchNote || !instanceId) return
    const t = setTimeout(() => {
      localStorage.removeItem(SWITCH_NOTE_KEY(instanceId))
      setSwitchNote(null)
    }, SWITCH_NOTE_MS)
    return () => clearTimeout(t)
  }, [switchNote, instanceId])

  // If the turn never starts (the send failed silently, the process died), don't leave
  // the model locked forever.
  useEffect(() => {
    if (!queuedModel) return
    const t = setTimeout(() => { if (!compactStarted.current) setQueuedModel(null) }, 30_000)
    return () => clearTimeout(t)
  }, [queuedModel])

  // Focus textarea when instance changes (cycling or new selection), unless this composer
  // was mounted behind the user's back (see autoFocus above).
  useEffect(() => {
    if (instanceId && autoFocusAtMount.current) textareaRef.current?.focus()
  }, [instanceId])

  // Auto-resize textarea — respect the CSS max-height so grid tiles cap at 80px.
  // When empty, collapse to exactly one row (height:auto = the rows={1} intrinsic
  // height). Chrome folds the WRAPPED PLACEHOLDER into an empty textarea's
  // scrollHeight, so trusting scrollHeight here made tiles with longer placeholders
  // taller and broke composer alignment across the grid. Only measure once there's
  // real content to grow for.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const maxH = parseInt(getComputedStyle(el).maxHeight) || 200
    el.style.height = 'auto'
    if (text) el.style.height = Math.min(el.scrollHeight, maxH) + 'px'
  }, [text])

  // Debounced save draft to sessionStorage (5s after last keystroke)
  useEffect(() => {
    if (!instanceId) return
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      if (text) {
        sessionStorage.setItem(DRAFT_KEY(instanceId), text)
      } else {
        sessionStorage.removeItem(DRAFT_KEY(instanceId))
      }
    }, 5000)
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current) }
  }, [text, instanceId])

  // Restore draft + reset model/effort/permMode when switching instances
  useEffect(() => {
    const prev = prevInstanceRef.current
    prevInstanceRef.current = instanceId ?? null
    // Flush previous instance draft immediately before switching
    if (prev && prev !== instanceId) {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
      // `text` in this closure is the old instance's text
      if (text) {
        sessionStorage.setItem(DRAFT_KEY(prev), text)
      } else {
        sessionStorage.removeItem(DRAFT_KEY(prev))
      }
    }
    // Restore draft + saved model/effort/permMode for new instance
    if (instanceId) {
      setText(sessionStorage.getItem(DRAFT_KEY(instanceId)) ?? '')
      setModelRaw(readModelPref(MODEL_KEY(instanceId), defaultModelId))
      setEffortRaw(readPref(EFFORT_KEY(instanceId)) ?? defaultEffortId)
      setPermModeRaw((readPref(PERM_KEY(instanceId)) as PermissionMode) || defaultPermMode)
    } else {
      setText('')
      setModelRaw(defaultModelId)
      setEffortRaw(defaultEffortId)
      setPermModeRaw(defaultPermMode)
    }
    setImages([])
    // A queued switch belongs to the chat that started compacting, not to this one.
    setQueuedModel(null)
    compactStarted.current = false
    setSwitchNote(readSwitchNote(instanceId))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId])

  // Close the picker popover on outside-click or Escape
  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [pickerOpen])

  const processCommandAction = useCallback((res: { ok: boolean; result: string; action?: string; value?: string; url?: string }) => {
    if (!instanceId) return
    if (!res.action) return
    switch (res.action) {
      case 'clear-history':
        api.clearHistory(instanceId)
        dispatch({ type: 'CLEAR_MESSAGES', payload: instanceId })
        break
      case 'set-model':
        if (res.value) requestModelChange(res.value)
        break
      case 'set-effort':
        if (res.value) setEffort(res.value)
        break
      case 'toggle-fast':
        // Anthropic "Fast Mode" requires direct API access (unavailable on OAuth/subscription),
        // so /fast switches between the fastest general model (Sonnet) and the latest Opus instead.
        requestModelChange(model === 'claude-sonnet-5' ? DEFAULT_MODEL_ID : 'claude-sonnet-5')
        break
      case 'toggle-plan-mode':
        setPermMode(permMode === 'plan' ? 'default' : 'plan')
        break
      case 'set-plan-mode':
        setPermMode('plan')
        break
      case 'new-instance': {
        const inst = instances.find(i => i.id === instanceId)
        if (inst) {
          api.createInstance({ folderId: inst.folderId }).then(newInst => {
            dispatch({ type: 'ADD_INSTANCE', payload: newInst })
            dispatch({ type: 'SELECT_INSTANCE', payload: newInst.id })
          })
        }
        break
      }
      case 'kill-process':
        api.killInstance(instanceId).catch(err => window.alert(`Couldn't stop the process: ${err.message}`))
        break
      case 'open-settings':
        dispatch({ type: 'OPEN_SETTINGS' })
        break
      case 'open-url':
        if (res.url) window.open(res.url, '_blank')
        break
      case 'copy-to-clipboard':
        if (res.value) navigator.clipboard.writeText(res.value)
        break
    }
  }, [instanceId, dispatch, instances, requestModelChange, setEffort, permMode, setPermMode, model])

  const handleSend = useCallback(() => {
    if (!instanceId || (!text.trim() && images.length === 0)) return
    // Advance the rotating placeholder for the next time the box is empty.
    setPhIndex(i => {
      const n = (i + 1) % PLACEHOLDERS.length
      localStorage.setItem(PH_KEY, String(n))
      return n
    })
    const trimmed = text.trim()

    // Composer picks, built once: every path below that starts a real turn (normal send,
    // /btw, slash commands routed through the streaming pipeline) has to carry them or the
    // turn runs on the global defaults instead of what the footer shows.
    const turnFlags = [`--model=${model}`, `--effort=${effort}`]
    turnFlags.push(permissionModeFlag(permMode))

    // Intercept /btw ("by the way") — send a steering note WHILE a turn runs.
    // Must come before the generic slash block (which would route it through the
    // command registry). Server-side: if a turn is running the note is queued and
    // auto-runs as a follow-up turn the instant it ends; if idle, it runs now.
    const lower = trimmed.toLowerCase()
    if (lower === '/btw' || lower.startsWith('/btw ')) {
      const note = trimmed.slice(4).trim()
      if (note && instanceId) {
        dispatch({ type: 'ADD_MESSAGE', payload: {
          id: crypto.randomUUID(),
          instanceId,
          role: 'user',
          content: [{ type: 'text', text: note }],
          createdAt: Date.now(),
        } })
        api.btw(instanceId, note, turnFlags).catch(err => window.alert(`Couldn't queue your note: ${err.message}`))
      }
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
      sessionStorage.removeItem(DRAFT_KEY(instanceId))
      setText('')
      return
    }

    // Intercept slash commands — route through command API instead of sendMessage
    if (trimmed.startsWith('/') && !trimmed.startsWith('//') && images.length === 0) {
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        instanceId,
        role: 'user',
        content: [{ type: 'text', text: trimmed }],
        createdAt: Date.now(),
      }
      dispatch({ type: 'ADD_MESSAGE', payload: userMsg })
      const cmdName = trimmed.split(/\s+/)[0]
      dispatch({ type: 'SET_PENDING_COMMAND', payload: { instanceId, command: cmdName } })

      api.sendCommand(instanceId, trimmed, turnFlags).then(res => {
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          instanceId,
          role: 'assistant',
          content: [{ type: 'text', text: res.result }],
          createdAt: Date.now(),
        }
        dispatch({ type: 'ADD_MESSAGE', payload: assistantMsg })
        processCommandAction(res)
      }).catch(() => {
        dispatch({ type: 'ADD_MESSAGE', payload: {
          id: crypto.randomUUID(), instanceId, role: 'assistant',
          content: [{ type: 'text', text: 'Command failed.' }], createdAt: Date.now(),
        }})
      }).finally(() => {
        dispatch({ type: 'CLEAR_PENDING_COMMAND', payload: instanceId })
      })

      // Clear input
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
      sessionStorage.removeItem(DRAFT_KEY(instanceId))
      setText('')
      return
    }

    sendMessage(instanceId, trimmed, images.map(i => i.base64), turnFlags)
    // Clear draft from sessionStorage
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    sessionStorage.removeItem(DRAFT_KEY(instanceId))
    setText('')
    setImages([])
  }, [instanceId, text, permMode, model, images, sendMessage, dispatch, processCommandAction, effort])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    // Shift+Tab cycles permission mode
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      cyclePermMode()
    }
    // Ctrl+M cycles model
    if (e.key === 'm' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      const idx = MODELS.findIndex(m => m.id === model)
      requestModelChange(MODELS[(idx + 1) % MODELS.length].id)
    }
    // Ctrl+E cycles effort
    if (e.key === 'e' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      const idx = EFFORT_LEVELS.findIndex(l => l.id === effort)
      setEffort(EFFORT_LEVELS[(idx + 1) % EFFORT_LEVELS.length].id)
    }
  }, [handleSend, cyclePermMode, model, effort, requestModelChange, setEffort])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (!file) continue
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          const base64 = result.split(',')[1]
          setImages(prev => [...prev, { base64, mediaType: file.type }])
        }
        reader.readAsDataURL(file)
      }
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const files = e.dataTransfer.files
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        const base64 = result.split(',')[1]
        setImages(prev => [...prev, { base64, mediaType: file.type }])
      }
      reader.readAsDataURL(file)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const removeImage = useCallback((index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }, [])

  // Unified model / effort / mode picker: a single popover card (opens up-and-left
  // from the badge). Click any value to set it; the card stays open for quick
  // multi-changes and closes on outside-click / Esc.
  const renderPicker = () => (
    <div className="model-picker" ref={pickerRef}>
      {switchNote && (
        <span
          style={{
            position: 'absolute', bottom: 'calc(100% + 4px)', right: 0, whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)',
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', padding: '2px 6px', pointerEvents: 'none',
          }}
        >
          {switchNote}
        </span>
      )}
      <button
        type="button"
        className={`compact-model-badge${pickerOpen ? ' is-open' : ''}`}
        onClick={() => setPickerOpen(v => !v)}
        title={`${model} · ${effort} effort · ${PERMISSION_LABELS[permMode]} — click to change`}
        aria-expanded={pickerOpen}
      >
        <span className="compact-perm-dot" style={{ background: permModeColor(permMode) }} />
        {formatModelBadge(model, effort)}
        <span className="model-picker-caret" aria-hidden="true">▾</span>
      </button>
      {pickerOpen && (
        <div className="model-picker-pop" role="dialog" aria-label="Model, effort and mode">
          <div className="mp-group">
            <div className="mp-group-label">Model <span className="mp-kbd">{queuedModel ? 'compacting…' : 'Ctrl+M'}</span></div>
            <div className="mp-rows">
              {MODELS.map(m => (
                <button
                  key={m.id}
                  type="button"
                  className={`mp-row${model === m.id ? ' is-active' : ''}`}
                  disabled={!!queuedModel}
                  style={queuedModel ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                  title={queuedModel ? 'Locked until compaction finishes, then it switches automatically' : undefined}
                  onClick={() => requestModelChange(m.id)}
                >
                  <span className="mp-check" aria-hidden="true">{model === m.id ? '●' : '○'}</span>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mp-group">
            <div className="mp-group-label">Effort <span className="mp-kbd">Ctrl+E</span></div>
            <div className="mp-seg">
              {EFFORT_LEVELS.map(e => (
                <button
                  key={e.id}
                  type="button"
                  className={`mp-seg-btn${effort === e.id ? ' is-active' : ''}`}
                  onClick={() => setEffort(e.id)}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mp-group">
            <div className="mp-group-label">Mode <span className="mp-kbd">Shift+Tab</span></div>
            <div className="mp-rows">
              {PERMISSION_CYCLE.map(pm => (
                <button
                  key={pm}
                  type="button"
                  className={`mp-row${permMode === pm ? ' is-active' : ''}`}
                  onClick={() => setPermMode(pm)}
                >
                  <span className="mp-dot" aria-hidden="true" style={{ background: permModeColor(pm) }} />
                  {PERMISSION_LABELS[pm]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="message-input-container">
      {instanceId && <ConflictBanner instanceId={instanceId} />}
      {images.length > 0 && (
        <div className="image-preview-strip">
          {images.map((img, i) => {
            const isLarge = Math.floor(img.base64.length * 0.75) > 1.5 * 1024 * 1024
            return (
              <div key={i} className="image-preview-item">
                <img src={`data:${img.mediaType};base64,${img.base64}`} alt="" />
                {isLarge && <span className="image-preview-badge" style={{ fontFamily: 'var(--font-mono)', fontSize: '7px' }}>auto-compress</span>}
                <button className="image-preview-remove" onClick={() => removeImage(i)}>
                  x
                </button>
              </div>
            )
          })}
        </div>
      )}
      {instanceId && <CliPromptBanner instanceId={instanceId} />}
      {instanceId && <PermissionBanner instanceId={instanceId} />}
      {isCommandPending && (
        <div className="pending-command-banner">
          <span className="pending-command-spinner" aria-hidden="true" />
          <span className="pending-command-text">Running {runningCommand}… input locked until it finishes.</span>
          <button
            className="pending-command-cancel"
            onClick={() => instanceId && dispatch({ type: 'CLEAR_PENDING_COMMAND', payload: instanceId })}
            title="Stop waiting — the command keeps running in background. Output will still appear when it finishes."
          >
            Cancel
          </button>
        </div>
      )}
      {instanceId && pendingWakeups?.[instanceId]?.map(w => (
        <WakeupBanner key={w.id} wakeup={w} instanceId={instanceId} />
      ))}
      <div
        className={`message-input-wrapper${isRunning ? ' is-running' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onMouseDown={(e) => {
          // Dead-space click (run-status pill / empty area) focuses the input so the
          // running/time/tokens zone is never a dead zone — click anywhere to type.
          const t = e.target as HTMLElement
          if (t.closest('button') || t.closest('.model-picker') || t.tagName === 'TEXTAREA') return
          e.preventDefault()
          textareaRef.current?.focus()
        }}
      >
        {/* In Ultra Compact Mode a tile's header carries the clock and the token count, so
            the composer must not render a second one — not merely hide it in CSS, since a
            hidden copy would still tick a 1s interval per tile forever. */}
        {isRunning && !text.trim() && !(compact && settings.ultraCompact) && (
          <RunStatus
            startedAt={selectedInstance?.turnStartedAt}
            outputTokens={selectedInstance?.turnOutputTokens}
          />
        )}
        {/* ...but it DOES take the working signal. Ultra Compact drops the typing bubble
            from the transcript (a whole message row that appeared and vanished every turn),
            and the 6px pulsing dot in the header turned out to be too quiet to catch across
            a grid of tiles. The dots live here instead: the composer is always at the
            bottom of every tile, always on screen, and sits exactly where the eye already goes.

            They stay put once you start typing, unlike the run-status chip beside them.
            Drafting a reply mid-turn is precisely when you are looking at the box and not at
            the tile header, and hiding the dots there left that view with no live signal at
            all (the transcript bubble is off in this mode). They reserve their own width, so
            keeping them through a keystroke also removes a layout jump the old gate caused. */}
        {isRunning && compact && settings.ultraCompact && (
          <span className="composer-working" role="img" aria-label="Working…">
            <span /><span /><span />
          </span>
        )}
        {/* How long it has been going, right next to the dots. The same clock is up in the
            tile header, but "is it still moving?" and "how long has it been moving?" are the
            same question, asked at the same moment, by an eye that is on the box — so the
            answer belongs together, in one glance, not split across the tile. */}
        {isRunning && compact && settings.ultraCompact && selectedInstance?.turnStartedAt && (
          <ComposerElapsed startedAt={selectedInstance.turnStartedAt} />
        )}
        <div className="composer-textarea-wrap">
          <textarea
            ref={textareaRef}
            className="message-textarea"
            placeholder={
              isCommandPending ? `Running ${runningCommand}…`
                : isRunning ? ''
                : !instanceId ? 'Select a chat first'
                // Grid tiles are narrow and shown many-at-once: one short, fixed hint
                // keeps every tile identical and one line. The rotating hints (which
                // vary a lot in length) stay in the roomy single-chat composer only.
                : compact ? 'Reply…'
                : PLACEHOLDERS[phIndex]
            }
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            // Going to reply is the cue for a finished task list to get out of the way.
            // The panel decides whether it applies; this only reports the gesture.
            //
            // pointerdown, NOT focus: this composer focuses itself whenever the selected
            // instance changes, so on a page load every tile fired a focus event and every
            // finished list folded itself away before the user had looked at one. A real
            // pointer press cannot be raised by the app focusing an element.
            onPointerDown={() => { if (instanceId) composerFocused(instanceId) }}
            rows={1}
            disabled={!instanceId || isCommandPending}
          />
        </div>
        {/* While a turn runs, the run-status chip + pause button need the width — the
            model badge is hidden (you can't usefully switch model mid-turn anyway) so
            the pause control never gets pushed off the edge of a narrow tile. */}
        {compact && !text.trim() && !isRunning && renderPicker()}
        {selectedInstance?.state === 'running' && !text.trim() && images.length === 0 && !isCommandPending ? (
          // Empty input + run in progress: the send button has nothing to send,
          // so it becomes the pause control for the running turn.
          <button
            className="message-send-btn message-pause-btn"
            onClick={() => { if (instanceId) api.pauseInstance(instanceId).catch(err => window.alert(`Couldn't stop the run: ${err.message}`)) }}
            title="Pause this run"
          >
            &#10074;&#10074;
          </button>
        ) : (
        <button
          className="message-send-btn"
          onClick={handleSend}
          disabled={!instanceId || isCommandPending || (!isBtw && isStreaming) || (!text.trim() && images.length === 0)}
          title="Send message"
          style={{ transition: 'box-shadow 0.2s ease' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 10px 2px rgba(34, 197, 94, 0.5), 0 0 4px 1px rgba(34, 197, 94, 0.3)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none' }}
        >
          &#9654;
        </button>
        )}
      </div>
      {!compact && (
      <div className="message-input-footer">
        {renderPicker()}
        <span className="input-hint" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>Enter to send, Shift+Enter for newline</span>
      </div>
      )}
      {pendingModel && (
        <ModelSwitchWarning
          fromModel={model}
          toModel={pendingModel}
          fromLabel={MODELS.find(m => m.id === model)?.label}
          toLabel={MODELS.find(m => m.id === pendingModel)?.label}
          losesThinking={switchLosesThinking(model, pendingModel)}
          onCompactFirst={() => compactBeforeSwitch(pendingModel)}
          onSwitchAnyway={() => { setModel(pendingModel); setPendingModel(null) }}
          onCancel={() => setPendingModel(null)}
        />
      )}
    </div>
  )
}

import type { ScheduledWakeup } from '../context/MessagesContext'

// Live "running for X · ↓ N tokens" chip in the composer, mirroring the Claude CLI's
// footer. Elapsed ticks client-side off the server-provided turn start; the token count
// is the output generated so far this round-trip (pushed via turn:progress events).
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

/** The full run chip: dot, label, clock, token count. Used by this composer outside Ultra
 *  Compact. Ultra Compact deliberately shows none of it: ComposerElapsed carries the clock
 *  alone, beside the dots, and the token count is gone until it means a session total
 *  rather than the output of whichever turn happens to be running. */
export function RunStatus({ startedAt, outputTokens }: { startedAt?: number; outputTokens?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (!startedAt) return null
  const elapsed = fmtElapsed(now - startedAt)
  const tokens = outputTokens ?? 0
  return (
    <span
      className="run-status"
      title={`Running ${elapsed}${tokens > 0 ? ` · ${tokens.toLocaleString()} output tokens this turn` : ''}`}
    >
      <span className="run-status-dot" aria-hidden="true" />
      <span className="run-status-label">running</span>
      <span className="run-status-sep">·</span>
      <span className="run-status-time">{elapsed}</span>
      {tokens > 0 && (
        <>
          <span className="run-status-sep">·</span>
          <span className="run-status-tokens">↓ {fmtTokens(tokens)}</span>
        </>
      )}
    </span>
  )
}

/** The Ultra Compact composer's clock: elapsed only, no dot / label / token count.
 *  Deliberately not RunStatus-with-things-hidden — a hidden token count would still
 *  be a number this mode has decided not to show, and hiding it in CSS leaves the
 *  work of computing it behind. Shares fmtElapsed so the two clocks can't drift. */
function ComposerElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const elapsed = fmtElapsed(now - startedAt)
  return <span className="composer-working-time" title={`Running ${elapsed}`}>{elapsed}</span>
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'firing…'
  const total = Math.ceil(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function WakeupBanner({ wakeup, instanceId }: { wakeup: ScheduledWakeup; instanceId: string }) {
  const [now, setNow] = useState(Date.now())
  const [cancelling, setCancelling] = useState(false)
  const { dispatch } = useAppDispatch()

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const remaining = wakeup.fireAt - now

  const handleCancel = async () => {
    setCancelling(true)
    // Optimistic — server WS event will also remove, but instant feedback is nicer.
    dispatch({ type: 'REMOVE_WAKEUP', payload: { instanceId, wakeupId: wakeup.id } })
    try {
      await api.cancelWakeup(instanceId, wakeup.id)
    } catch { /* if it failed server-side, the next page reload will resync */ }
  }

  return (
    <div className="wakeup-banner">
      <span className="wakeup-banner-icon" aria-hidden="true">⏱</span>
      <span className="wakeup-banner-text">
        Auto-check in <strong>{fmtCountdown(remaining)}</strong>
        {wakeup.reason && <span className="wakeup-banner-reason"> — {wakeup.reason}</span>}
      </span>
      <button
        className="wakeup-banner-cancel"
        onClick={handleCancel}
        disabled={cancelling}
        title={wakeup.prompt ? `Will fire prompt: "${wakeup.prompt.slice(0, 200)}"` : undefined}
      >
        Cancel
      </button>
    </div>
  )
}

