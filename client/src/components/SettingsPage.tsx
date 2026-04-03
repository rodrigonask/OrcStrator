import { useState, useCallback, useEffect } from 'react'
import { useFontSize, type FontSizeOption } from '../hooks/useFontSize'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useGame } from '../context/GameContext'
import { api } from '../api'
import { rest } from '../api/rest'
import { useConfirm } from './ConfirmModal'
import { ALLOWED_FLAG_PREFIXES, AVAILABLE_TOOLS, DEFAULT_ROLE_MODELS, DEFAULT_ROLE_TOOLS, DEFAULT_ROLE_EFFORT, DEFAULT_AGENT_NAMES, ANIMATION_TIERS, SOUND_TIERS, VERBOSITY_TIERS } from '@shared/constants'
import type { McpServerInfo, AgentModel, AgentRole, PermissionMode, EffortLevel, VerbosityLevel } from '@shared/types'
import { type NamingTheme, THEME_LABELS } from '../utils/naming'

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
  const { tour } = useGame()
  const { alert } = useConfirm()
  const isGodMode = !tour?.guidedMode || tour.guidedMode === 'god'

  const [tab, setTab] = useState<Tab>('General')
  const [flags, setFlags] = useState<string[]>([...settings.globalFlags])
  const [newFlag, setNewFlag] = useState('')
  const [idleTimeout, setIdleTimeout] = useState(settings.idleTimeoutSeconds)
  const [notifications, setNotifications] = useState(settings.notifications)
  const [rootFolder, setRootFolder] = useState(settings.rootFolder)
  const [usagePoll, setUsagePoll] = useState(settings.usagePollMinutes)
  const [theme, setTheme] = useState(settings.theme)
  const [agentNames, setAgentNames] = useState(settings.orchestratorAgentNames || DEFAULT_AGENT_NAMES)
  const [allowSpawn, setAllowSpawn] = useState(settings.orchestratorAllowSpawn || false)
  const [animationTier, setAnimationTier] = useState<number>(settings.animationTier ?? (settings.animationsEnabled === false ? 0 : 2))
  const [soundTier, setSoundTier] = useState<number>(settings.soundTier ?? (settings.soundsEnabled === false ? 0 : 2))
  const [namingThemes, setNamingThemes] = useState<NamingTheme[]>(
    settings.namingThemes as NamingTheme[] ?? (settings.namingTheme ? [settings.namingTheme as NamingTheme] : ['memes'])
  )
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
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(settings.permissionMode ?? 'bypassPermissions')
  const [effortLevel, setEffortLevel] = useState<EffortLevel>(settings.effortLevel ?? 'high')
  const [maxBudgetUsd, setMaxBudgetUsd] = useState(settings.maxBudgetUsd ?? 0)
  const [fallbackModel, setFallbackModel] = useState<AgentModel>(settings.fallbackModel ?? 'default')
  const [roleEffort, setRoleEffort] = useState<Record<AgentRole, EffortLevel>>(
    (settings.orchestratorEffort as Record<AgentRole, EffortLevel> | undefined) ?? {
      planner: 'high', builder: 'high', tester: 'medium', promoter: 'medium', scheduler: 'medium',
    }
  )
  const [disableCache, setDisableCache] = useState(settings.disableCache ?? false)
  const [maxTokens, setMaxTokens] = useState(settings.maxTokens ?? 0)
  const [maxConcurrent, setMaxConcurrent] = useState(settings.maxConcurrentProcesses ?? 8)
  const [verbosity, setVerbosity] = useState<number>(settings.verbosity ?? 3)
  const [defaultModel, setDefaultModel] = useState<AgentModel>(settings.defaultModel ?? 'default')
  const [defaultEffort, setDefaultEffort] = useState<EffortLevel>(settings.defaultEffort ?? 'high')
  const [customCommands, setCustomCommands] = useState<Array<{ name: string; command: string; description: string }>>(
    settings.customCommands ?? []
  )
  const [saved, setSaved] = useState(false)

  // Cloud Sync state
  const [cloudSyncUrl, setCloudSyncUrl] = useState(settings.cloudSyncUrl || '')
  const [cloudSyncKey, setCloudSyncKey] = useState(settings.cloudSyncKey || '')
  const [machineName, setMachineName] = useState(settings.machineName || '')
  const [syncTesting, setSyncTesting] = useState(false)
  const [syncTestResult, setSyncTestResult] = useState<{ ok: boolean; error?: string } | null>(null)

  useEffect(() => {
    rest.getMcpAvailable().then(r => {
      setMcpServers(r.servers)
      setMcpLoaded(true)
    }).catch(() => setMcpLoaded(true))
  }, [])

  const addFlag = useCallback(async () => {
    const trimmed = newFlag.trim()
    if (!trimmed) return
    const isValid = ALLOWED_FLAG_PREFIXES.some(p => trimmed.startsWith(p))
    if (!isValid) {
      await alert('Flag not in allowed list: ' + ALLOWED_FLAG_PREFIXES.join(', '))
      return
    }
    if (!flags.includes(trimmed)) {
      setFlags(f => [...f, trimmed])
    }
    setNewFlag('')
  }, [newFlag, flags, alert])

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

  const addCustomCommand = useCallback(() => {
    setCustomCommands(prev => [...prev, { name: '', command: '', description: '' }])
  }, [])

  const removeCustomCommand = useCallback((index: number) => {
    setCustomCommands(prev => prev.filter((_, i) => i !== index))
  }, [])

  const updateCustomCommand = useCallback((index: number, field: 'name' | 'command' | 'description', value: string) => {
    setCustomCommands(prev => prev.map((cc, i) => i === index ? { ...cc, [field]: value } : cc))
  }, [])

  const handleSave = useCallback(() => {
    const cleanFlags = flags.filter(f =>
      !f.startsWith('--dangerously-skip-permissions') &&
      !f.startsWith('--permission-mode')
    )
    if (permissionMode === 'bypassPermissions') cleanFlags.push('--dangerously-skip-permissions')
    else cleanFlags.push(`--permission-mode=${permissionMode}`)

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
      effortLevel,
      maxBudgetUsd: maxBudgetUsd > 0 ? maxBudgetUsd : undefined,
      fallbackModel: fallbackModel !== 'default' ? fallbackModel : undefined,
      orchestratorEffort: roleEffort,
      disableCache,
      maxTokens: maxTokens > 0 ? maxTokens : undefined,
      maxConcurrentProcesses: maxConcurrent,
      animationTier: animationTier as 0 | 1 | 2 | 3 | 4,
      soundTier: soundTier as 0 | 1 | 2 | 3 | 4,
      animationsEnabled: animationTier > 0,
      soundsEnabled: soundTier > 0,
      namingThemes,
      verbosity: verbosity as VerbosityLevel,
      cloudSyncUrl: cloudSyncUrl || undefined,
      cloudSyncKey: cloudSyncKey || undefined,
      machineName: machineName || undefined,
      customCommands: customCommands.filter(cc => cc.name.trim() && cc.command.trim()),
      defaultModel: defaultModel !== 'default' ? defaultModel : undefined,
      defaultEffort: defaultEffort !== 'high' ? defaultEffort : undefined,
    }
    dispatch({ type: 'UPDATE_SETTINGS', payload })
    api.updateSettings(payload)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [dispatch, flags, idleTimeout, notifications, rootFolder, usagePoll, theme, agentNames, allowSpawn, roleMcp, roleModels, roleTools, roleEffort, permissionMode, effortLevel, maxBudgetUsd, fallbackModel, disableCache, maxTokens, maxConcurrent, animationTier, soundTier, namingThemes, verbosity, cloudSyncUrl, cloudSyncKey, machineName, customCommands, defaultModel, defaultEffort])

  const handleBack = useCallback(() => {
    dispatch({ type: 'CLOSE_SETTINGS' })
  }, [dispatch])

  const handleTestSync = useCallback(async () => {
    if (!cloudSyncUrl || !cloudSyncKey) return
    setSyncTesting(true)
    setSyncTestResult(null)
    try {
      const result = await rest.testSyncConnection(cloudSyncUrl, cloudSyncKey)
      setSyncTestResult(result)
    } catch {
      setSyncTestResult({ ok: false, error: 'Connection failed' })
    } finally {
      setSyncTesting(false)
    }
  }, [cloudSyncUrl, cloudSyncKey])

  const sectionTitle = (text: string) => (
    <div className="settings-section-title">{text}</div>
  )

  return (
    <div className="settings-page">
      {/* Forged by The Nask */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '8px 0 4px', opacity: 0.6 }}>
        <span style={{ fontFamily: 'var(--font-pixel)', fontSize: 8, color: 'var(--text-secondary)' }}>Forged by The Nask</span>
        <a href="https://linkedin.com/in/rodrigonask" target="_blank" rel="noopener noreferrer" title="LinkedIn" style={{ color: 'var(--text-tertiary)', fontSize: 14, lineHeight: 1 }}>in</a>
        <a href="#" title="Skool (coming soon)" style={{ color: 'var(--text-tertiary)', fontSize: 14, lineHeight: 1, cursor: 'default', pointerEvents: 'none' }}>S</a>
      </div>

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
                    <option value="bypassPermissions">Bypass (auto-approve all)</option>
                    <option value="acceptEdits">Accept Edits (auto-approve file writes)</option>
                    <option value="auto">Auto (Claude decides)</option>
                    <option value="plan">Plan (read-only)</option>
                    <option value="dontAsk">Don't Ask (skip confirmations)</option>
                    <option value="default">Default (ask every action)</option>
                  </select>
                </div>

                {/* God Mode Toggle */}
                <div className="settings-card">
                  {sectionTitle('God Mode')}
                  <div className="settings-toggle">
                    <span className="settings-toggle-label">
                      Unlock all features regardless of level
                      <br />
                      <em style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>XP still tracks. Switch anytime.</em>
                    </span>
                    <div
                      className={`toggle-switch ${isGodMode ? 'active' : ''}`}
                      onClick={() => {
                        const newMode = isGodMode ? 'guided' : 'god'
                        api.updateTour({ guidedMode: newMode })
                      }}
                    />
                  </div>
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

                {/* Default AI Model */}
                <div className="settings-card">
                  {sectionTitle('Default AI Model')}
                  <select
                    className="form-select"
                    value={defaultModel}
                    onChange={e => setDefaultModel(e.target.value as AgentModel)}
                  >
                    {MODEL_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                {/* Default Effort */}
                <div className="settings-card">
                  {sectionTitle('Default Effort')}
                  <select
                    className="form-select"
                    value={defaultEffort}
                    onChange={e => setDefaultEffort(e.target.value as EffortLevel)}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="max">Max</option>
                  </select>
                </div>

                {/* Session Naming */}
                <div className="settings-card">
                  {sectionTitle('Session Naming')}
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
                    Pick one or more. Names are drawn from the combined pool.
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {(Object.keys(THEME_LABELS) as NamingTheme[]).map(t => {
                      const active = namingThemes.includes(t)
                      return (
                        <button
                          key={t}
                          onClick={() => setNamingThemes(prev => {
                            if (active && prev.length <= 1) return prev
                            return active ? prev.filter(x => x !== t) : [...prev, t]
                          })}
                          className={`settings-tool-btn ${active ? 'active' : ''}`}
                        >
                          {THEME_LABELS[t]}
                        </button>
                      )
                    })}
                  </div>
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
                {/* Animation & Sound Tiers */}
                <div className="settings-card">
                  {sectionTitle('Animation Tier')}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 18 }}>{ANIMATION_TIERS[animationTier]?.icon}</span>
                    <input
                      type="range" min={0} max={4} step={1}
                      value={animationTier}
                      onChange={e => setAnimationTier(Number(e.target.value))}
                      className="form-input"
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, minWidth: 100 }}>
                      {ANIMATION_TIERS[animationTier]?.name}
                    </span>
                  </div>
                </div>
                <div className="settings-card">
                  {sectionTitle('Sound Tier')}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 18 }}>{SOUND_TIERS[soundTier]?.icon}</span>
                    <input
                      type="range" min={0} max={4} step={1}
                      value={soundTier}
                      onChange={e => setSoundTier(Number(e.target.value))}
                      className="form-input"
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, minWidth: 100 }}>
                      {SOUND_TIERS[soundTier]?.name}
                    </span>
                  </div>
                </div>

                {/* Chat Verbosity */}
                <div className="settings-card">
                  {sectionTitle('Chat Verbosity')}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 18 }}>{VERBOSITY_TIERS[verbosity - 1]?.icon}</span>
                    <input
                      type="range" min={1} max={5} step={1}
                      value={verbosity}
                      onChange={e => setVerbosity(Number(e.target.value))}
                      className="form-input"
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, minWidth: 120 }}>
                      {VERBOSITY_TIERS[verbosity - 1]?.name}
                      <span style={{ color: 'var(--text-tertiary)', fontSize: 9, display: 'block' }}>
                        {VERBOSITY_TIERS[verbosity - 1]?.description}
                      </span>
                    </span>
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

                {/* Custom Commands */}
                <div className="settings-card">
                  {sectionTitle('Custom Commands')}
                  <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8 }}>
                    Add your own slash commands to the &lt;/&gt; menu.
                  </p>
                  {customCommands.map((cc, i) => (
                    <div key={i} className="custom-cmd-row">
                      <input
                        className="form-input"
                        placeholder="Name"
                        value={cc.name}
                        onChange={e => updateCustomCommand(i, 'name', e.target.value)}
                        style={{ width: 80 }}
                      />
                      <input
                        className="form-input"
                        placeholder="/command text"
                        value={cc.command}
                        onChange={e => updateCustomCommand(i, 'command', e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <input
                        className="form-input"
                        placeholder="Description"
                        value={cc.description}
                        onChange={e => updateCustomCommand(i, 'description', e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <button
                        className="settings-flag-remove"
                        onClick={() => removeCustomCommand(i)}
                        title="Remove command"
                      >x</button>
                    </div>
                  ))}
                  <button
                    className="btn btn-sm"
                    onClick={addCustomCommand}
                    style={{ marginTop: 6 }}
                  >
                    + Add Command
                  </button>
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
                {/* Effort per Role */}
                <div className="settings-card">
                  {sectionTitle('Effort per Role')}
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
                    Controls reasoning depth. Higher effort uses more tokens.
                  </p>
                  {ROLES.map(role => (
                    <div key={role} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, width: 70, textTransform: 'capitalize' }}>
                        {role}
                      </span>
                      <select
                        className="form-select"
                        style={{ flex: 1 }}
                        value={roleEffort[role]}
                        onChange={e => setRoleEffort(m => ({ ...m, [role]: e.target.value as EffortLevel }))}
                      >
                        <option value="low">Low (fast, cheap)</option>
                        <option value="medium">Medium</option>
                        <option value="high">High (default)</option>
                        <option value="max">Max (extended thinking)</option>
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

                {/* Max Budget USD */}
                <div className="settings-card">
                  {sectionTitle('Max Budget per Session (USD)')}
                  <div className="form-group">
                    <label className="form-label">0 = unlimited. Applies to pipeline tasks.</label>
                    <input
                      type="number"
                      className="form-input"
                      value={maxBudgetUsd}
                      onChange={e => setMaxBudgetUsd(Number(e.target.value))}
                      min={0}
                      step={0.5}
                      placeholder="0"
                    />
                  </div>
                </div>

                {/* Fallback Model */}
                <div className="settings-card">
                  {sectionTitle('Fallback Model')}
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
                    Switch to this model if the primary is overloaded.
                  </p>
                  <select
                    className="form-select"
                    value={fallbackModel}
                    onChange={e => setFallbackModel(e.target.value as AgentModel)}
                  >
                    {MODEL_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                {/* Max Concurrent Processes */}
                <div className="settings-card">
                  {sectionTitle('Max Concurrent Agents')}
                  <div className="form-group">
                    <label className="form-label">
                      Hard cap on simultaneous CLI processes ({maxConcurrent})
                    </label>
                    <input
                      type="range"
                      className="form-input"
                      value={maxConcurrent}
                      onChange={e => setMaxConcurrent(Number(e.target.value))}
                      min={1}
                      max={20}
                      step={1}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>
                      <span>1</span>
                      <span style={{ color: maxConcurrent > 6 ? 'var(--warning, #f59e0b)' : 'inherit' }}>
                        {maxConcurrent > 6 ? 'High memory usage' : maxConcurrent <= 3 ? 'Conservative' : 'Balanced'}
                      </span>
                      <span>20</span>
                    </div>
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
                {/* Cloud Sync */}
                <div className="settings-card">
                  {sectionTitle('Cloud Sync (Supabase)')}
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>
                    Sync your pipeline across machines. Create a free{' '}
                    <a href="https://supabase.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Supabase</a>{' '}
                    project, run the schema from <code style={{ fontSize: 10 }}>server/supabase/schema.sql</code>, then paste your credentials below.
                  </p>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label className="form-label">Machine Name</label>
                    <input
                      className="form-input"
                      placeholder="e.g. Desktop, Laptop, Server"
                      value={machineName}
                      onChange={e => setMachineName(e.target.value)}
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label className="form-label">Supabase URL</label>
                    <input
                      className="form-input"
                      placeholder="https://abc123.supabase.co"
                      value={cloudSyncUrl}
                      onChange={e => setCloudSyncUrl(e.target.value)}
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label className="form-label">Supabase Anon Key</label>
                    <input
                      className="form-input"
                      type="password"
                      placeholder="eyJ..."
                      value={cloudSyncKey}
                      onChange={e => setCloudSyncKey(e.target.value)}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      className="btn btn-sm"
                      onClick={handleTestSync}
                      disabled={syncTesting || !cloudSyncUrl || !cloudSyncKey}
                    >
                      {syncTesting ? 'Testing...' : 'Test Connection'}
                    </button>
                    {syncTestResult && (
                      <span style={{
                        fontSize: 11,
                        color: syncTestResult.ok ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)',
                      }}>
                        {syncTestResult.ok ? 'Connected!' : syncTestResult.error || 'Failed'}
                      </span>
                    )}
                  </div>
                </div>

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
