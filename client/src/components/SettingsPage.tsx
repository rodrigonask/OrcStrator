import { useState, useCallback, useEffect } from 'react'
import { useFontSize, type FontSizeOption } from '../hooks/useFontSize'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'
import { rest } from '../api/rest'
import { ALLOWED_FLAG_PREFIXES, AVAILABLE_TOOLS, DEFAULT_ROLE_MODELS, DEFAULT_ROLE_TOOLS } from '@shared/constants'
import type { McpServerInfo, AgentModel, AgentRole, PermissionMode } from '@shared/types'
import type { NamingTheme } from '../utils/naming'

const ROLES: AgentRole[] = ['planner', 'builder', 'tester', 'promoter']
const MODEL_OPTIONS: { value: AgentModel; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'haiku', label: 'Haiku (fast/cheap)' },
  { value: 'sonnet', label: 'Sonnet (balanced)' },
  { value: 'opus', label: 'Opus (strongest)' },
]
const TABS = ['General', 'Agents', 'Advanced'] as const
type Tab = typeof TABS[number]

export function SettingsPage() {
  const { settings } = useUI()
  const { dispatch } = useAppDispatch()
  const { fontSize, setFontSize } = useFontSize()

  const [tab, setTab] = useState<Tab>('General')
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
  const [soundsEnabled, setSoundsEnabled] = useState(settings.soundsEnabled !== false)
  const [namingTheme, setNamingTheme] = useState<NamingTheme>(settings.namingTheme || 'fruits')
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([])
  const [mcpLoaded, setMcpLoaded] = useState(false)
  const [roleMcp, setRoleMcp] = useState<Record<string, string[]>>(
    (settings.orchestratorMcpServers as Record<string, string[]> | undefined) ?? {
      planner: [], builder: [], tester: ['playwriter'], promoter: [],
    }
  )
  const [roleModels, setRoleModels] = useState<Record<AgentRole, AgentModel>>(
    (settings.orchestratorModels as Record<AgentRole, AgentModel> | undefined) ?? {
      planner: 'default', builder: 'default', tester: 'default', promoter: 'default',
    }
  )
  const [roleTools, setRoleTools] = useState<Record<AgentRole, string[]>>(
    (settings.orchestratorTools as Record<AgentRole, string[]> | undefined) ?? {
      planner: [...DEFAULT_ROLE_TOOLS.planner],
      builder: [...DEFAULT_ROLE_TOOLS.builder],
      tester: [...DEFAULT_ROLE_TOOLS.tester],
      promoter: [...DEFAULT_ROLE_TOOLS.promoter],
    }
  )
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(settings.permissionMode ?? 'bypass')
  const [disableCache, setDisableCache] = useState(settings.disableCache ?? false)
  const [maxTokens, setMaxTokens] = useState(settings.maxTokens ?? 0)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    rest.getMcpAvailable().then(r => {
      setMcpServers(r.servers)
      setMcpLoaded(true)
    }).catch(() => setMcpLoaded(true))
  }, [])

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

  const toggleRoleMcp = useCallback((role: string, serverName: string) => {
    setRoleMcp(prev => {
      const current = prev[role] ?? []
      const next = current.includes(serverName)
        ? current.filter(s => s !== serverName)
        : [...current, serverName]
      return { ...prev, [role]: next }
    })
  }, [])

  const toggleRoleTool = useCallback((role: AgentRole, tool: string) => {
    setRoleTools(prev => {
      const current = prev[role] ?? []
      const next = current.includes(tool)
        ? current.filter(t => t !== tool)
        : [...current, tool]
      return { ...prev, [role]: next }
    })
  }, [])

  const handleSave = useCallback(() => {
    const cleanFlags = flags.filter(f =>
      !f.startsWith('--dangerously-skip-permissions') &&
      !f.startsWith('--permission-mode')
    )
    if (permissionMode === 'bypass') cleanFlags.push('--dangerously-skip-permissions')
    else if (permissionMode !== 'default') cleanFlags.push(`--permission-mode=${permissionMode}`)

    const payload = {
      globalFlags: cleanFlags,
      idleTimeoutSeconds: idleTimeout,
      notifications,
      rootFolder,
      usagePollMinutes: usagePoll,
      theme,
      orchestratorAgentNames: agentNames,
      orchestratorAllowSpawn: allowSpawn,
      orchestratorMcpServers: roleMcp as { planner: string[]; builder: string[]; tester: string[]; promoter: string[] },
      orchestratorModels: roleModels,
      orchestratorTools: roleTools,
      permissionMode,
      disableCache,
      maxTokens: maxTokens > 0 ? maxTokens : undefined,
      animationsEnabled,
      soundsEnabled,
      namingTheme,
    }
    dispatch({ type: 'UPDATE_SETTINGS', payload })
    api.updateSettings(payload)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [dispatch, flags, idleTimeout, notifications, rootFolder, usagePoll, theme, agentNames, allowSpawn, roleMcp, roleModels, roleTools, permissionMode, disableCache, maxTokens, animationsEnabled, soundsEnabled, namingTheme])

  const handleBack = useCallback(() => {
    dispatch({ type: 'CLOSE_SETTINGS' })
  }, [dispatch])

  const sectionTitle = (text: string) => (
    <div className="settings-section-title">{text}</div>
  )

  return (
    <div className="settings-page">
      {/* Header */}
      <div className="settings-page-header">
        <button className="settings-back-btn" onClick={handleBack}>
          <span style={{ marginRight: 6 }}>&larr;</span> Back
        </button>
        <h1 className="settings-page-title">Settings</h1>
        <button
          className={`btn btn-primary settings-save-btn ${saved ? 'saved' : ''}`}
          onClick={handleSave}
        >
          {saved ? 'Saved!' : 'Save'}
        </button>
      </div>

      {/* Tabs */}
      <div className="settings-page-tabs">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`settings-tab ${tab === t ? 'active' : ''}`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="settings-page-content">
        <div className="settings-page-inner">

          {/* === GENERAL TAB === */}
          {tab === 'General' && (
            <div className="settings-grid">
              <div className="settings-col">
                {/* Permission Mode */}
                <div className="settings-card">
                  {sectionTitle('Permission Mode')}
                  <select
                    className="form-select"
                    value={permissionMode}
                    onChange={e => setPermissionMode(e.target.value as PermissionMode)}
                  >
                    <option value="bypass">Bypass (auto-approve all)</option>
                    <option value="plan">Plan (read-only)</option>
                    <option value="default">Default (ask every action)</option>
                  </select>
                </div>

                {/* Theme */}
                <div className="settings-card">
                  {sectionTitle('Theme')}
                  <div className="form-radio-group">
                    {(['dark', 'light', 'system'] as const).map(t => (
                      <label key={t} className="form-radio-label">
                        <input type="radio" name="theme" checked={theme === t} onChange={() => setTheme(t)} />
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </label>
                    ))}
                  </div>
                </div>

                {/* Session Naming */}
                <div className="settings-card">
                  {sectionTitle('Session Naming')}
                  <select
                    className="form-select"
                    value={namingTheme}
                    onChange={e => setNamingTheme(e.target.value as NamingTheme)}
                  >
                    <option value="fruits">Fruits</option>
                    <option value="rpg">RPG Characters</option>
                    <option value="wow">World of Warcraft</option>
                    <option value="memes">Meme Names</option>
                  </select>
                </div>

                {/* Font Size */}
                <div className="settings-card">
                  {sectionTitle('Font Size')}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    {(['small', 'medium', 'large', 'giant'] as FontSizeOption[]).map(size => (
                      <button
                        key={size}
                        onClick={() => setFontSize(size)}
                        className={`settings-size-btn ${fontSize === size ? 'active' : ''}`}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="settings-col">
                {/* Animations & Sounds */}
                <div className="settings-card">
                  {sectionTitle('Animations & Sounds')}
                  <div className="settings-toggle">
                    <span className="settings-toggle-label">Instance card animations</span>
                    <div className={`toggle-switch ${animationsEnabled ? 'active' : ''}`} onClick={() => setAnimationsEnabled(v => !v)} />
                  </div>
                  <div className="settings-toggle" style={{ marginTop: 8 }}>
                    <span className="settings-toggle-label">Sound effects</span>
                    <div className={`toggle-switch ${soundsEnabled ? 'active' : ''}`} onClick={() => setSoundsEnabled(v => !v)} />
                  </div>
                </div>

                {/* Notifications */}
                <div className="settings-card">
                  {sectionTitle('Notifications')}
                  <div className="settings-toggle">
                    <span className="settings-toggle-label">Desktop notifications</span>
                    <div className={`toggle-switch ${notifications ? 'active' : ''}`} onClick={() => setNotifications(n => !n)} />
                  </div>
                </div>

              </div>
            </div>
          )}

          {/* === AGENTS TAB === */}
          {tab === 'Agents' && (
            <div className="settings-grid">
              <div className="settings-col">
                {/* Agent Names */}
                <div className="settings-card">
                  {sectionTitle('Agent Names')}
                  {ROLES.map(role => (
                    <div className="form-group" key={role} style={{ marginBottom: 8 }}>
                      <label className="form-label" style={{ textTransform: 'capitalize' }}>{role}</label>
                      <input
                        className="form-input"
                        value={agentNames[role]}
                        onChange={e => setAgentNames(n => ({ ...n, [role]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>

                {/* Model per Role */}
                <div className="settings-card">
                  {sectionTitle('Model per Role')}
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
                    "Default" uses the role's built-in tier. Failed tasks auto-escalate to Opus.
                  </p>
                  {ROLES.map(role => (
                    <div key={role} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, width: 70, textTransform: 'capitalize' }}>
                        {role}
                      </span>
                      <select
                        className="form-select"
                        style={{ flex: 1 }}
                        value={roleModels[role]}
                        onChange={e => setRoleModels(m => ({ ...m, [role]: e.target.value as AgentModel }))}
                      >
                        {MODEL_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}{opt.value === 'default' ? ` (${DEFAULT_ROLE_MODELS[role]})` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              <div className="settings-col">
                {/* Tools per Role */}
                <div className="settings-card">
                  {sectionTitle('Tools per Role')}
                  {ROLES.map(role => (
                    <div key={role} style={{ marginBottom: 10 }}>
                      <div className="form-label" style={{ textTransform: 'capitalize', marginBottom: 4 }}>{agentNames[role]}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {AVAILABLE_TOOLS.map(tool => {
                          const active = (roleTools[role] ?? []).includes(tool)
                          return (
                            <button
                              key={tool}
                              onClick={() => toggleRoleTool(role, tool)}
                              className={`settings-tool-btn ${active ? 'active' : ''}`}
                            >
                              {tool}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                {/* MCP Servers per Role */}
                {mcpLoaded && mcpServers.length > 0 && (
                  <div className="settings-card">
                    {sectionTitle('MCP Servers per Role')}
                    {ROLES.map(role => (
                      <div key={role} style={{ marginBottom: 10 }}>
                        <div className="form-label" style={{ textTransform: 'capitalize', marginBottom: 4 }}>{agentNames[role]}</div>
                        <div className="mcp-role-servers">
                          {mcpServers.map(srv => (
                            <label key={srv.name} className="mcp-role-server-row">
                              <input
                                type="checkbox"
                                checked={(roleMcp[role] ?? []).includes(srv.name)}
                                onChange={() => toggleRoleMcp(role, srv.name)}
                              />
                              <span className="mcp-srv-name">{srv.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Auto Spawn */}
                <div className="settings-card">
                  <div className="settings-toggle" style={{ opacity: 0.5 }}>
                    <span className="settings-toggle-label">
                      Allow The Orc to spawn new agents
                      <br />
                      <em style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Not yet trusted with a credit card.</em>
                    </span>
                    <div className={`toggle-switch ${allowSpawn ? 'active' : ''}`} style={{ pointerEvents: 'none', opacity: 0.4 }} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* === ADVANCED TAB === */}
          {tab === 'Advanced' && (
            <div className="settings-grid">
              <div className="settings-col">
                {/* Cache Control */}
                <div className="settings-card">
                  {sectionTitle('Cache Control')}
                  <div className="settings-toggle">
                    <span className="settings-toggle-label">Disable prompt caching (--no-cache)</span>
                    <div className={`toggle-switch ${disableCache ? 'active' : ''}`} onClick={() => setDisableCache(v => !v)} />
                  </div>
                </div>

                {/* Max Tokens */}
                <div className="settings-card">
                  {sectionTitle('Max Output Tokens')}
                  <div className="form-group">
                    <label className="form-label">0 = unlimited (model default)</label>
                    <input
                      type="number"
                      className="form-input"
                      value={maxTokens}
                      onChange={e => setMaxTokens(Number(e.target.value))}
                      min={0}
                      step={1000}
                      placeholder="0"
                    />
                  </div>
                </div>

                {/* Idle Timeout */}
                <div className="settings-card">
                  {sectionTitle('Idle Timeout')}
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
              </div>

              <div className="settings-col">
                {/* Usage Poll */}
                <div className="settings-card">
                  {sectionTitle('Usage Poll Interval')}
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

                {/* Root Folder */}
                <div className="settings-card">
                  {sectionTitle('Root Folder')}
                  <input
                    className="form-input"
                    placeholder="/path/to/projects"
                    value={rootFolder}
                    onChange={e => setRootFolder(e.target.value)}
                  />
                </div>

                {/* Raw CLI Flags */}
                <div className="settings-card">
                  {sectionTitle('Raw CLI Flags')}
                  <div className="settings-flag-list">
                    {flags.filter(f => !f.startsWith('--dangerously-skip-permissions') && !f.startsWith('--permission-mode')).map(flag => (
                      <span key={flag} className="settings-flag">
                        {flag}
                        <button className="settings-flag-remove" onClick={() => removeFlag(flag)}>x</button>
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
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
