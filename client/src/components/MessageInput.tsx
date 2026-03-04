import { useState, useRef, useCallback, useEffect } from 'react'
import { useApp } from '../context/AppContext'
import { api } from '../api'

export function MessageInput() {
  const { state } = useApp()
  const [text, setText] = useState('')
  const [planMode, setPlanMode] = useState(false)
  const [images, setImages] = useState<{ base64: string; mediaType: string }[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const instanceId = state.selectedInstanceId

  const isStreaming = instanceId ? state.streaming?.[instanceId] : false

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [text])

  const handleSend = useCallback(() => {
    if (!instanceId || (!text.trim() && images.length === 0)) return
    api.sendMessage(instanceId, text.trim(), { planMode, images })
    setText('')
    setImages([])
    setPlanMode(false)
  }, [instanceId, text, planMode, images])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    // Shift+Tab toggles plan mode
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      setPlanMode(p => !p)
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

  const removeImage = useCallback((index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }, [])

  return (
    <div className="message-input-container">
      {images.length > 0 && (
        <div className="image-preview-strip">
          {images.map((img, i) => (
            <div key={i} className="image-preview-item">
              <img src={`data:${img.mediaType};base64,${img.base64}`} alt="" />
              <button className="image-preview-remove" onClick={() => removeImage(i)}>
                x
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className="message-input-wrapper"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <textarea
          ref={textareaRef}
          className="message-textarea"
          placeholder={instanceId ? 'Type a message...' : 'Select an instance first'}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          disabled={!instanceId}
        />
        <button
          className="message-send-btn"
          onClick={handleSend}
          disabled={!instanceId || isStreaming || (!text.trim() && images.length === 0)}
          title="Send message"
        >
          &#9654;
        </button>
      </div>
      <div className="message-input-footer">
        <label className={`plan-mode-toggle ${planMode ? 'active' : ''}`}>
          <input
            type="checkbox"
            checked={planMode}
            onChange={e => setPlanMode(e.target.checked)}
          />
          Plan Mode (Shift+Tab)
        </label>
        <span className="input-hint">Enter to send, Shift+Enter for newline</span>
      </div>
    </div>
  )
}
