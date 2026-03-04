import { useState, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { ALLOWED_FLAG_PREFIXES } from '@shared/constants'

interface SettingsModalProps {
  onClose: () => void
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { state, dispatch } = useApp()
  const settings = state.settings

  const [flags, setFlags] = useState<string[]>([...settings.globalFlags])
  const [newFlag, setNewFlag] = useState('')
  const [idleTimeout, setIdleTimeout] = useState(settings.idleTimeoutSeconds)
  const [notifications, setNotifications] = useState(settings.notifications)
  const [rootFolder, setRootFolder] = useState(settings.rootFolder)
  const [usagePoll, setUsagePoll] = useState(settings.usagePollMinutes)
  const [theme, setTheme] = useState(settings.theme)

  const oauthConnected = state.usage?.connected ?? false

  const addFlag = useCallback(() => {
    const trimmed = newFlag.trim()
    if (!trimmed) return
    const isValid = ALLOWED_FLAG_PREFIXES.some(p => trimmed.startsWith(p))
    if (!isValid) {
      alert('Flag not in allowed list: ' + ALLOWED_FLAG_PREFIXES.join(', '))
      return
    }
    if (!flags.includes(trimmed)) {
      setFlags(f => [...f, trimmed])
    }
    setNewFlag('')
  }, [newFlag, flags])

  const removeFlag = useCallback((flag: string) => {
    setFlags(f => f.filter(fl => fl !== flag))
  }, [])

  const handleSave = useCallback(() => {
    dispatch({
      type: 'UPDATE_SETTINGS',
      settings: {
        ...settings,
        globalFlags: flags,
        idleTimeoutSeconds: idleTimeout,
        notifications,
        rootFolder,
        usagePollMinutes: usagePoll,
        theme,
      },
    })
    api.updateSettings({
      globalFlags: flags,
      idleTimeoutSeconds: idleTimeout,
      notifications,
      rootFolder,
      usagePollMinutes: usagePoll,
      theme,
    })
    onClose()
  }, [dispatch, settings, flags, idleTimeout, notifications, rootFolder, usagePoll, theme, onClose])

  const handleOAuthConnect = useCallback(() => {
    api.connectOAuth()
  }, [])

  const handleOAuthDisconnect = useCallback(() => {
    api.disconnectOAuth()
  }, [])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Settings</span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body">
          {/* CLI Flags */}
          <div className="settings-section">
            <div className="settings-section-title">CLI Flags</div>
            <div className="settings-flag-list">
              {flags.map(flag => (
                <span key={flag} className="settings-flag">
                  {flag}
                  <button className="settings-flag-remove" onClick={() => removeFlag(flag)}>
                    x
                  </button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <input
                className="form-input"
                placeholder="--flag-name"
                value={newFlag}
                onChange={e => setNewFlag(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addFlag()}
                style={{ flex: 1 }}
              />
              <button className="btn btn-sm" onClick={addFlag}>Add</button>
            </div>
          </div>

          {/* Idle Timeout */}
          <div className="settings-section">
            <div className="settings-section-title">Idle Timeout</div>
            <div className="form-group">
              <label className="form-label">Seconds before idle restart</label>
              <input
                type="number"
                className="form-input"
                value={idleTimeout}
                onChange={e => setIdleTimeout(Number(e.target.value))}
                min={0}
                step={10}
              />
            </div>
          </div>

          {/* Notifications */}
          <div className="settings-section">
            <div className="settings-section-title">Notifications</div>
            <div className="settings-toggle">
              <span className="settings-toggle-label">Desktop notifications</span>
              <div
                className={`toggle-switch ${notifications ? 'active' : ''}`}
                onClick={() => setNotifications(n => !n)}
              />
            </div>
          </div>

          {/* Root Folder */}
          <div className="settings-section">
            <div className="settings-section-title">Root Folder</div>
            <div className="form-group">
              <input
                className="form-input"
                placeholder="/path/to/projects"
                value={rootFolder}
                onChange={e => setRootFolder(e.target.value)}
              />
            </div>
          </div>

          {/* Usage Poll */}
          <div className="settings-section">
            <div className="settings-section-title">Usage Poll Interval</div>
            <div className="form-group">
              <label className="form-label">Minutes between usage checks</label>
              <input
                type="number"
                className="form-input"
                value={usagePoll}
                onChange={e => setUsagePoll(Number(e.target.value))}
                min={1}
                max={60}
              />
            </div>
          </div>

          {/* Theme */}
          <div className="settings-section">
            <div className="settings-section-title">Theme</div>
            <div className="form-radio-group">
              {(['dark', 'light', 'system'] as const).map(t => (
                <label key={t} className="form-radio-label">
                  <input
                    type="radio"
                    name="theme"
                    checked={theme === t}
                    onChange={() => setTheme(t)}
                  />
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </label>
              ))}
            </div>
          </div>

          {/* OAuth */}
          <div className="settings-section">
            <div className="settings-section-title">Usage API (OAuth)</div>
            <div className="oauth-section">
              <span className={`oauth-status ${oauthConnected ? 'connected' : ''}`}>
                {oauthConnected ? 'Connected' : 'Not connected'}
              </span>
              {oauthConnected ? (
                <button className="btn btn-sm btn-danger" onClick={handleOAuthDisconnect}>
                  Disconnect
                </button>
              ) : (
                <button className="btn btn-sm btn-primary" onClick={handleOAuthConnect}>
                  Connect
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  )
}
