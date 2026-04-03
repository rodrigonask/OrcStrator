import { useState, useRef, useCallback, useEffect } from 'react'
import { useUI } from '../context/UIContext'
import { useMessages } from '../context/MessagesContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useGame } from '../context/GameContext'
import { useFeatureGate } from '../hooks/useFeatureGate'
import { FeatureLockedModal } from './tour/FeatureLockedModal'

const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

const EFFORT_LEVELS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
]

const AGENT_MODEL_TO_ID: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
  default: 'claude-sonnet-4-6',
}

const DRAFT_KEY = (id: string) => 'draft-' + id

export function MessageInput() {
  const { selectedInstanceId: instanceId, settings } = useUI()
  const { streamingContent } = useMessages()
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
  const [planMode, setPlanMode] = useState(false)
  const [model, setModel] = useState(defaultModelId)
  const [effort, setEffort] = useState(defaultEffortId)
  const [images, setImages] = useState<{ base64: string; mediaType: string }[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevInstanceRef = useRef<string | null>(instanceId ?? null)

  const isStreaming = instanceId ? !!streamingContent?.[instanceId] : false

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

  // Restore draft + reset model/effort when switching instances
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
    // Restore draft for new instance, reset model/effort to settings defaults
    if (instanceId) {
      setText(sessionStorage.getItem(DRAFT_KEY(instanceId)) ?? '')
    } else {
      setText('')
    }
    setModel(defaultModelId)
    setEffort(defaultEffortId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId])

  const handleSend = useCallback(() => {
    if (!instanceId || (!text.trim() && images.length === 0)) return
    const messageText = planMode ? 'Use plan mode. ' + text.trim() : text.trim()
    sendMessage(instanceId, messageText, images.map(i => i.base64), [`--model=${model}`, `--effort=${effort}`])
    addXp('message-sent')
    // Clear draft from sessionStorage
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    sessionStorage.removeItem(DRAFT_KEY(instanceId))
    setText('')
    setImages([])
    setPlanMode(false)
  }, [instanceId, text, planMode, model, images, sendMessage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    // Shift+Tab toggles plan mode
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      if (planModeGate.check()) setPlanMode(p => !p)
    }
  }, [handleSend])

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
          disabled={!instanceId || isOrchestratorOwned}
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
              : instanceId ? 'Type a message...' : 'Select a chat first'
          }
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          disabled={!instanceId || isOrchestratorOwned}
        />
        <button
          className="message-send-btn"
          onClick={handleSend}
          disabled={!instanceId || isStreaming || isOrchestratorOwned || (!text.trim() && images.length === 0)}
          title="Send message"
          style={{ transition: 'box-shadow 0.2s ease' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 10px 2px rgba(34, 197, 94, 0.5), 0 0 4px 1px rgba(34, 197, 94, 0.3)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none' }}
        >
          &#9654;
        </button>
      </div>
      <div className="message-input-footer">
        <label className={`plan-mode-toggle ${planMode ? 'active' : ''}`} style={{ fontFamily: 'var(--font-mono)', fontSize: '7px' }}>
          <input
            type="checkbox"
            checked={planMode}
            onChange={e => { if (planModeGate.check()) setPlanMode(e.target.checked) }}
          />
          Plan Mode (Shift+Tab)
        </label>
        <div className="model-selector-wrap">
          <select
            className="model-selector"
            value={model}
            onChange={e => setModel(e.target.value)}
            title="Select model"
          >
            {MODELS.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <svg className="model-selector-chevron" viewBox="0 0 12 12" fill="none">
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div className="model-selector-wrap">
          <select
            className="model-selector"
            value={effort}
            onChange={e => setEffort(e.target.value)}
            title="Effort level"
          >
            {EFFORT_LEVELS.map(e => (
              <option key={e.id} value={e.id}>{e.label}</option>
            ))}
          </select>
          <svg className="model-selector-chevron" viewBox="0 0 12 12" fill="none">
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <span className="input-hint" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>Enter to send, Shift+Enter for newline</span>
      </div>

      {planModeGate.showLockedModal && planModeGate.gate && (
        <FeatureLockedModal gate={planModeGate.gate} onClose={planModeGate.dismissModal} />
      )}
    </div>
  )
}
