import { useState, useCallback, useEffect } from 'react'
import type { FolderConfig } from '@shared/types'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useFeatureGate } from '../hooks/useFeatureGate'
import { FeatureLockedModal } from './tour/FeatureLockedModal'
import { api } from '../api'

interface ProjectEditModalProps {
  folder: FolderConfig
  onClose: () => void
}

const PROJECT_COLORS = [
  '#7c3aed', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#8b5cf6', '#06b6d4', '#84cc16', '#f97316',
  '#6366f1', '#14b8a6', '#eab308', '#e11d48', '#6b7280',
]

const EMOJI_OPTIONS = [
  '\uD83D\uDCC1', '\uD83D\uDE80', '\uD83D\uDCBB', '\uD83C\uDFAE', '\uD83D\uDEE0',
  '\u2B50', '\uD83D\uDD25', '\uD83D\uDC8E', '\uD83C\uDF1F', '\uD83E\uDDE9',
  '\uD83D\uDCCA', '\uD83C\uDFA8', '\uD83D\uDD2C', '\uD83C\uDFAF', '\uD83D\uDCA1',
  '\uD83E\uDD16', '\uD83D\uDEA7', '\uD83D\uDCDD', '\uD83D\uDD12', '\uD83C\uDF0D',
]

const PROJECT_TYPES = [
  { value: 'saas-app', label: 'SaaS App' },
  { value: 'landing-page', label: 'Landing Page' },
  { value: 'static-site', label: 'Static Site' },
  { value: 'game', label: 'Game' },
  { value: 'utility', label: 'Utility' },
  { value: 'other', label: 'Other' },
]

export function ProjectEditModal({ folder, onClose }: ProjectEditModalProps) {
  const { dispatch } = useAppDispatch()
  const contextToolsGate = useFeatureGate('context-tools')

  const [displayName, setDisplayName] = useState(folder.displayName || folder.name)
  const [emoji, setEmoji] = useState(folder.emoji || '\uD83D\uDCC1')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [client, setClient] = useState(folder.client || '')
  const [projectType, setProjectType] = useState(folder.projectType || 'other')
  const [color, setColor] = useState(folder.color || '#7c3aed')
  const [status, setStatus] = useState<'active' | 'paused' | 'archived'>(folder.status || 'active')
  const [repoUrl, setRepoUrl] = useState(folder.repoUrl || '')
  const [notes, setNotes] = useState(folder.notes || '')
  const [stealthMode, setStealthMode] = useState(folder.stealthMode || false)
  const [activeTab, setActiveTab] = useState<'settings' | 'claude-md'>('settings')
  const [claudeMdContent, setClaudeMdContent] = useState<string | null>(null)
  const [claudeMdSaving, setClaudeMdSaving] = useState(false)
  const [claudeMdMsg, setClaudeMdMsg] = useState('')

  useEffect(() => {
    if (activeTab === 'claude-md' && claudeMdContent === null) {
      api.checkClaudeMd(folder.path).then(res => {
        setClaudeMdContent(res.content ?? '')
      }).catch(() => setClaudeMdContent(''))
    }
  }, [activeTab, folder.path, claudeMdContent])

  const handleSaveClaudeMd = useCallback(async () => {
    if (claudeMdContent === null) return
    setClaudeMdSaving(true)
    setClaudeMdMsg('')
    try {
      await api.writeClaudeMd(folder.path, claudeMdContent)
      setClaudeMdMsg('Saved')
    } catch {
      setClaudeMdMsg('Save failed')
    } finally {
      setClaudeMdSaving(false)
    }
  }, [folder.path, claudeMdContent])

  const handleSave = useCallback(() => {
    const updated: Partial<FolderConfig> = {
      displayName,
      emoji,
      client,
      projectType: projectType as FolderConfig['projectType'],
      color,
      status,
      repoUrl,
      notes,
      stealthMode,
    }
    dispatch({ type: 'UPDATE_FOLDER', payload: { id: folder.id, updates: updated } })
    api.updateFolder(folder.id, updated)
    onClose()
  }, [dispatch, folder.id, displayName, emoji, client, projectType, color, status, repoUrl, notes, stealthMode, onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>Edit Project</span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-tabs">
          <button
            className={`modal-tab ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}
          >
            Settings
          </button>
          <button
            className={`modal-tab ${activeTab === 'claude-md' ? 'active' : ''}`}
            onClick={() => { if (contextToolsGate.check()) setActiveTab('claude-md') }}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}
          >
            CLAUDE.md
          </button>
        </div>
        <div className="modal-body">
          {activeTab === 'claude-md' && (
            <div className="claude-md-editor">
              <div className="claude-md-header">
                <span className="claude-md-path" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>{folder.path}/CLAUDE.md</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {claudeMdMsg && <span className="claude-md-msg">{claudeMdMsg}</span>}
                  <button className="btn btn-primary" onClick={handleSaveClaudeMd} disabled={claudeMdSaving}>
                    {claudeMdSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
              <textarea
                className="claude-md-textarea"
                value={claudeMdContent ?? ''}
                onChange={e => setClaudeMdContent(e.target.value)}
                placeholder="Loading..."
                spellCheck={false}
              />
            </div>
          )}
          {activeTab === 'settings' && <>
          {/* Emoji + Display Name */}
          <div className="form-row">
            <div className="form-group" style={{ flex: '0 0 auto' }}>
              <label className="form-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>Icon</label>
              <div style={{ position: 'relative' }}>
                <button
                  className="emoji-picker-btn"
                  onClick={() => setShowEmojiPicker(s => !s)}
                >
                  {emoji}
                </button>
                {showEmojiPicker && (
                  <div className="emoji-grid">
                    {EMOJI_OPTIONS.map(e => (
                      <button
                        key={e}
                        className="emoji-option"
                        onClick={() => { setEmoji(e); setShowEmojiPicker(false) }}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>Display Name</label>
              <input
                className="form-input"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
              />
            </div>
          </div>

          {/* Client */}
          <div className="form-group">
            <label className="form-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>Client</label>
            <input
              className="form-input"
              placeholder="Client or team name"
              value={client}
              onChange={e => setClient(e.target.value)}
            />
          </div>

          {/* Project Type */}
          <div className="form-group">
            <label className="form-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>Project Type</label>
            <select
              className="form-select"
              value={projectType}
              onChange={e => setProjectType((e.target.value as FolderConfig['projectType']) ?? 'other')}
            >
              {PROJECT_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Color */}
          <div className="form-group">
            <label className="form-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>Color</label>
            <div className="color-swatches">
              {PROJECT_COLORS.map(c => (
                <div
                  key={c}
                  className={`color-swatch ${color === c ? 'selected' : ''}`}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>

          {/* Status */}
          <div className="form-group">
            <label className="form-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>Status</label>
            <div className="form-radio-group">
              {(['active', 'paused', 'archived'] as const).map(s => (
                <label key={s} className="form-radio-label">
                  <input
                    type="radio"
                    name="status"
                    checked={status === s}
                    onChange={() => setStatus(s)}
                  />
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </label>
              ))}
            </div>
          </div>

          {/* Repo URL */}
          <div className="form-group">
            <label className="form-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>Repository URL</label>
            <input
              className="form-input"
              placeholder="https://github.com/..."
              value={repoUrl}
              onChange={e => setRepoUrl(e.target.value)}
            />
          </div>

          {/* Notes */}
          <div className="form-group">
            <label className="form-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>Notes</label>
            <textarea
              className="form-textarea"
              placeholder="Project notes..."
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>

          {/* Stealth Mode */}
          <div className="form-group">
            <label className="stealth-toggle">
              <input
                type="checkbox"
                checked={stealthMode}
                onChange={e => setStealthMode(e.target.checked)}
              />
              <span>👻 Stealth Mode — conversations do not save memory or persist context</span>
            </label>
          </div>
          </>}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          {activeTab === 'settings' && <button className="btn btn-primary" onClick={handleSave}>Save</button>}
        </div>
      </div>

      {contextToolsGate.showLockedModal && contextToolsGate.gate && (
        <FeatureLockedModal gate={contextToolsGate.gate} onClose={contextToolsGate.dismissModal} />
      )}
    </div>
  )
}
