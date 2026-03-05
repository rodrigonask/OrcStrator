import { useState, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { ALLOWED_FLAG_PREFIXES } from '@shared/constants'
import type { NamingTheme } from '../utils/naming'

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
  const defaultNames = { planner: 'Planner', builder: 'Builder', tester: 'Tester', promoter: 'Promoter' }
  const [agentNames, setAgentNames] = useState(settings.orchestratorAgentNames || defaultNames)
  const [allowSpawn, setAllowSpawn] = useState(settings.orchestratorAllowSpawn || false)
  const [animationsEnabled, setAnimationsEnabled] = useState(settings.animationsEnabled !== false)
  const [soundsEnabled, setSoundsEnabled] = useState(settings.soundsEnabled === true)
  const [namingTheme, setNamingTheme] = useState<NamingTheme>(settings.namingTheme || 'fruits')

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
      payload: {
        globalFlags: flags,
        idleTimeoutSeconds: idleTimeout,
        notifications,
        rootFolder,
        usagePollMinutes: usagePoll,
        theme,
        orchestratorAgentNames: agentNames,
        orchestratorAllowSpawn: allowSpawn,
        animationsEnabled,
        soundsEnabled,
        namingTheme,
      },
    })
    api.updateSettings({
      globalFlags: flags,
      idleTimeoutSeconds: idleTimeout,
      notifications,
      rootFolder,
      usagePollMinutes: usagePoll,
      theme,
      orchestratorAgentNames: agentNames,
      orchestratorAllowSpawn: allowSpawn,
      animationsEnabled,
      soundsEnabled,
      namingTheme,
    })
    onClose()
  }, [dispatch, settings, flags, idleTimeout, notifications, rootFolder, usagePoll, theme, onClose])

  const handleOAuthConnect = useCallback(async () => {
    try {
      const { url } = await api.getAuthUrl()
      window.open(url, '_blank')
      const code = prompt('Paste the authorization code:')
      if (code) {
        await api.exchangeCode(code)
        const usage = await api.getUsage()
        dispatch({ type: 'SET_USAGE', payload: usage })
      }
    } catch (err) {
      console.error('OAuth connect failed:', err)
    }
  }, [dispatch])

  const handleOAuthDisconnect = useCallback(async () => {
    try {
      await api.disconnectUsage()
      dispatch({ type: 'SET_USAGE', payload: null })
    } catch (err) {
      console.error('OAuth disconnect failed:', err)
    }
  }, [dispatch])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Settings</span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body">
          {/* Session Naming */}
          <div className="settings-section">
            <div className="settings-section-title">Session Naming</div>
            <label className="form-label">Name theme for new sessions</label>
            <select
              className="form-select"
              value={namingTheme}
              onChange={e => setNamingTheme(e.target.value as NamingTheme)}
            >
              <option value="fruits">🍎 Fruits</option>
              <option value="rpg">⚔️ RPG Characters</option>
              <option value="wow">🌋 World of Warcraft</option>
              <option value="memes">😂 Meme Names</option>
            </select>
          </div>

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

          {/* Animations & Sounds */}
          <div className="settings-section">
            <div className="settings-section-title">Animations & Sounds</div>
            <div className="settings-toggle">
              <span className="settings-toggle-label">Instance card animations</span>
              <div
                className={`toggle-switch ${animationsEnabled ? 'active' : ''}`}
                onClick={() => setAnimationsEnabled(v => !v)}
              />
            </div>
            <div className="settings-toggle" style={{ marginTop: 8 }}>
              <span className="settings-toggle-label">Sound effects</span>
              <div
                className={`toggle-switch ${soundsEnabled ? 'active' : ''}`}
                onClick={() => setSoundsEnabled(v => !v)}
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
        {/* Orchestrator */}
          <div className="settings-section">
            <div className="settings-section-title">The Orc</div>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
              Agent names shown in the UI and injected into prompts.
            </p>
            {(['planner', 'builder', 'tester', 'promoter'] as const).map(role => (
              <div className="form-group" key={role} style={{ marginBottom: 8 }}>
                <label className="form-label" style={{ textTransform: 'capitalize' }}>{role}</label>
                <input
                  className="form-input"
                  value={agentNames[role]}
                  onChange={e => setAgentNames(n => ({ ...n, [role]: e.target.value }))}
                />
              </div>
            ))}
            <div className="settings-toggle" style={{ marginTop: 12, opacity: 0.5 }}>
              <span className="settings-toggle-label" title="Coming soon — The Orc is not yet trusted with a credit card.">
                Allow The Orc to spawn new agents
                <br />
                <em style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Currently disabled. The Orc is not yet trusted with a credit card.</em>
              </span>
              <div
                className={`toggle-switch ${allowSpawn ? 'active' : ''}`}
                style={{ pointerEvents: 'none', opacity: 0.4 }}
              />
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
