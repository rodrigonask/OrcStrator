import { useState, useRef, useCallback, useEffect } from 'react'
import { useUI } from '../context/UIContext'
import { useMessages } from '../context/MessagesContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useGame } from '../context/GameContext'
import { useFeatureGate } from '../hooks/useFeatureGate'
import { FeatureLockedModal } from './tour/FeatureLockedModal'
import { CliPromptBanner } from './CliPromptBanner'
import { api } from '../api'
import type { ChatMessage, PermissionMode } from '@shared/types'

const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (latest)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

const EFFORT_LEVELS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'xHigh' },
  { id: 'max', label: 'Max' },
]

const AGENT_MODEL_TO_ID: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
  'opus-4-6': 'claude-opus-4-6',
  'opus-4-7': 'claude-opus-4-7',
  'opus-4-8': 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5-20251001',
  default: 'claude-sonnet-4-6',
}

const DRAFT_KEY = (id: string) => 'draft-' + id
const MODEL_KEY = (id: string) => 'model-' + id
const EFFORT_KEY = (id: string) => 'effort-' + id
const PERM_KEY = (id: string) => 'perm-' + id

const PERMISSION_CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan Mode',
  auto: 'Auto Mode',
  bypassPermissions: 'Bypass',
  dontAsk: "Don't Ask",
}

export function MessageInput() {
  const { selectedInstanceId: instanceId, settings } = useUI()
  const { streamingContent, pendingCommand, pendingWakeups } = useMessages()
  const { instances, folders } = useInstances()
  const { dispatch, sendMessage } = useAppDispatch()
  const { addXp } = useGame()
  const planModeGate = useFeatureGate('plan-mode')

  const defaultModelId = AGENT_MODEL_TO_ID[settings.defaultModel ?? 'default'] ?? 'claude-sonnet-4-6'
  const defaultEffortId = settings.defaultEffort ?? 'high'

  const [text, setText] = useState(() => {
    if (!instanceId) return ''
    return sessionStorage.getItem(DRAFT_KEY(instanceId)) ?? ''
  })
  const defaultPermMode: PermissionMode = settings.permissionMode ?? 'bypassPermissions'
  const [permMode, setPermModeRaw] = useState<PermissionMode>(() => {
    if (!instanceId) return defaultPermMode
    return (sessionStorage.getItem(PERM_KEY(instanceId)) as PermissionMode) || defaultPermMode
  })
  const [model, setModelRaw] = useState(() => {
    if (!instanceId) return defaultModelId
    return sessionStorage.getItem(MODEL_KEY(instanceId)) ?? defaultModelId
  })
  const [effort, setEffortRaw] = useState(() => {
    if (!instanceId) return defaultEffortId
    return sessionStorage.getItem(EFFORT_KEY(instanceId)) ?? defaultEffortId
  })

  const setPermMode = useCallback((v: PermissionMode) => {
    setPermModeRaw(v)
    if (instanceId) sessionStorage.setItem(PERM_KEY(instanceId), v)
  }, [instanceId])

  const cyclePermMode = useCallback(() => {
    setPermModeRaw(prev => {
      const enabled = settings.permissionCycleModes && settings.permissionCycleModes.length > 0
        ? PERMISSION_CYCLE.filter(m => settings.permissionCycleModes!.includes(m))
        : PERMISSION_CYCLE
      const cycle = enabled.length > 0 ? enabled : PERMISSION_CYCLE
      const idx = cycle.indexOf(prev)
      const next = cycle[(idx + 1) % cycle.length]
      if (instanceId) sessionStorage.setItem(PERM_KEY(instanceId), next)
      return next
    })
  }, [instanceId, settings.permissionCycleModes])

  const setModel = useCallback((v: string) => {
    setModelRaw(v)
    if (instanceId) sessionStorage.setItem(MODEL_KEY(instanceId), v)
  }, [instanceId])

  const setEffort = useCallback((v: string) => {
    setEffortRaw(v)
    if (instanceId) sessionStorage.setItem(EFFORT_KEY(instanceId), v)
  }, [instanceId])
  const [images, setImages] = useState<{ base64: string; mediaType: string }[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevInstanceRef = useRef<string | null>(instanceId ?? null)

  const isStreaming = instanceId ? !!streamingContent?.[instanceId] : false
  const runningCommand = instanceId ? pendingCommand?.[instanceId] : undefined
  const isCommandPending = !!runningCommand

  const selectedInstance = instanceId ? instances.find(i => i.id === instanceId) : null
  const selectedFolder = selectedInstance ? folders.find(f => f.id === selectedInstance.folderId) : null
  const isOrchestratorOwned = Boolean(selectedInstance?.orchestratorManaged && selectedFolder?.orchestratorActive)

  // Focus textarea when instance changes (cycling or new selection)
  useEffect(() => {
    if (instanceId) textareaRef.current?.focus()
  }, [instanceId])

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
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
      setModelRaw(sessionStorage.getItem(MODEL_KEY(instanceId)) ?? defaultModelId)
      setEffortRaw(sessionStorage.getItem(EFFORT_KEY(instanceId)) ?? defaultEffortId)
      setPermModeRaw((sessionStorage.getItem(PERM_KEY(instanceId)) as PermissionMode) || defaultPermMode)
    } else {
      setText('')
      setModelRaw(defaultModelId)
      setEffortRaw(defaultEffortId)
      setPermModeRaw(defaultPermMode)
    }
    setImages([])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId])

  const processCommandAction = useCallback((res: { ok: boolean; result: string; action?: string; value?: string; url?: string }) => {
    if (!instanceId) return
    if (!res.action) return
    switch (res.action) {
      case 'clear-history':
        api.clearHistory(instanceId)
        dispatch({ type: 'CLEAR_MESSAGES', payload: instanceId })
        break
      case 'set-model':
        if (res.value) setModel(res.value)
        break
      case 'set-effort':
        if (res.value) setEffort(res.value)
        break
      case 'toggle-fast':
        // Toggle between sonnet (fast) and current
        setModel(m => m === 'claude-sonnet-4-6' ? 'claude-opus-4-8' : 'claude-sonnet-4-6')
        break
      case 'toggle-plan-mode':
        setPlanMode(p => !p)
        break
      case 'set-plan-mode':
        setPlanMode(true)
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
        api.killInstance(instanceId)
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
  }, [instanceId, dispatch, instances, setModel, setEffort])

  const handleSend = useCallback(() => {
    if (!instanceId || (!text.trim() && images.length === 0)) return
    const trimmed = text.trim()

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

      api.sendCommand(instanceId, trimmed).then(res => {
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
      addXp('message-sent')
      return
    }

    const flags = [`--model=${model}`, `--effort=${effort}`]
    if (permMode === 'bypassPermissions') flags.push('--dangerously-skip-permissions')
    else flags.push(`--permission-mode=${permMode}`)
    sendMessage(instanceId, trimmed, images.map(i => i.base64), flags)
    addXp('message-sent')
    // Clear draft from sessionStorage
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    sessionStorage.removeItem(DRAFT_KEY(instanceId))
    setText('')
    setImages([])
  }, [instanceId, text, permMode, model, images, sendMessage, dispatch, processCommandAction, addXp, effort])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    // Shift+Tab cycles permission mode
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      if (planModeGate.check()) cyclePermMode()
    }
    // Ctrl+M cycles model
    if (e.key === 'm' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      const idx = MODELS.findIndex(m => m.id === model)
      setModel(MODELS[(idx + 1) % MODELS.length].id)
    }
    // Ctrl+E cycles effort
    if (e.key === 'e' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      const idx = EFFORT_LEVELS.findIndex(l => l.id === effort)
      setEffort(EFFORT_LEVELS[(idx + 1) % EFFORT_LEVELS.length].id)
    }
  }, [handleSend, cyclePermMode, planModeGate, model, effort, setModel, setEffort])

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

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
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
    // Reset so the same file can be selected again
    e.target.value = ''
  }, [])

  const removeImage = useCallback((index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }, [])

  return (
    <div className="message-input-container">
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
      {isOrchestratorOwned && selectedFolder && (
        <div className="orchestrator-pov-banner">
          <span className="orchestrator-pov-label" style={{ fontFamily: 'var(--font-mono)', fontSize: '7px' }}>Managed by The Orc</span>
          <button
            className="orchestrator-pov-btn"
            onClick={() => {
              dispatch({ type: 'SET_VIEW', payload: 'pipeline' })
              dispatch({ type: 'SET_PIPELINE_PROJECT', projectId: selectedFolder.id })
            }}
          >
            The Orc POV
          </button>
        </div>
      )}
      {instanceId && <CliPromptBanner instanceId={instanceId} />}
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
      {instanceId && <LongSessionWarning instanceId={instanceId} />}
      <div
        className="message-input-wrapper"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <button
          className="message-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={!instanceId || isOrchestratorOwned || isCommandPending}
          title="Attach image"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <textarea
          ref={textareaRef}
          className="message-textarea"
          placeholder={
            isOrchestratorOwned
              ? 'This agent belongs to The Orc now.'
              : isCommandPending ? `Running ${runningCommand}…`
              : instanceId ? 'Type a message...' : 'Select a chat first'
          }
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          disabled={!instanceId || isOrchestratorOwned || isCommandPending}
        />
        <button
          className="message-send-btn"
          onClick={handleSend}
          disabled={!instanceId || isStreaming || isOrchestratorOwned || isCommandPending || (!text.trim() && images.length === 0)}
          title="Send message"
          style={{ transition: 'box-shadow 0.2s ease' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 10px 2px rgba(34, 197, 94, 0.5), 0 0 4px 1px rgba(34, 197, 94, 0.3)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none' }}
        >
          &#9654;
        </button>
      </div>
      <div className="message-input-footer">
        <button
          type="button"
          className={`perm-mode-toggle perm-${permMode}`}
          style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
          onClick={() => { if (planModeGate.check()) cyclePermMode() }}
          title={`Permission mode: ${PERMISSION_LABELS[permMode]}\nClick or Shift+Tab to cycle`}
        >
          {PERMISSION_LABELS[permMode]} <span style={{ opacity: 0.5 }}>(Shift+Tab)</span>
        </button>
        <div className="dropdown-with-hint">
          <div className="model-selector-wrap">
            <select
              className="model-selector"
              value={model}
              onChange={e => setModel(e.target.value)}
              title="Select model (Ctrl+M cycles)"
            >
              {MODELS.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <svg className="model-selector-chevron" viewBox="0 0 12 12" fill="none">
              <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span className="dropdown-shortcut-hint">Ctrl+M</span>
        </div>
        <div className="dropdown-with-hint">
          <div className="model-selector-wrap">
            <select
              className="model-selector"
              value={effort}
              onChange={e => setEffort(e.target.value)}
              title="Effort level (Ctrl+E cycles)"
            >
              {EFFORT_LEVELS.map(e => (
                <option key={e.id} value={e.id}>{e.label}</option>
              ))}
            </select>
            <svg className="model-selector-chevron" viewBox="0 0 12 12" fill="none">
              <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span className="dropdown-shortcut-hint">Ctrl+E</span>
        </div>
        <span className="input-hint" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>Enter to send, Shift+Enter for newline</span>
      </div>

      {planModeGate.showLockedModal && planModeGate.gate && (
        <FeatureLockedModal gate={planModeGate.gate} onClose={planModeGate.dismissModal} />
      )}
    </div>
  )
}

import type { ScheduledWakeup } from '../context/MessagesContext'

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

// Soft warning at 50% context use, hard warning at 80%. The agent's output degrades
// after each /compact (summary loses nuance), so the right move on a long session is
// usually to spawn a fresh chat and carry only the relevant context forward.
function LongSessionWarning({ instanceId }: { instanceId: string }) {
  const { instances } = useInstances()
  const { dispatch } = useAppDispatch()
  const instance = instances.find(i => i.id === instanceId)
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(`longwarn-dismissed-${instanceId}`) === '1')

  if (!instance || dismissed) return null

  const used = instance.ctxTokens ?? 0
  const model = instance.ctxModel ?? ''
  const cap = model.includes('haiku') ? 200_000 : 1_000_000
  const pct = used > 0 ? (used / cap) * 100 : 0

  if (pct < 50) return null

  const isHard = pct >= 80
  const level = isHard ? 'hard' : 'soft'

  const handleDismiss = () => {
    sessionStorage.setItem(`longwarn-dismissed-${instanceId}`, '1')
    setDismissed(true)
  }
  const handleNewChat = () => {
    const inst = instance
    if (!inst) return
    api.createInstance({ folderId: inst.folderId }).then(newInst => {
      dispatch({ type: 'ADD_INSTANCE', payload: newInst })
      dispatch({ type: 'SELECT_INSTANCE', payload: newInst.id })
    }).catch(() => {})
  }

  const msg = isHard
    ? `Context is ${pct.toFixed(0)}% full. /compact will lose detail — start a fresh chat for new work.`
    : `Long session (${pct.toFixed(0)}% context). For unrelated tasks, a fresh chat keeps quality higher than /compact.`

  return (
    <div className={`long-session-warning long-session-${level}`}>
      <span className="long-session-icon" aria-hidden="true">&#x26A0;</span>
      <span className="long-session-text">{msg}</span>
      <button className="long-session-newchat" onClick={handleNewChat}>New chat</button>
      <button className="long-session-dismiss" onClick={handleDismiss} title="Dismiss for this session">&times;</button>
    </div>
  )
}
