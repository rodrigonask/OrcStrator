import { useState, useCallback, useEffect } from 'react'
import { useFontSize, type FontSizeOption } from '../hooks/useFontSize'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useGame } from '../context/GameContext'
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
const TABS = ['General', 'Agents', 'Advanced', 'Usage Log'] as const
type Tab = typeof TABS[number]

export function SettingsPage() {
  const { settings } = useUI()
  const { dispatch } = useAppDispatch()
  const { fontSize, setFontSize } = useFontSize()
  const { tour } = useGame()
  const isGodMode = !tour?.guidedMode || tour.guidedMode === 'god'

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
  const [maxConcurrent, setMaxConcurrent] = useState(settings.maxConcurrentProcesses ?? 8)
  const [saved, setSaved] = useState(false)
  const [usageDays, setUsageDays] = useState<number>(7)
  const [usageLog, setUsageLog] = useState<Array<{ session_id: string; role: string; task_title: string | null; project_name: string | null; cost_usd: number; input_tokens: number; output_tokens: number; created_at: number }>>([])
  const [usageByProject, setUsageByProject] = useState<Array<{ project_name: string; total_cost_usd: number; session_count: number }>>([])
  const [usageStats, setUsageStats] = useState<{
    summary: { total_cost_usd: number; total_sessions: number; avg_cost_per_session: number; cache_hit_ratio: number; total_input_tokens: number; total_output_tokens: number };
    byRole: Array<{ role: string; session_count: number; total_cost_usd: number; avg_cost_usd: number; cache_hit_ratio: number }>;
    byWeekday: Array<{ weekday: number; label: string; session_count: number; total_cost_usd: number }>;
    byDay: Array<{ day: string; session_count: number; total_cost_usd: number }>;
  } | null>(null)
  const [sortCol, setSortCol] = useState<string>('')
  const [sortAsc, setSortAsc] = useState(true)

  const handleSort = useCallback((col: string) => {
    if (sortCol === col) setSortAsc(a => !a)
    else { setSortCol(col); setSortAsc(true) }
  }, [sortCol])

  const sortRows = useCallback(<T extends Record<string, unknown>>(rows: T[], col: string): T[] => {
    if (!col) return rows
    return [...rows].sort((a, b) => {
      const av = a[col] ?? 0, bv = b[col] ?? 0
      if (typeof av === 'number' && typeof bv === 'number') return sortAsc ? av - bv : bv - av
      return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
  }, [sortAsc])

  useEffect(() => {
    if (tab === 'Usage Log') {
      rest.getUsageLog(500, usageDays).then(setUsageLog).catch(() => {})
      rest.getUsageByProject(usageDays).then(setUsageByProject).catch(() => {})
      rest.getUsageStats(usageDays).then(setUsageStats).catch(() => {})
    }
  }, [tab, usageDays])

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
      maxConcurrentProcesses: maxConcurrent,
      animationsEnabled,
      soundsEnabled,
      namingTheme,
    }
    dispatch({ type: 'UPDATE_SETTINGS', payload })
    api.updateSettings(payload)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [dispatch, flags, idleTimeout, notifications, rootFolder, usagePoll, theme, agentNames, allowSpawn, roleMcp, roleModels, roleTools, permissionMode, disableCache, maxTokens, maxConcurrent, animationsEnabled, soundsEnabled, namingTheme])

  const handleBack = useCallback(() => {
    dispatch({ type: 'CLOSE_SETTINGS' })
  }, [dispatch])

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
                    <option value="bypass">Bypass (auto-approve all)</option>
                    <option value="plan">Plan (read-only)</option>
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

          {/* === USAGE LOG TAB === */}
          {tab === 'Usage Log' && (
            <div className="usage-log-tab">
              {/* Date range tabs */}
              <div className="usage-range-tabs">
                {([
                  { label: '7d', value: 7 },
                  { label: '14d', value: 14 },
                  { label: '30d', value: 30 },
                  { label: 'Last Month', value: -1 },
                ] as const).map(opt => (
                  <button
                    key={opt.label}
                    className={`usage-range-btn ${usageDays === opt.value ? 'active' : ''}`}
                    onClick={() => {
                      if (opt.value === -1) {
                        const now = new Date()
                        const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
                        const diff = Math.ceil((now.getTime() - firstOfMonth.getTime()) / 86_400_000) + new Date(now.getFullYear(), now.getMonth() - 1, 0).getDate()
                        setUsageDays(-1)
                        // For last month, use 60 days to cover full previous month
                        rest.getUsageLog(500, 60).then(setUsageLog).catch(() => {})
                        rest.getUsageByProject(60).then(setUsageByProject).catch(() => {})
                        rest.getUsageStats(60).then(setUsageStats).catch(() => {})
                      } else {
                        setUsageDays(opt.value)
                      }
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Summary cards */}
              {usageStats && (
                <div className="usage-summary-cards">
                  <div className="usage-summary-card">
                    <div className="usage-summary-label">Total Cost</div>
                    <div className="usage-summary-value">${usageStats.summary.total_cost_usd.toFixed(2)}</div>
                  </div>
                  <div className="usage-summary-card">
                    <div className="usage-summary-label">Sessions</div>
                    <div className="usage-summary-value">{usageStats.summary.total_sessions.toLocaleString()}</div>
                  </div>
                  <div className="usage-summary-card">
                    <div className="usage-summary-label">Avg / Session</div>
                    <div className="usage-summary-value">${usageStats.summary.avg_cost_per_session.toFixed(4)}</div>
                  </div>
                  <div className="usage-summary-card">
                    <div className="usage-summary-label">Cache Hit %</div>
                    <div className="usage-summary-value">{(usageStats.summary.cache_hit_ratio * 100).toFixed(1)}%</div>
                  </div>
                </div>
              )}

              {/* Per-role table */}
              {usageStats && usageStats.byRole.length > 0 && (
                <div className="settings-card" style={{ marginTop: 16 }}>
                  {sectionTitle('Cost by Role')}
                  <div className="usage-log-table-wrap">
                    <table className="usage-log-table usage-sortable">
                      <thead>
                        <tr>
                          <th onClick={() => handleSort('role')} className="usage-sort-th">Role {sortCol === 'role' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                          <th onClick={() => handleSort('session_count')} className="usage-sort-th">Sessions {sortCol === 'session_count' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                          <th onClick={() => handleSort('total_cost_usd')} className="usage-sort-th">Cost {sortCol === 'total_cost_usd' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                          <th onClick={() => handleSort('avg_cost_usd')} className="usage-sort-th">Avg {sortCol === 'avg_cost_usd' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                          <th onClick={() => handleSort('cache_hit_ratio')} className="usage-sort-th">Cache Hit % {sortCol === 'cache_hit_ratio' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortRows(usageStats.byRole, sortCol).map((r, i) => (
                          <tr key={i}>
                            <td style={{ textTransform: 'capitalize' }}>{r.role}</td>
                            <td className="usage-log-mono">{r.session_count}</td>
                            <td className="usage-log-mono">${r.total_cost_usd.toFixed(4)}</td>
                            <td className="usage-log-mono">${r.avg_cost_usd.toFixed(4)}</td>
                            <td className="usage-log-mono">{(r.cache_hit_ratio * 100).toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Per-project table */}
              {usageByProject.length > 0 && (
                <div className="settings-card" style={{ marginTop: 16 }}>
                  {sectionTitle('Cost by Project')}
                  <div className="usage-log-table-wrap">
                    <table className="usage-log-table usage-sortable">
                      <thead>
                        <tr>
                          <th onClick={() => handleSort('project_name')} className="usage-sort-th">Project {sortCol === 'project_name' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                          <th onClick={() => handleSort('total_cost_usd')} className="usage-sort-th">Total Cost {sortCol === 'total_cost_usd' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                          <th onClick={() => handleSort('session_count')} className="usage-sort-th">Sessions {sortCol === 'session_count' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortRows(usageByProject, sortCol).map((row, i) => (
                          <tr key={i}>
                            <td>{row.project_name}</td>
                            <td className="usage-log-mono">${(row.total_cost_usd ?? 0).toFixed(4)}</td>
                            <td className="usage-log-mono">{row.session_count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Per-weekday table */}
              {usageStats && usageStats.byWeekday.length > 0 && (
                <div className="settings-card" style={{ marginTop: 16 }}>
                  {sectionTitle('Cost by Weekday')}
                  <div className="usage-log-table-wrap">
                    <table className="usage-log-table usage-sortable">
                      <thead>
                        <tr>
                          <th onClick={() => handleSort('label')} className="usage-sort-th">Day {sortCol === 'label' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                          <th onClick={() => handleSort('session_count')} className="usage-sort-th">Sessions {sortCol === 'session_count' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                          <th onClick={() => handleSort('total_cost_usd')} className="usage-sort-th">Cost {sortCol === 'total_cost_usd' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortRows(usageStats.byWeekday, sortCol).map((r, i) => (
                          <tr key={i}>
                            <td>{r.label}</td>
                            <td className="usage-log-mono">{r.session_count}</td>
                            <td className="usage-log-mono">${r.total_cost_usd.toFixed(4)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Per-day table */}
              {usageStats && usageStats.byDay.length > 0 && (
                <div className="settings-card" style={{ marginTop: 16 }}>
                  {sectionTitle('Cost by Day')}
                  <div className="usage-log-table-wrap">
                    <table className="usage-log-table usage-sortable">
                      <thead>
                        <tr>
                          <th onClick={() => handleSort('day')} className="usage-sort-th">Date {sortCol === 'day' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                          <th onClick={() => handleSort('session_count')} className="usage-sort-th">Sessions {sortCol === 'session_count' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                          <th onClick={() => handleSort('total_cost_usd')} className="usage-sort-th">Cost {sortCol === 'total_cost_usd' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortRows(usageStats.byDay, sortCol).map((r, i) => (
                          <tr key={i}>
                            <td className="usage-log-mono">{r.day}</td>
                            <td className="usage-log-mono">{r.session_count}</td>
                            <td className="usage-log-mono">${r.total_cost_usd.toFixed(4)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Raw log table */}
              <div className="settings-card" style={{ marginTop: 16 }}>
                {sectionTitle('Session Log')}
                <div className="usage-log-table-wrap">
                  <table className="usage-log-table usage-sortable">
                    <thead>
                      <tr>
                        <th onClick={() => handleSort('created_at')} className="usage-sort-th">Date {sortCol === 'created_at' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                        <th onClick={() => handleSort('session_id')} className="usage-sort-th">Session {sortCol === 'session_id' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                        <th onClick={() => handleSort('task_title')} className="usage-sort-th">Task {sortCol === 'task_title' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                        <th onClick={() => handleSort('project_name')} className="usage-sort-th">Project {sortCol === 'project_name' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                        <th onClick={() => handleSort('role')} className="usage-sort-th">Role {sortCol === 'role' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                        <th onClick={() => handleSort('input_tokens')} className="usage-sort-th">Input {sortCol === 'input_tokens' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                        <th onClick={() => handleSort('output_tokens')} className="usage-sort-th">Output {sortCol === 'output_tokens' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                        <th onClick={() => handleSort('cost_usd')} className="usage-sort-th">Cost {sortCol === 'cost_usd' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usageLog.length === 0 ? (
                        <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-tertiary)', padding: 16 }}>No usage data yet</td></tr>
                      ) : sortRows(usageLog, sortCol).map((row, i) => (
                        <tr key={i}>
                          <td className="usage-log-mono">{new Date(row.created_at).toLocaleDateString()}</td>
                          <td className="usage-log-mono">{row.session_id ? row.session_id.slice(0, 8) : '\u2014'}</td>
                          <td>{row.task_title || '\u2014'}</td>
                          <td>{row.project_name || '\u2014'}</td>
                          <td style={{ textTransform: 'capitalize' }}>{row.role || '\u2014'}</td>
                          <td className="usage-log-mono">{(row.input_tokens ?? 0).toLocaleString()}</td>
                          <td className="usage-log-mono">{(row.output_tokens ?? 0).toLocaleString()}</td>
                          <td className="usage-log-mono">${(row.cost_usd ?? 0).toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
