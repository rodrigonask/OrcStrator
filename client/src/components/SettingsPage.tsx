import { useState, useCallback, useEffect, useRef } from 'react'
import { useFontSize, type FontSizeOption } from '../hooks/useFontSize'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'
import { rest } from '../api/rest'
import { useConfirm } from './ConfirmModal'
import { ALLOWED_FLAG_PREFIXES, ANIMATION_TIERS, SOUND_TIERS, VERBOSITY_TIERS, DEFAULT_TASK_KICKOFF_TEMPLATE, OUTPUT_STYLE_BUILTINS, AUTOCOMPACT_OPTIONS, MODEL_OPTIONS as MODEL_OPTIONS_SHARED, DEFAULT_MODEL, DEFAULT_EFFORT } from '@shared/constants'
import type { AgentModel, PermissionMode, EffortLevel, VerbosityLevel } from '@shared/types'
import { type NamingTheme, THEME_LABELS } from '../utils/naming'
import { EFFORT_LEVELS } from '../utils/modelOptions'
import { RuleList, RECOMMENDED_GIT_RULES, RECOMMENDED_GIT_SUMMARY, mergeRules } from './RuleList'
import { PermissionBundlePicker } from './PermissionBundlePicker'
import type { PermissionBundleId } from '@shared/permission-bundles'

// Derived from the one shared list, so a model ships here without a second edit.
// 'default' stays in front: it means "whatever the app default is", which is a
// different thing from pinning today's default by name.
const MODEL_OPTIONS: { value: AgentModel; label: string }[] = [
  { value: 'default', label: `Default (${MODEL_OPTIONS_SHARED.find(m => m.short === DEFAULT_MODEL)?.label.split(' (')[0] ?? DEFAULT_MODEL})` },
  ...MODEL_OPTIONS_SHARED.map(m => ({ value: m.short, label: m.label })),
]

// Width cap for a maximized chat tile, in px. 0 = full bleed. Discrete stops rather
// than a free px slider so every position is a sane reading measure.
const READING_WIDTH_STOPS = [960, 1200, 1600, 2000, 0]
const READING_WIDTH_LABELS = ['Narrow', 'Comfortable', 'Wide', 'Extra wide', 'Full width']

export function SettingsPage() {
  const { settings, usage } = useUI()
  const { dispatch } = useAppDispatch()
  const { fontSize, setFontSize } = useFontSize()
  const { alert } = useConfirm()

  const [flags, setFlags] = useState<string[]>([...settings.globalFlags])
  const [newFlag, setNewFlag] = useState('')
  const [idleTimeout, setIdleTimeout] = useState(settings.idleTimeoutSeconds)
  const [notifications, setNotifications] = useState(settings.notifications)
  const [showPlanLimits, setShowPlanLimits] = useState(settings.showPlanLimits !== false)
  const [rootFolder, setRootFolder] = useState(settings.rootFolder)
  const [usagePoll, setUsagePoll] = useState(settings.usagePollMinutes)
  const [theme, setTheme] = useState(settings.theme)
  const [animationTier, setAnimationTier] = useState<number>(settings.animationTier ?? (settings.animationsEnabled === false ? 0 : 2))
  const [soundTier, setSoundTier] = useState<number>(settings.soundTier ?? (settings.soundsEnabled === false ? 0 : 2))
  const [namingThemes, setNamingThemes] = useState<NamingTheme[]>(
    settings.namingThemes as NamingTheme[] ?? (settings.namingTheme ? [settings.namingTheme as NamingTheme] : ['memes'])
  )
  const [namingMode, setNamingMode] = useState<'random' | 'ai'>(settings.namingMode ?? 'random')
  const [sessionSummaryMode, setSessionSummaryMode] = useState<'all' | 'tasks' | 'off'>(settings.sessionSummaryMode ?? 'tasks')
  // Anthropic API key for AI naming, stored server-side (encrypted), so we only ever
  // know whether one is set, never its value. The draft input clears after saving.
  const [anthropicKeyDraft, setAnthropicKeyDraft] = useState('')
  const [keySet, setKeySet] = useState(false)
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyMsg, setKeyMsg] = useState<string | null>(null)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(settings.permissionMode ?? 'bypassPermissions')
  const [permissionCycleModes, setPermissionCycleModes] = useState<PermissionMode[]>(
    settings.permissionCycleModes ?? ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
  )
  const [permissionBundles, setPermissionBundles] = useState<PermissionBundleId[]>(settings.permissionBundles ?? [])
  const [blockDestructive, setBlockDestructive] = useState(settings.blockDestructive !== false)
  const [permissionAllowRules, setPermissionAllowRules] = useState<string[]>(settings.permissionAllowRules ?? [])
  const [permissionDenyRules, setPermissionDenyRules] = useState<string[]>(settings.permissionDenyRules ?? [])
  const [permissionAskRules, setPermissionAskRules] = useState<string[]>(settings.permissionAskRules ?? [])
  const [autoModeAllow, setAutoModeAllow] = useState<string[]>(settings.autoModeAllow ?? [])
  const [autoModeSoftDeny, setAutoModeSoftDeny] = useState<string[]>(settings.autoModeSoftDeny ?? [])
  const [autoModeHardDeny, setAutoModeHardDeny] = useState<string[]>(settings.autoModeHardDeny ?? [])
  const [maxBudgetUsd, setMaxBudgetUsd] = useState(settings.maxBudgetUsd ?? 0)
  const [fallbackModel, setFallbackModel] = useState<AgentModel>(settings.fallbackModel ?? 'default')
  const [disableCache, setDisableCache] = useState(settings.disableCache ?? false)
  const [promptCache1h, setPromptCache1h] = useState(settings.promptCache1h ?? true)
  const [autoRetryOnRateLimit, setAutoRetryOnRateLimit] = useState(settings.autoRetryOnRateLimit ?? true)
  const [contextCompactionHook, setContextCompactionHook] = useState(settings.contextCompactionHook ?? true)
  const [compactionLossless, setCompactionLossless] = useState(settings.compactionLossless ?? true)
  const [maxTokens, setMaxTokens] = useState(settings.maxTokens ?? 0)
  const [maxConcurrent, setMaxConcurrent] = useState(settings.maxConcurrentProcesses ?? 8)
  const [maxGridTiles, setMaxGridTiles] = useState(settings.maxGridTiles ?? 12)
  const [maxGridColumns, setMaxGridColumns] = useState(settings.maxGridColumns ?? 6)
  const [chatReadingWidth, setChatReadingWidth] = useState(settings.chatReadingWidth ?? 1200)
  // Slider works in stop indices; an unrecognised stored px value falls back to Comfortable.
  const readingWidthIdx = READING_WIDTH_STOPS.indexOf(chatReadingWidth) >= 0
    ? READING_WIDTH_STOPS.indexOf(chatReadingWidth)
    : 1
  const [verbosity, setVerbosity] = useState<number>(settings.verbosity ?? 3)
  const [defaultModel, setDefaultModel] = useState<AgentModel>(settings.defaultModel ?? 'default')
  // DEFAULT_EFFORT is the sentinel on BOTH sides: it is what an unset setting
  // resolves to, and it is the value that saves as unset. Move one without the
  // other and picking the old default silently stores nothing, so the dropdown
  // says one thing and the run does another.
  const [defaultEffort, setDefaultEffort] = useState<EffortLevel>(settings.defaultEffort ?? DEFAULT_EFFORT)
  const [customCommands, setCustomCommands] = useState<Array<{ name: string; command: string; description: string }>>(
    settings.customCommands ?? []
  )
  const [taskKickoffTemplate, setTaskKickoffTemplate] = useState(settings.taskKickoffTemplate ?? '')
  const [saved, setSaved] = useState(false)

  // Claude CLI settings (the /config surface). 'Default' is stored as an empty value:
  // it means "send no outputStyle key", which is how the CLI keeps its own prompt.
  const [outputStyle, setOutputStyle] = useState(settings.outputStyle ?? 'Default')
  const [language, setLanguage] = useState(settings.language ?? '')
  const [autocompact, setAutocompact] = useState(settings.autocompact ?? '')
  const [customStyles, setCustomStyles] = useState<Array<{ value: string; name: string; description: string }>>([])
  const selectedStyle = [...OUTPUT_STYLE_BUILTINS, ...customStyles].find(s => s.value === outputStyle)

  // Custom output styles are markdown files on disk, so they can only come from the server.
  useEffect(() => {
    let cancelled = false
    api.getOutputStyles()
      .then(r => { if (!cancelled) setCustomStyles(r.styles) })
      .catch(() => { /* no custom styles is the normal case; the built-ins still render */ })
    return () => { cancelled = true }
  }, [])

  // Cloud Sync state
  const [cloudSyncUrl, setCloudSyncUrl] = useState(settings.cloudSyncUrl || '')
  const [cloudSyncKey, setCloudSyncKey] = useState(settings.cloudSyncKey || '')
  const [machineName, setMachineName] = useState(settings.machineName || '')
  const [syncTesting, setSyncTesting] = useState(false)
  const [syncTestResult, setSyncTestResult] = useState<{ ok: boolean; error?: string } | null>(null)

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

  /* Union, not replace: someone who already curated a list keeps it, and clicking twice is
     a no-op rather than a pile of duplicates. */
  const applyRecommendedGitRules = useCallback(() => {
    setPermissionAllowRules(c => mergeRules(c, RECOMMENDED_GIT_RULES.allow))
    setPermissionDenyRules(c => mergeRules(c, RECOMMENDED_GIT_RULES.deny))
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
      showPlanLimits,
      rootFolder,
      usagePollMinutes: usagePoll,
      theme,
      permissionMode,
      permissionCycleModes,
      permissionBundles,
      blockDestructive,
      permissionAllowRules,
      permissionDenyRules,
      permissionAskRules,
      autoModeAllow,
      autoModeSoftDeny,
      autoModeHardDeny,
      maxBudgetUsd: maxBudgetUsd > 0 ? maxBudgetUsd : undefined,
      fallbackModel: fallbackModel !== 'default' ? fallbackModel : undefined,
      disableCache,
      promptCache1h,
      autoRetryOnRateLimit,
      contextCompactionHook,
      compactionLossless,
      maxTokens: maxTokens > 0 ? maxTokens : undefined,
      maxConcurrentProcesses: maxConcurrent,
      maxGridTiles,
      maxGridColumns,
      chatReadingWidth,
      animationTier: animationTier as 0 | 1 | 2 | 3 | 4,
      soundTier: soundTier as 0 | 1 | 2 | 3 | 4,
      animationsEnabled: animationTier > 0,
      soundsEnabled: soundTier > 0,
      namingThemes,
      namingMode,
      sessionSummaryMode,
      verbosity: verbosity as VerbosityLevel,
      cloudSyncUrl: cloudSyncUrl || undefined,
      cloudSyncKey: cloudSyncKey || undefined,
      machineName: machineName || undefined,
      customCommands: customCommands.filter(cc => cc.name.trim() && cc.command.trim()),
      // Back to the default: null when a value is pinned (the server deletes a null key),
      // undefined when nothing is (no write at all). undefined alone is dropped by JSON,
      // so a pinned value could never be put back to default.
      defaultModel: defaultModel !== 'default' ? defaultModel : (settings.defaultModel ? null : undefined),
      defaultEffort: defaultEffort !== DEFAULT_EFFORT ? defaultEffort : (settings.defaultEffort ? null : undefined),
      taskKickoffTemplate: taskKickoffTemplate.trim() || undefined,
      // Claude CLI settings. 'Default' and blanks are stored as undefined so the spawn
      // sends no key at all and the CLI's own defaults apply.
      outputStyle: outputStyle && outputStyle !== 'Default' ? outputStyle : undefined,
      language: language.trim() || undefined,
      autocompact: autocompact || undefined,
    }
    dispatch({ type: 'UPDATE_SETTINGS', payload })
    api.updateSettings(payload)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [dispatch, flags, idleTimeout, notifications, showPlanLimits, rootFolder, usagePoll, theme, permissionMode, permissionCycleModes, permissionBundles, blockDestructive, permissionAllowRules, permissionDenyRules, permissionAskRules, autoModeAllow, autoModeSoftDeny, autoModeHardDeny, maxBudgetUsd, fallbackModel, disableCache, promptCache1h, autoRetryOnRateLimit, contextCompactionHook, compactionLossless, maxTokens, maxConcurrent, maxGridTiles, maxGridColumns, chatReadingWidth, animationTier, soundTier, namingThemes, namingMode, sessionSummaryMode, verbosity, cloudSyncUrl, cloudSyncKey, machineName, customCommands, defaultModel, defaultEffort, settings.defaultModel, settings.defaultEffort, taskKickoffTemplate, outputStyle, language, autocompact])

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

  // Load whether an Anthropic API key is stored (the value is never sent to the client).
  useEffect(() => {
    rest.getAnthropicKeyStatus().then(r => setKeySet(r.set)).catch(() => {})
  }, [])

  const saveKey = useCallback(async () => {
    const key = anthropicKeyDraft.trim()
    if (!key) return
    setKeyBusy(true)
    setKeyMsg(null)
    try {
      const r = await rest.setAnthropicKey(key)
      setKeySet(r.set)
      setAnthropicKeyDraft('')
      setKeyMsg(r.set ? 'Key saved' : 'Key cleared')
    } catch {
      setKeyMsg('Failed to save key')
    } finally {
      setKeyBusy(false)
      setTimeout(() => setKeyMsg(null), 2500)
    }
  }, [anthropicKeyDraft])

  const clearKey = useCallback(async () => {
    setKeyBusy(true)
    setKeyMsg(null)
    try {
      await rest.setAnthropicKey('')
      setKeySet(false)
      setAnthropicKeyDraft('')
      setKeyMsg('Key removed')
    } catch {
      setKeyMsg('Failed to remove key')
    } finally {
      setKeyBusy(false)
      setTimeout(() => setKeyMsg(null), 2500)
    }
  }, [])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const legacyRef = useRef<HTMLDetailsElement | null>(null)

  /* Dirty tracking for the sticky save bar. Derived only: it compares the current values
     against a snapshot taken on mount and re-taken after each save, so it adds no
     persisted state and touches no key in the save payload. fontSize is excluded because
     it applies immediately and is not part of that payload. */
  /* handleSave owns the permission flags: it strips them from globalFlags and re-appends
     the one matching permissionMode. So the stored list and this local state legitimately
     differ by that flag, and comparing them raw jammed the save bar after a permission
     change. permissionMode is tracked in its own right, so they are normalised out here
     and in handleDiscard, keeping both sides of the comparison in the same shape. */
  const editableFlags = (list: string[]) => list.filter(f =>
    !f.startsWith('--dangerously-skip-permissions') && !f.startsWith('--permission-mode'))
  /* handleSave drops blank command rows on the way out, so a half-typed row is not a real
     change and must not count towards dirty. Same reasoning as editableFlags. */
  const savedCommands = (list: Array<{ name: string; command: string; description: string }>) =>
    list.filter(cc => cc.name.trim() && cc.command.trim())

  const trackedState = JSON.stringify([
    editableFlags(flags), idleTimeout, notifications, showPlanLimits, rootFolder, usagePoll, theme,
    permissionMode, permissionCycleModes, permissionBundles, blockDestructive,
    permissionAllowRules, permissionDenyRules, permissionAskRules,
    autoModeAllow, autoModeSoftDeny, autoModeHardDeny, maxBudgetUsd, fallbackModel,
    disableCache, promptCache1h, autoRetryOnRateLimit, contextCompactionHook,
    compactionLossless, maxTokens, maxConcurrent, maxGridTiles, maxGridColumns,
    chatReadingWidth, animationTier, soundTier, namingThemes, namingMode,
    sessionSummaryMode, verbosity, cloudSyncUrl, cloudSyncKey, machineName,
    savedCommands(customCommands), defaultModel, defaultEffort, taskKickoffTemplate, outputStyle,
    language, autocompact,
  ])
  const savedSnapshot = useRef<string | null>(null)
  if (savedSnapshot.current === null) savedSnapshot.current = trackedState
  const dirty = savedSnapshot.current !== trackedState

  /* Wraps handleSave rather than editing it, so the payload builder stays untouched. */
  const onSave = useCallback(() => {
    handleSave()
    savedSnapshot.current = trackedState
  }, [handleSave, trackedState])

  /* Puts every control back to the last saved value, using the same expressions the
     useState initializers use, so the two cannot drift apart. */
  const handleDiscard = useCallback(() => {
    setFlags(editableFlags(settings.globalFlags))
    setIdleTimeout(settings.idleTimeoutSeconds)
    setNotifications(settings.notifications)
    setShowPlanLimits(settings.showPlanLimits !== false)
    setRootFolder(settings.rootFolder)
    setUsagePoll(settings.usagePollMinutes)
    setTheme(settings.theme)
    setAnimationTier(settings.animationTier ?? (settings.animationsEnabled === false ? 0 : 2))
    setSoundTier(settings.soundTier ?? (settings.soundsEnabled === false ? 0 : 2))
    setNamingThemes(settings.namingThemes as NamingTheme[] ?? (settings.namingTheme ? [settings.namingTheme as NamingTheme] : ['memes']))
    setNamingMode(settings.namingMode ?? 'random')
    setSessionSummaryMode(settings.sessionSummaryMode ?? 'tasks')
    setPermissionMode(settings.permissionMode ?? 'bypassPermissions')
    setPermissionCycleModes(settings.permissionCycleModes ?? ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
    setPermissionBundles(settings.permissionBundles ?? [])
    setBlockDestructive(settings.blockDestructive !== false)
    setPermissionAllowRules(settings.permissionAllowRules ?? [])
    setPermissionDenyRules(settings.permissionDenyRules ?? [])
    setPermissionAskRules(settings.permissionAskRules ?? [])
    setAutoModeAllow(settings.autoModeAllow ?? [])
    setAutoModeSoftDeny(settings.autoModeSoftDeny ?? [])
    setAutoModeHardDeny(settings.autoModeHardDeny ?? [])
    setMaxBudgetUsd(settings.maxBudgetUsd ?? 0)
    setFallbackModel(settings.fallbackModel ?? 'default')
    setDisableCache(settings.disableCache ?? false)
    setPromptCache1h(settings.promptCache1h ?? true)
    setAutoRetryOnRateLimit(settings.autoRetryOnRateLimit ?? true)
    setContextCompactionHook(settings.contextCompactionHook ?? true)
    setCompactionLossless(settings.compactionLossless ?? true)
    setMaxTokens(settings.maxTokens ?? 0)
    setMaxConcurrent(settings.maxConcurrentProcesses ?? 8)
    setMaxGridTiles(settings.maxGridTiles ?? 12)
    setMaxGridColumns(settings.maxGridColumns ?? 6)
    setChatReadingWidth(settings.chatReadingWidth ?? 1200)
    setVerbosity(settings.verbosity ?? 3)
    setDefaultModel(settings.defaultModel ?? 'default')
    setDefaultEffort(settings.defaultEffort ?? DEFAULT_EFFORT)
    setCustomCommands(savedCommands(settings.customCommands ?? []))
    setTaskKickoffTemplate(settings.taskKickoffTemplate ?? '')
    setOutputStyle(settings.outputStyle ?? 'Default')
    setLanguage(settings.language ?? '')
    setAutocompact(settings.autocompact ?? '')
    setCloudSyncUrl(settings.cloudSyncUrl || '')
    setCloudSyncKey(settings.cloudSyncKey || '')
    setMachineName(settings.machineName || '')
  }, [settings])

  /* A setting card. `id` is the card's canonical name and doubles as its data-card
     attribute, which is what the coverage check enumerates. `span` is its width in the
     12-column band grid. */
  const card = (id: string, _span: number, body: React.ReactNode) => (
    <div className="set-card" data-card={id}>
      <h3 className="set-card-title">{id}</h3>
      {body}
    </div>
  )

  /* A card parked in Legacy: same content, plus the tier pill and the one-line reason
     it is here. Nothing is disabled; these still work exactly as they did. */
  const legacyCard = (id: string, tier: 'notwired' | 'never' | 'off', tierLabel: string, why: string, body: React.ReactNode) => (
    <div className="set-card set-legacy-card" data-card={id} data-legacy-item>
      <h3 className="set-card-title">{id}</h3>
      <div className="set-why"><span className={`set-pill ${tier}`}>{tierLabel}</span><span>{why}</span></div>
      {body}
    </div>
  )

  const band = (key: string, label: string, cards: React.ReactNode[]) => (
    <section className="set-band" id={`set-g-${key}`}>
      <h2 className="set-band-label">{label}</h2>
      <div className="set-band-cards">{cards}</div>
    </section>
  )

  return (
    <div className="settings-page">
      {/* One slim bar. The old header, the tab strip and the vanity strip are gone:
          they cost 246px above the first setting between them. */}
      <div className="set-bar">
        <button className="set-back" onClick={handleBack}>&larr; Back</button>
        <h1 className="set-title">Settings</h1>
        <span className="set-spacer" />
        <span className="set-state">{dirty ? 'Unsaved changes' : ''}</span>
      </div>

      <div className="set-body">
        <div className="set-scroll" data-content ref={scrollRef}>
          <div className="set-inner">

          {band('permissions', 'Permissions and CLI', [
            card('Default Permission Mode', 7, <>
              <p className="set-hint">Starting mode for new chats. Use Shift+Tab in the chat to cycle per-message.</p>
              <select
                className="form-select"
                value={permissionMode}
                onChange={e => setPermissionMode(e.target.value as PermissionMode)}
              >
                <option value="bypassPermissions">Bypass (auto-approve all)</option>
                <option value="acceptEdits">Accept Edits (auto-approve file writes)</option>
                <option value="auto">Auto Mode (Claude decides w/ safeguards)</option>
                <option value="plan">Plan (read-only)</option>
                <option value="default">Default (ask every action)</option>
              </select>
              <div className="set-sub">Modes included in the Shift+Tab cycle</div>
              <div className="set-checks">
                {(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as PermissionMode[]).map(mode => (
                  <label key={mode}>
                    <input
                      type="checkbox"
                      checked={permissionCycleModes.includes(mode)}
                      onChange={e => {
                        if (e.target.checked) {
                          setPermissionCycleModes([...permissionCycleModes, mode])
                        } else {
                          setPermissionCycleModes(permissionCycleModes.filter(m => m !== mode))
                        }
                      }}
                    />
                    {mode === 'bypassPermissions' ? 'Bypass' :
                     mode === 'acceptEdits' ? 'Accept Edits' :
                     mode === 'plan' ? 'Plan Mode' :
                     mode === 'auto' ? 'Auto Mode' : 'Default'}
                  </label>
                ))}
              </div>
            </>),

            card('Permission Rules', 7, <>
              <p className="set-hint">
                What an agent is allowed to do without stopping to ask. Turn on what the work needs.
                These apply to every chat; a single chat can be granted more from its own right-click menu.
              </p>

              <PermissionBundlePicker
                value={permissionBundles}
                onChange={setPermissionBundles}
                blockDestructive={blockDestructive}
                onBlockDestructive={setBlockDestructive}
              />

              {/* Everything below is the raw CLI rule syntax. Collapsed, because it is the
                  implementation of the toggles above and reads as programmer furniture to
                  everyone else, but kept, because a bundle can never cover every case. */}
              <details className="set-advanced">
                <summary>Advanced: individual rules</summary>

                <p className="set-guide">
                  Written in the CLI’s own pattern syntax and added to whatever the toggles above
                  already grant. OrcStrator hands these to every spawn in its managed
                  <code>--settings</code> file, which is the CLI’s <code>flagSettings</code> source:
                  one of only three it trusts for classifier rules, so they apply even where a
                  repo’s own <code>.claude/settings.json</code> would be ignored. Unioned with the
                  rules in <code>~/.claude</code> and the repo, never a replacement for them.
                </p>

                <div className="set-withbtn">
                  <button className="btn btn-sm" onClick={applyRecommendedGitRules}>Add git grants and guards</button>
                </div>
                <p className="set-guide">
                  The older, narrower preset. Grants {RECOMMENDED_GIT_SUMMARY.grants}, and adds
                  guards, which are DENIES, against {RECOMMENDED_GIT_SUMMARY.guards}. Superseded by
                  the Git toggle above, kept because it is verified against the CLI and some people
                  want exactly it.
                </p>

                <div className="set-sub">Pattern rules, matched before the classifier runs</div>
                <RuleList
                  label="Allow"
                  rules={permissionAllowRules}
                  onChange={setPermissionAllowRules}
                  placeholder="Bash(gh pr merge:*)"
                  hint="Decided here and never sent to the classifier, in any permission mode. Glob match, so Bash(git push:*) covers git push --force too. Fence the destructive spellings with a deny rule rather than by leaving the allow out."
                />
                <RuleList
                  label="Ask"
                  rules={permissionAskRules}
                  onChange={setPermissionAskRules}
                  placeholder="Bash(*supabase functions deploy*)"
                  hint="Stops the chat and asks you, instead of deciding. The one to reach for: a deny tells the agent no, and it just does the job a different way before you can answer, so your Allow lands on work already finished. An ask holds the chat still until you click, then runs the original command untouched. Beats an allow. A deny for the same command beats this, so do not list a command in both."
                />
                <RuleList
                  label="Deny"
                  rules={permissionDenyRules}
                  onChange={setPermissionDenyRules}
                  placeholder="Bash(rm -rf:*)"
                  hint="Refuses outright, with no chance to approve it. Beats both allow and ask, so this is where a broad allow gets narrowed. Globs match anywhere in the command, which is how Bash(git push*--force*) still catches a --force parked at the end of the line."
                />

                <div className="set-sub">Classifier rules, plain English, Auto mode only</div>
                <p className="set-guide">
                  The CLI reads these keys from this file, but in testing none of them
                  changed a verdict: an allow did not get a push through, and a hard deny did not stop
                  a command the classifier was happy with. Treat them as a nudge. Anything that has to
                  hold, put in the pattern rules above.
                </p>
                <RuleList
                  label="Allow"
                  rules={autoModeAllow}
                  onChange={setAutoModeAllow}
                  placeholder="Pushing commits with git push, as long as it is not a force push"
                  hint="Describe the action the way you would to a person. Read only in Auto mode, and only from this file, your own ~/.claude, or managed policy."
                />
                <RuleList
                  label="Soft deny"
                  rules={autoModeSoftDeny}
                  onChange={setAutoModeSoftDeny}
                  placeholder="Anything that sends data to a third-party service"
                  hint="Stops and asks rather than refusing. The right bucket for things you usually want to approve by hand."
                />
                <RuleList
                  label="Hard deny"
                  rules={autoModeHardDeny}
                  onChange={setAutoModeHardDeny}
                  placeholder="Any force push, wherever the flag appears on the line"
                  hint="Meant to refuse outright. A pattern allow above wins regardless, because it short-circuits before the classifier is consulted, so never allow a broad pattern and try to carve it back out here."
                />
              </details>
            </>),

            card('Raw CLI Flags', 5, <>
              <p className="set-hint">Passed to every claude spawn. Only allow-listed prefixes are accepted.</p>
              <div className="settings-flag-list">
                {flags.filter(f => !f.startsWith('--dangerously-skip-permissions') && !f.startsWith('--permission-mode')).map(flag => (
                  <span key={flag} className="settings-flag">
                    {flag}
                    <button className="settings-flag-remove" onClick={() => removeFlag(flag)}>x</button>
                  </span>
                ))}
              </div>
              <p className="set-guide">Permission and skip-permission flags are managed above, so they are not listed here.</p>
              <div className="set-withbtn">
                <input
                  className="form-input"
                  placeholder="--flag-name"
                  value={newFlag}
                  onChange={e => setNewFlag(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addFlag()}
                />
                <button className="btn btn-sm" onClick={addFlag}>Add</button>
              </div>
            </>),
          ])}

          {band('model', 'Model and effort', [
            card('Default AI Model', 2, <>
              <p className="set-hint">What a new chat starts on.</p>
              <select
                className="form-select"
                value={defaultModel}
                onChange={e => setDefaultModel(e.target.value as AgentModel)}
              >
                {MODEL_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </>),

            card('Default Effort', 2, <>
              <p className="set-hint">Reasoning budget a new chat starts on.</p>
              <select
                className="form-select"
                value={defaultEffort}
                onChange={e => setDefaultEffort(e.target.value as EffortLevel)}
              >
                {EFFORT_LEVELS.map(l => (
                  <option key={l.id} value={l.id}>{l.id === DEFAULT_EFFORT ? `Default (${l.label})` : l.label}</option>
                ))}
              </select>
            </>),

            /* The /config surface, without the /config. Everything /config offers that only
               drives the CLI's own terminal UI is left out: OrcStrator draws its own. */
            card('Claude Behaviour', 5, <>
              <p className="set-hint">
                What Claude Code's <code>/config</code> sets, set here instead. These change the system
                prompt, so a chat picks them up on its <strong>next turn</strong>, at the cost of one
                prompt-cache rebuild. Any chat can override them from its own menu.
              </p>
              <div className="set-two">
                <div>
                  <label className="set-flab">Output style</label>
                  <select
                    className="form-select"
                    value={outputStyle}
                    onChange={e => setOutputStyle(e.target.value)}
                  >
                    {OUTPUT_STYLE_BUILTINS.map(s => (
                      <option key={s.value} value={s.value}>{s.icon} {s.name}</option>
                    ))}
                    {customStyles.length > 0 && (
                      <optgroup label="Custom (~/.claude/output-styles)">
                        {customStyles.map(s => (
                          <option key={s.value} value={s.value}>{s.name}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  {/* The description lives here, not inside the option labels: a select clips
                      its own text at the control's width. */}
                  <p className="set-guide">
                    <strong>{selectedStyle?.name ?? outputStyle}:</strong> {selectedStyle?.description ?? 'Custom output style'}.
                    {outputStyle === 'Default' && ' Concise is the one that saves tokens: same work, none of the narration.'}
                    {customStyles.some(s => s.value === outputStyle) && (
                      <> A custom style also drops Claude Code's own coding instructions unless its
                      file sets <code>keep-coding-instructions: true</code>.</>
                    )}
                  </p>
                </div>
                <div>
                  <label className="set-flab">Response language</label>
                  <input
                    className="form-input"
                    value={language}
                    onChange={e => setLanguage(e.target.value)}
                    placeholder="English (default), or spanish, japanese, portuguese..."
                  />
                  <p className="set-guide">Changes the language Claude replies in. Code, file names and commands stay as they are.</p>
                </div>
              </div>
            </>),

            card('Chat Verbosity', 3, <>
              <p className="set-hint">How much of the transcript OrcStrator draws.</p>
              <div className="set-range">
                <span className="set-range-icon">{VERBOSITY_TIERS[verbosity - 1]?.icon}</span>
                <input
                  aria-label="Chat verbosity"
                  type="range" min={1} max={5} step={1}
                  value={verbosity}
                  onChange={e => setVerbosity(Number(e.target.value))}
                  className="form-input"
                />
                <span className="set-range-val">{VERBOSITY_TIERS[verbosity - 1]?.name}</span>
              </div>
              <p className="set-guide">
                <strong>{VERBOSITY_TIERS[verbosity - 1]?.name}:</strong> {VERBOSITY_TIERS[verbosity - 1]?.description}
              </p>
            </>),
          ])}

          {band('tokens', 'Tokens and context', [
            card('Cache Control', 2, <>
              <div className="settings-toggle">
                <span className="settings-toggle-label">1-hour prompt cache (extends cache TTL 5m to 1h)</span>
                <div className={`toggle-switch ${promptCache1h ? 'active' : ''}`} onClick={() => setPromptCache1h(v => !v)} />
              </div>
              <p className="set-guide">Cache hits are the cheapest tokens you will ever buy. Writing to the 1-hour cache costs twice the input price instead of 1.25x.</p>
            </>),

            card('Reliability', 2, <>
              <div className="settings-toggle">
                <span className="settings-toggle-label">Auto-retry on rate limit</span>
                <div className={`toggle-switch ${autoRetryOnRateLimit ? 'active' : ''}`} onClick={() => setAutoRetryOnRateLimit(v => !v)} />
              </div>
              <p className="set-guide">
                Resends "Try Again" with backoff: 10s, 20s, 40s. Only for transient server throttling,
                never your usage limit, chat instances only. Stops after 6 attempts.
              </p>
            </>),

            card('Context Compaction', 2, <>
              <div className="settings-toggle">
                <span className="settings-toggle-label">Trim large tool outputs before they enter context</span>
                <div className={`toggle-switch ${contextCompactionHook ? 'active' : ''}`} onClick={() => setContextCompactionHook(v => !v)} />
              </div>
              <div className="settings-toggle" style={{ opacity: contextCompactionHook ? 1 : 0.4 }}>
                <span className="settings-toggle-label">Lossless only, never trim the middle</span>
                <div className={`toggle-switch ${compactionLossless ? 'active' : ''}`} onClick={() => contextCompactionHook && setCompactionLossless(v => !v)} />
              </div>
              <p className="set-guide">
                Lossless minifies JSON and strips ANSI codes, duplicate log lines and embedded images,
                none of which a text model can read. Turn it off to also elide the middle of oversized
                outputs to head plus tail. Applies to instances started after you save.
              </p>
            </>),

            /* A different knob from the compaction hook above: that one trims tool output on
               the way in, this one decides how full the window gets before Claude Code
               compacts the whole conversation. */
            card('Auto-Compact Window', 3, <>
              <select
                className="form-select"
                value={autocompact}
                onChange={e => setAutocompact(e.target.value)}
              >
                {AUTOCOMPACT_OPTIONS.map(opt => (
                  <option key={opt.value || 'default'} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <p className="set-guide">
                When Claude Code compacts the conversation on its own. The default caps context at 80%
                of the window, which is what the context gauge is calibrated against. Applies to turns
                started after you save.
              </p>
            </>),

            card('Plan Limits', 3, <>
              <label className="set-flab">Minutes between usage checks</label>
              <input
                aria-label="Minutes between usage checks"
                type="number"
                className="form-input"
                value={usagePoll}
                onChange={e => setUsagePoll(Number(e.target.value))}
                min={1}
                max={60}
              />
              <p className="set-guide">The CLI itself polls every minute.</p>
              {usage?.connected && usage.source === 'oauth' && (
                <button
                  className="btn btn-sm set-danger"
                  onClick={async () => {
                    try {
                      const fresh = await api.disconnectUsage()
                      dispatch({ type: 'SET_USAGE', payload: fresh })
                    } catch { /* ignore */ }
                  }}
                >
                  Disconnect Claude account
                </button>
              )}
              {usage?.connected && usage.source === 'cli' && (
                <p className="set-guide">Using Claude CLI credentials. Switch accounts with `claude login`.</p>
              )}
            </>),
          ])}

          {band('capacity', 'Capacity', [
            card('Max Concurrent Agents', 3, <>
              <p className="set-hint">Hard cap on simultaneous CLI processes.</p>
              <div className="set-range">
                <input
                  type="range"
                  className="form-input"
                  aria-label="Max concurrent agents"
                  value={maxConcurrent}
                  onChange={e => setMaxConcurrent(Number(e.target.value))}
                  min={1}
                  max={20}
                  step={1}
                />
                <span className="set-range-val">{maxConcurrent}</span>
              </div>
              <div className="set-scale">
                <span>1</span>
                <span style={{ color: maxConcurrent > 6 ? 'var(--warning, #f59e0b)' : 'inherit' }}>
                  {maxConcurrent > 6 ? 'High memory usage' : maxConcurrent <= 3 ? 'Conservative' : 'Balanced'}
                </span>
                <span>20</span>
              </div>
            </>),

            card('Max Open Chat Cards', 3, <>
              <p className="set-hint">Chat cards open simultaneously in the grid.</p>
              <div className="set-range">
                <input
                  type="range"
                  className="form-input"
                  aria-label="Max open chat cards"
                  value={maxGridTiles}
                  onChange={e => setMaxGridTiles(Number(e.target.value))}
                  min={1}
                  max={12}
                  step={1}
                />
                <span className="set-range-val">{maxGridTiles}</span>
              </div>
              <div className="set-scale">
                <span>1</span>
                <span>{maxGridTiles === 1 ? 'Single focus' : maxGridTiles <= 4 ? 'Focused' : maxGridTiles <= 9 ? 'Balanced' : 'Ultrawide'}</span>
                <span>12</span>
              </div>
            </>),

            card('Grid Columns', 3, <>
              <p className="set-hint">Max columns the grid spreads cards into.</p>
              <div className="set-range">
                <input
                  type="range"
                  className="form-input"
                  aria-label="Grid columns"
                  value={maxGridColumns}
                  onChange={e => setMaxGridColumns(Number(e.target.value))}
                  min={2}
                  max={6}
                  step={1}
                />
                <span className="set-range-val">{maxGridColumns}</span>
              </div>
              <div className="set-scale">
                <span>2</span>
                <span>{maxGridColumns <= 3 ? 'Standard' : maxGridColumns <= 4 ? 'Wide' : 'Ultrawide'}</span>
                <span>6</span>
              </div>
              <p className="set-guide">Cards fill a single row up to this many columns, then wrap into balanced rows.</p>
            </>),

            /* Consumed by GridView.tsx, where it caps a maximized GRID tile. */
            card('Expanded Chat Width', 3, <>
              <p className="set-hint">How wide a maximized grid tile is allowed to get.</p>
              <div className="set-range">
                <input
                  type="range"
                  className="form-input"
                  aria-label="Expanded chat width"
                  value={readingWidthIdx}
                  onChange={e => setChatReadingWidth(READING_WIDTH_STOPS[Number(e.target.value)])}
                  min={0}
                  max={READING_WIDTH_STOPS.length - 1}
                  step={1}
                />
                <span className="set-range-val">{READING_WIDTH_LABELS[readingWidthIdx]}</span>
              </div>
              <div className="set-scale">
                <span>{READING_WIDTH_LABELS[0]}</span>
                <span>{chatReadingWidth > 0 ? `${chatReadingWidth}px` : 'no cap'}</span>
                <span>{READING_WIDTH_LABELS[READING_WIDTH_LABELS.length - 1]}</span>
              </div>
              <p className="set-guide">
                A maximized tile centres itself in a column this wide instead of stretching edge to edge,
                so lines stay readable. Full width restores the old behaviour.
              </p>
            </>),
          ])}

          {band('appearance', 'Appearance', [
            card('Theme', 3, (
              <div className="form-radio-group">
                {(['dark', 'light', 'system'] as const).map(t => (
                  <label key={t} className="form-radio-label">
                    <input type="radio" name="theme" checked={theme === t} onChange={() => setTheme(t)} />
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </label>
                ))}
              </div>
            )),

            card('Font Size', 3, (
              <div className="set-seg">
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
            )),

            card('Animation Tier', 3, (
              <div className="set-range">
                <span className="set-range-icon">{ANIMATION_TIERS[animationTier]?.icon}</span>
                <input
                  aria-label="Animation tier"
                  type="range" min={0} max={4} step={1}
                  value={animationTier}
                  onChange={e => setAnimationTier(Number(e.target.value))}
                  className="form-input"
                />
                <span className="set-range-val">{ANIMATION_TIERS[animationTier]?.name}</span>
              </div>
            )),

            card('Notifications', 3, <>
              <div className="settings-toggle">
                <span className="settings-toggle-label">Desktop notifications</span>
                <div className={`toggle-switch ${notifications ? 'active' : ''}`} onClick={() => setNotifications(n => !n)} />
              </div>
              <div className="settings-toggle">
                <span className="settings-toggle-label">Show Claude plan limits</span>
                <div className={`toggle-switch ${showPlanLimits ? 'active' : ''}`} onClick={() => setShowPlanLimits(v => !v)} />
              </div>
            </>),
          ])}

          {band('workspace', 'Workspace', [
            card('Root Folder', 2, <>
              <p className="set-hint">Where the project browser starts.</p>
              <input
                className="form-input"
                placeholder="/path/to/projects"
                value={rootFolder}
                onChange={e => setRootFolder(e.target.value)}
              />
            </>),

            card('Custom Commands', 4, <>
              <p className="set-hint">Add your own slash commands to the &lt;/&gt; menu.</p>
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
              <button className="btn btn-sm" onClick={addCustomCommand}>+ Add Command</button>
            </>),

            /* The shared Anthropic key first, then each feature that spends it. Both Session
               Naming and Session Summary run on the same key. */
            card('AI Features', 6, <>
              <p className="set-hint">
                Anthropic API key. Used by the features below, which run on Claude Haiku and bill to
                your own key (a fraction of a cent per call). Stored encrypted on this machine.
              </p>
              <div className="set-withbtn">
                <input
                  className="form-input"
                  type="password"
                  placeholder={keySet ? '•••••••• (saved)' : 'sk-ant-...'}
                  value={anthropicKeyDraft}
                  onChange={e => setAnthropicKeyDraft(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveKey()}
                />
                <button className="btn btn-sm" onClick={saveKey} disabled={keyBusy || !anthropicKeyDraft.trim()}>
                  {keySet ? 'Update' : 'Save key'}
                </button>
                {keySet && (
                  <button className="btn btn-sm" onClick={clearKey} disabled={keyBusy} title="Remove stored key">
                    Remove
                  </button>
                )}
              </div>
              {/* Fixed-height status line, so the card cannot jump as the message toggles. */}
              <div className="set-keystate" style={{ color: keyMsg ? 'var(--accent)' : keySet ? 'var(--success)' : 'var(--text-tertiary)' }}>
                {keyMsg ?? (keySet ? 'Key saved, stored encrypted on this machine.' : 'No key yet. The features below stay off until you add one.')}
              </div>

              <div className="settings-subhead">Session Naming</div>
              <div className="form-radio-group">
                <label className="form-radio-label">
                  <input type="radio" name="namingMode" checked={namingMode === 'random'} onChange={() => setNamingMode('random')} />
                  Random words
                </label>
                <label className="form-radio-label">
                  <input type="radio" name="namingMode" checked={namingMode === 'ai'} onChange={() => setNamingMode('ai')} />
                  AI (Haiku)
                </label>
              </div>
              <p className="set-guide">
                {namingMode === 'ai'
                  ? 'Fallback pool when AI naming is unavailable. Pick one or more.'
                  : 'Pick one or more. Names are drawn from the combined pool.'}
              </p>
              <div className="set-tags">
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

              <div className="settings-subhead">Session Summary</div>
              <p className="set-guide">
                When you close a session, summarize its last 20 messages with Haiku and file the
                summary on the task it came from, along with that session's Claude tasks. Runs
                once at close, never per turn.
              </p>
              <div className="form-radio-group">
                <label className="form-radio-label">
                  <input
                    type="radio"
                    name="sessionSummaryMode"
                    checked={sessionSummaryMode === 'tasks'}
                    onChange={() => setSessionSummaryMode('tasks')}
                  />
                  Sessions started from a task
                </label>
                <label className="form-radio-label">
                  <input
                    type="radio"
                    name="sessionSummaryMode"
                    checked={sessionSummaryMode === 'all'}
                    onChange={() => setSessionSummaryMode('all')}
                  />
                  All sessions
                </label>
                <label className="form-radio-label">
                  <input
                    type="radio"
                    name="sessionSummaryMode"
                    checked={sessionSummaryMode === 'off'}
                    onChange={() => setSessionSummaryMode('off')}
                  />
                  Off
                </label>
              </div>
            </>),
          ])}

          {/* Legacy. Nothing here is disabled or deleted: these controls work exactly as they
              did, they are just out of the way, each with the reason it was parked. */}
          <details className="set-legacy" id="set-legacy" ref={legacyRef}>
            <summary>
              <span className="set-caret">&#9654;</span>
              <h2>Legacy</h2>
              <span className="set-legacy-count">
                7 settings and 1 control that nothing on this machine is using. Out of the way, not deleted.
              </span>
            </summary>
            <div className="set-legacy-lede">
              Each one says why it is here. <b>Not wired up</b>: OrcStrator does not read this setting yet,
              so changing it does nothing. <b>Never used</b>: it works, it has just never been set up here.
              <b> Off</b>: switched off, or still on the value it shipped with.
            </div>
            <div className="set-legacy-grid">
              {legacyCard('Max Budget per Session (USD)', 'notwired', 'not wired up',
                `OrcStrator does not read this setting yet, so changing it has no effect. ${maxBudgetUsd > 0 ? 'Set, but inert.' : 'Currently unset.'}`, <>
                <label className="set-flab">0 = unlimited. Applies to pipeline tasks.</label>
                <span className="set-num">
                <input
                  type="number"
                  className="form-input"
                  value={maxBudgetUsd}
                  onChange={e => setMaxBudgetUsd(Number(e.target.value))}
                  min={0}
                  step={0.5}
                  placeholder="0"
                /><em>USD</em></span>
              </>)}

              {legacyCard('Fallback Model', 'notwired', 'not wired up',
                `OrcStrator does not read this setting yet, so changing it has no effect. ${fallbackModel !== 'default' ? 'Set, but inert.' : 'Currently unset.'}`, <>
                <p className="set-guide">Would switch to this model if the primary were overloaded.</p>
                <select
                  className="form-select"
                  value={fallbackModel}
                  onChange={e => setFallbackModel(e.target.value as AgentModel)}
                >
                  {MODEL_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </>)}

              {legacyCard('Max Output Tokens', 'notwired', 'not wired up',
                `OrcStrator does not read this setting yet, so changing it has no effect. ${maxTokens > 0 ? 'Set, but inert.' : 'Every turn runs on the model default.'}`, <>
                <label className="set-flab">0 = unlimited (model default)</label>
                <span className="set-num">
                <input
                  type="number"
                  className="form-input"
                  value={maxTokens}
                  onChange={e => setMaxTokens(Number(e.target.value))}
                  min={0}
                  step={1000}
                  placeholder="0"
                /><em>tokens</em></span>
              </>)}

              {/* A dead CONTROL rather than a whole card: its parent, Cache Control, stays in
                  the main body because the 1 hour toggle beside it is live. It deliberately
                  carries no data-card, so it cannot inflate the 29-card coverage count. */}
              <div className="set-card set-legacy-card" data-legacy-item>
                <h3 className="set-card-title">Disable prompt cache</h3>
                <div className="set-why">
                  <span className="set-pill notwired">not wired up</span>
                  <span>OrcStrator does not read this setting yet, so changing it has no effect.</span>
                </div>
                <div className="settings-toggle">
                  <span className="settings-toggle-label">Disable prompt caching (--no-cache)</span>
                  <div className={`toggle-switch ${disableCache ? 'active' : ''}`} onClick={() => setDisableCache(v => !v)} />
                </div>
              </div>

              {legacyCard('Cloud Sync (Supabase)', 'never', 'never used',
                cloudSyncUrl || cloudSyncKey || machineName
                  ? 'Partly filled in. Sync runs once all three are set.'
                  : 'Not set up: the machine name, address and key are all empty.', <>
                <p className="set-guide">
                  Sync your pipeline across machines. Create a free{' '}
                  <a href="https://supabase.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Supabase</a>{' '}
                  project, run the schema from <code>server/supabase/schema.sql</code>, then paste the credentials below.
                </p>
                <label className="set-flab">Machine name</label>
                <input
                  className="form-input"
                  placeholder="e.g. Desktop"
                  value={machineName}
                  onChange={e => setMachineName(e.target.value)}
                />
                <label className="set-flab">Supabase URL</label>
                <input
                  className="form-input"
                  placeholder="https://abc123.supabase.co"
                  value={cloudSyncUrl}
                  onChange={e => setCloudSyncUrl(e.target.value)}
                />
                <label className="set-flab">Supabase anon key</label>
                <input
                  className="form-input"
                  type="password"
                  placeholder="eyJ..."
                  value={cloudSyncKey}
                  onChange={e => setCloudSyncKey(e.target.value)}
                />
                <div className="set-withbtn">
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
                      alignSelf: 'center',
                      color: syncTestResult.ok ? 'var(--success)' : 'var(--error)',
                    }}>
                      {syncTestResult.ok ? 'Connected!' : syncTestResult.error || 'Failed'}
                    </span>
                  )}
                </div>
              </>)}

              {legacyCard('Task Kickoff Prompt', 'never', 'never used',
                taskKickoffTemplate.trim()
                  ? 'Customised. Tasks start with your version below.'
                  : 'Not customised, so tasks start with the built-in prompt.', <>
                <p className="set-guide">
                  Sent as the first message when you start an instance from a pipeline task.
                  Placeholders: {'{{title}}'}, {'{{description}}'}, {'{{comments}}'}.
                </p>
                <textarea
                  className="form-input"
                  value={taskKickoffTemplate}
                  onChange={e => setTaskKickoffTemplate(e.target.value)}
                  placeholder={DEFAULT_TASK_KICKOFF_TEMPLATE}
                  rows={4}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
                />
              </>)}

              {legacyCard('Sound Tier', 'off', 'off',
                soundTier === 0
                  ? `Currently ${SOUND_TIERS[0]?.name}, which plays nothing.`
                  : `Currently ${SOUND_TIERS[soundTier]?.name}.`, (
                <div className="set-range">
                  <span className="set-range-icon">{SOUND_TIERS[soundTier]?.icon}</span>
                  <input
                    aria-label="Sound tier"
                    type="range" min={0} max={4} step={1}
                    value={soundTier}
                    onChange={e => setSoundTier(Number(e.target.value))}
                    className="form-input"
                  />
                  <span className="set-range-val">{SOUND_TIERS[soundTier]?.name}</span>
                </div>
              ))}

              {legacyCard('Idle Timeout', 'off', 'off',
                idleTimeout === 60
                  ? 'Still on the 60 second default it shipped with.'
                  : `Changed from the 60 second default to ${idleTimeout}.`, <>
                <label className="set-flab">Seconds before idle restart</label>
                <input
                  aria-label="Seconds before idle restart"
                  type="number"
                  className="form-input"
                  value={idleTimeout}
                  onChange={e => setIdleTimeout(Number(e.target.value))}
                  min={0}
                  step={10}
                />
              </>)}
            </div>
          </details>

            {/* At the end of the page, in the flow. It used to be pinned, which meant it
                sat on top of whichever card was under it. It is always present rather than
                dirty-only, because a value that is merely DISPLAYED as a default and was
                never written to the database leaves nothing dirty, so a dirty-only bar
                offered no way to save it at all. */}
            <div className={`set-savebar${dirty ? ' dirty' : ''}`}>
              <span>{dirty ? 'Unsaved changes' : 'All changes saved'}{saved && <b className="set-tick"> saved</b>}</span>
              <button className="btn btn-sm" onClick={handleDiscard} disabled={!dirty}>Discard</button>
              <button className="btn btn-primary btn-sm" onClick={onSave}>{dirty ? 'Save changes' : 'Save'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
