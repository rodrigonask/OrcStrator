import { useCallback, useMemo } from 'react'
import type { ComponentType } from 'react'
import { IconGrid, IconChat, IconPipeline, IconSessions, IconSkills, IconUsage, IconActivity, IconSettings, IconShrink, type IconProps } from './icons'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useInstances } from '../context/InstancesContext'
import { useActiveInstances, type ActiveInstance, type CacheInfo } from '../hooks/useActiveInstances'
import { useInstanceContextMenu } from '../hooks/useInstanceContextMenu'
import { useOpenInstance } from '../hooks/useOpenInstance'
import { useGoHome } from '../hooks/useGoHome'
import { useUltraCompact } from '../hooks/useUltraCompact'
import { usePendingSurfaces } from '../hooks/usePendingSurfaces'
import { useTroubledSchedules, troubledTitle } from '../hooks/useTroubledSchedules'
import { ConnectionStatus } from './ConnectionStatus'
import { ShutdownButton } from './ShutdownButton'
import type { InstanceConfig, FolderConfig } from '@shared/types'
import type { ViewName } from '../context/UIContext'

const NAV_ITEMS: { key: ViewName; Icon: ComponentType<IconProps>; label: string }[] = [
  { key: 'grid', Icon: IconGrid, label: 'Grid' },
  { key: 'chat', Icon: IconChat, label: 'Chat' },
  { key: 'pipeline', Icon: IconPipeline, label: 'Pipeline' },
  { key: 'sessions', Icon: IconSessions, label: 'Sessions' },
  { key: 'skills', Icon: IconSkills, label: 'Skills' },
  { key: 'usage', Icon: IconUsage, label: 'Usage' },
  { key: 'activity', Icon: IconActivity, label: 'Activity' },
]

/** One Cache-Active chip: a background progress bar of remaining cache TTL (full
 *  chip when fresh → shrinks toward expiry, pulses under 5 min), the chat name,
 *  cache hit %, and minutes-to-expiry. Right-click opens the shared instance menu.
 *
 *  A chip that is blocked on the user goes amber and wears a steady dot instead of the
 *  pulsing live one: it is not working, it is waiting, and those must not look alike. */
function TopBarTab({ inst, cache, isRunning, awaitingInput, projLabel, onOpen }: {
  inst: InstanceConfig
  cache: CacheInfo | null
  isRunning: boolean
  awaitingInput: InstanceConfig['awaitingInput']
  projLabel: string
  onOpen: (inst: InstanceConfig) => void
}) {
  const { onContextMenu, menu, isOpen } = useInstanceContextMenu(inst)
  const waiting = awaitingInput != null
  const waitLabel = awaitingInput === 'plan' ? 'Waiting on your plan approval' : 'Waiting on your answer'
  const expiring = cache != null && cache.minsLeft <= 5
  const ttlPct = cache != null ? Math.max(2, Math.round(cache.ttlFraction * 100)) : 0
  // Urgency color: green when fresh → amber → red-orange as the cache nears expiry.
  const hue = cache != null ? Math.round(15 + cache.ttlFraction * 120) : 0
  const ttlStyle = cache != null
    ? { width: `${ttlPct}%`, background: `hsla(${hue}, 70%, 50%, 0.13)`, borderRightColor: `hsla(${hue}, 72%, 46%, 0.42)` }
    : undefined
  return (
    <button
      className={`topbar-tab${waiting ? ' waiting' : ''}${isRunning ? ' running' : ''}${isOpen ? ' context-open' : ''}${expiring && !waiting ? ' expiring' : ''}`}
      onClick={() => onOpen(inst)}
      onContextMenu={onContextMenu}
      title={`${projLabel} · ${inst.name}${waiting ? `\n${waitLabel}` : ''}${cache?.ratio != null ? `\n${cache.ratio}% cache hit · ${cache.minsLeft}m to expiry` : ''}\nRight-click for options`}
    >
      {/* The TTL fill is suppressed while blocked. Its colour runs green-to-red by cache
          urgency, and the commonest waiting chip has just finished a turn, so a near
          full-width GREEN wash would sit inside an amber "needs you" chip and say
          "healthy" over the top of it. The minutes are still in the tooltip. */}
      {cache != null && !waiting && (
        <span className="topbar-tab-ttl" style={ttlStyle} aria-hidden="true" />
      )}
      {waiting
        ? <span className="topbar-tab-wait" aria-label={waitLabel} role="img" />
        : isRunning && <span className="topbar-tab-live" aria-hidden="true" />}
      <span className="topbar-tab-name">{inst.name}</span>
      {menu}
    </button>
  )
}

/**
 * Full-width top header: app nav icons on the left (over the sidebar column),
 * then the Cache Active instances as horizontal, clickable "tabs" that jump you
 * straight into that chat (grid tile or chat view). Mirrors the sidebar's
 * Cache Active panel — same source via useActiveInstances.
 */
export function TopBar({ sidebarCollapsed, onToggleSidebar }: { sidebarCollapsed: boolean; onToggleSidebar: () => void }) {
  const { view, showSettings, activePipelineId } = useUI()
  const pendingSurfaces = usePendingSurfaces()
  const troubled = useTroubledSchedules()
  const { folders } = useInstances()
  const { dispatch } = useAppDispatch()
  const active = useActiveInstances()
  const openInstance = useOpenInstance()
  const goHome = useGoHome()
  const { toggle: toggleUltra } = useUltraCompact()

  const folderById = useMemo(() => {
    const m = new Map<string, FolderConfig>()
    for (const f of folders) m.set(f.id, f)
    return m
  }, [folders])

  // Bundle active chats by folder so each project shows once, with its chats
  // grouped beneath its name. Folder order follows the running-first sort.
  const groups = useMemo(() => {
    const byFolder = new Map<string, { folder: FolderConfig | undefined; items: ActiveInstance[] }>()
    for (const a of active) {
      let g = byFolder.get(a.inst.folderId)
      if (!g) {
        g = { folder: folderById.get(a.inst.folderId), items: [] }
        byFolder.set(a.inst.folderId, g)
      }
      g.items.push(a)
    }
    return [...byFolder.values()]
  }, [active, folderById])

  const handleNavClick = useCallback((target: ViewName) => {
    if (target === 'pipeline') {
      const pipelineId = activePipelineId || folders[0]?.id || null
      if (pipelineId) dispatch({ type: 'SET_PIPELINE_PROJECT', projectId: pipelineId })
    }
    // Keep the selected chat when going to the chat view; deselect for other views
    if (target !== 'chat') dispatch({ type: 'SELECT_INSTANCE', payload: null })
    dispatch({ type: 'CLOSE_SETTINGS' })
    dispatch({ type: 'SET_VIEW', payload: target })
  }, [dispatch, activePipelineId, folders])

  return (
    <div className="app-topbar">
      <div className={`app-topbar-brand${sidebarCollapsed ? ' is-collapsed' : ''}`}>
        <ConnectionStatus />
        {/* The mark sits INSIDE the home button, not beside it. Collapsing the sidebar
            shrinks this block to 52px and drops everything that will not fit, and when
            the mark was its own element that meant dropping the app's only logo and
            leaving a bare arrow. Now the wordmark goes and the mark stays, still
            clickable. */}
        <button
          className="sidebar-title"
          title="Home: mission control grid"
          onClick={goHome}
        >
          <span className="orc-logo" />
          <span className="sidebar-wordmark font-pixel">OrcStrator</span>
        </button>
        <button
          className="sidebar-collapse-btn app-topbar-collapse"
          onClick={onToggleSidebar}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? '▶' : '◀'}
        </button>
      </div>
      <div className="app-topbar-nav">
        {NAV_ITEMS.map(({ key, Icon, label }) => {
          // A scheduled run surfaced while the user was elsewhere: the Grid button carries the
          // same bright yellow the tile is holding, until they go and look. Never a
          // navigation: the app does not move the user, it tells them.
          // Owed is owed: on an unblocked grid the queue drains in the same tick, so the count is
          // already zero there. If it is not zero on the grid, a maximized tile is hiding the
          // surfaced one, and the dot is the only signal left.
          const owed = key === 'grid' && pendingSurfaces > 0
          // THE RED DOT. A scheduled card that failed three times or ran out of budget
          // switches itself off, and this dot is the entire alert: there is no email and
          // no push. Red, not the surfaced-run yellow, because yellow means "something is
          // waiting for you" and red means "something has stopped".
          const broken = key === 'pipeline' && troubled.count > 0
          return (
            <button
              key={key}
              className={`sidebar-nav-btn${view === key && !showSettings ? ' active' : ''}${owed ? ' has-surface' : ''}${broken ? ' has-trouble' : ''}`}
              onClick={() => handleNavClick(key)}
              title={owed
                ? `${label}: ${pendingSurfaces} scheduled run${pendingSurfaces === 1 ? '' : 's'} waiting`
                : broken ? troubledTitle(troubled.count, troubled.titles) : label}
            >
              <Icon />
              {owed && <span className="nav-surface-dot" aria-hidden="true" />}
              {broken && <span className="nav-trouble-dot" aria-hidden="true" />}
            </button>
          )
        })}
        <span className="sidebar-nav-sep" />
        {/* The way IN. Its counterpart lives at the bottom of the rail this replaces the
            bar with, so the mode has a visible switch in both of its states. */}
        <button
          className="sidebar-nav-btn"
          onClick={toggleUltra}
          title="Ultra Compact Mode — trade this bar for a 32px rail and give the chats the height back (Ctrl+Shift+U)"
        >
          <IconShrink />
        </button>
        <button
          className={`sidebar-nav-btn${showSettings ? ' active' : ''}`}
          onClick={() => dispatch({ type: 'OPEN_SETTINGS' })}
          title="Settings"
        >
          <IconSettings />
        </button>
        <ShutdownButton />
      </div>

      <div className="app-topbar-tabs">
        {groups.map(({ folder, items }) => {
          const projLabel = folder?.displayName || folder?.name || 'Unknown'
          return (
            <div className="topbar-group" key={items[0].inst.folderId}>
              <div className="topbar-group-label" style={folder?.color ? { color: folder.color } : undefined}>
                <span className="topbar-group-dot" style={{ background: folder?.color || 'var(--text-muted)' }} />
                {folder?.emoji ? `${folder.emoji} ` : ''}{projLabel}
              </div>
              <div className="topbar-group-chips">
                {items.map(({ inst, cache, isRunning, awaitingInput }) => (
                  <TopBarTab key={inst.id} inst={inst} cache={cache} isRunning={isRunning} awaitingInput={awaitingInput} projLabel={projLabel} onOpen={openInstance} />
                ))}
              </div>
            </div>
          )
        })}
      </div>

    </div>
  )
}
