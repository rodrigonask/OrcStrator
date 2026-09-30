import { lazy, Suspense, useEffect, useState, useCallback, useMemo } from 'react'
import { useFontSize } from './hooks/useFontSize'
import { AppProvider } from './context/AppContext'
import { useInstancesSelector } from './context/InstancesContext'
import { useUI } from './context/UIContext'
import { useAppDispatch } from './context/AppDispatchContext'
import { PipelineProvider } from './context/PipelineContext'
import { AllTasksProvider } from './context/AllTasksContext'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { GridView } from './components/grid/GridView'
// The pages you open now and then load on first visit, not with the app: Grid and
// Chat stay in the main bundle because they are the app.
const PipelineBoard = lazy(() => import('./components/pipeline/PipelineBoard').then(m => ({ default: m.PipelineBoard })))
const SettingsPage = lazy(() => import('./components/SettingsPage').then(m => ({ default: m.SettingsPage })))
const AgentsPage = lazy(() => import('./components/AgentsPage').then(m => ({ default: m.AgentsPage })))
const UsageReportPage = lazy(() => import('./components/UsageReportPage').then(m => ({ default: m.UsageReportPage })))
const SessionsPage = lazy(() => import('./components/SessionsPage').then(m => ({ default: m.SessionsPage })))
const SkillsPage = lazy(() => import('./components/SkillsPage').then(m => ({ default: m.SkillsPage })))
const ActivityPage = lazy(() => import('./components/ActivityPage').then(m => ({ default: m.ActivityPage })))
import { VFXOverlay } from './components/VFXOverlay'
import { CommandMenu } from './components/CommandMenu'
import { QuickTaskHotkey } from './components/pipeline/QuickTaskHotkey'
import { TopBar } from './components/TopBar'
import { CompactRail } from './components/CompactRail'
import { SecurityBanner } from './components/SecurityBanner'
import { ServerErrorBanner } from './components/ServerErrorBanner'
import { ConfirmProvider } from './components/ConfirmModal'
import { resolveAnimTier } from './hooks/useVFX'
import { useUltraCompact, useUltraCompactHotkey } from './hooks/useUltraCompact'
import { UIContext } from './context/UIContext'
import { api } from './api'
import { ReadOnlyBanner } from './components/ReadOnlyBanner'
import { useRenderCount } from './utils/renderCount'

function PaneProvider({ instanceId, children }: { instanceId: string; children: React.ReactNode }) {
  const ui = useUI()
  const overridden = useMemo(() => ({ ...ui, selectedInstanceId: instanceId }), [ui, instanceId])
  return <UIContext.Provider value={overridden}>{children}</UIContext.Provider>
}

function AppContent() {
  useRenderCount('AppContent')
  // Ids only, as one string: a running chat's progress does not re-render the app shell.
  const instanceIdList = useInstancesSelector(s => s.instances.map(i => i.id).join(','))
  const { selectedInstanceId, view, settings, showSettings } = useUI()
  const { dispatch: appDispatch } = useAppDispatch()
  const { zoom } = useFontSize()

  // Split view: array of instanceIds for extra panes (up to 3 more beyond selected)
  const [splitPanes, setSplitPanes] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('orcstrator.splitPanes') || '[]') } catch { return [] }
  })
  useEffect(() => {
    localStorage.setItem('orcstrator.splitPanes', JSON.stringify(splitPanes))
  }, [splitPanes])

  // Sidebar collapse lives here so the header's single toggle (in TopBar) and the
  // sidebar share one source of truth.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // Ultra Compact collapses the sidebar to a 32px strip that mirrors the rail on the
  // other edge, and its own toggle expands it on demand. Separate state from
  // sidebarCollapsed so peeking at the project tree in ultra does not silently change
  // what the sidebar looks like when the mode is switched off again.
  const [ultraSidebarShown, setUltraSidebarShown] = useState(false)

  // Expose split controls globally so InstanceItem context menu can use them
  useEffect(() => {
    (window as any).__orcSplitAdd = (id: string) => {
      setSplitPanes(prev => {
        if (prev.includes(id) || prev.length >= 3) return prev
        return [...prev, id]
      })
    };
    (window as any).__orcSplitRemove = (id: string) => {
      setSplitPanes(prev => prev.filter(x => x !== id))
    };
    (window as any).__orcSplitClear = () => setSplitPanes([])
    return () => {
      delete (window as any).__orcSplitAdd
      delete (window as any).__orcSplitRemove
      delete (window as any).__orcSplitClear
    }
  }, [])

  // Clean up split panes that reference deleted instances
  useEffect(() => {
    const instanceIds = new Set(instanceIdList.split(','))
    setSplitPanes(prev => prev.filter(id => instanceIds.has(id)))
  }, [instanceIdList])

  // Resolve 'system' theme to actual dark/light based on OS preference
  const [osPrefersDark, setOsPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setOsPrefersDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  const resolvedTheme = settings.theme === 'system'
    ? (osPrefersDark ? 'dark' : 'light')
    : settings.theme

  const animTier = resolveAnimTier(settings)

  // Ultra Compact Mode. Nearly all of it is CSS, so the flag rides on <html> rather than
  // being threaded through components: one attribute, and every density rule in the
  // stylesheet switches at once (see the [data-ultra="1"] block in styles.css).
  const { on: ultra, toggle: toggleUltra } = useUltraCompact()
  useUltraCompactHotkey(toggleUltra)
  useEffect(() => {
    if (ultra) document.documentElement.setAttribute('data-ultra', '1')
    else document.documentElement.removeAttribute('data-ultra')
  }, [ultra])

  // Sync theme to <html> so portals outside .app inherit theme variables
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme)
  }, [resolvedTheme])

  // Sync animation tier to root elements for CSS gating
  useEffect(() => {
    document.documentElement.setAttribute('data-anim-tier', String(animTier))
  }, [animTier])

  // Same reason as the theme sync above: the font-size zoom is a transform on `.app`, so
  // anything portalled to <body> to escape that transform is left at 1x and reads small
  // next to the rest of the UI. Publish the factor so those few overlays can scale
  // themselves back up.
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-zoom', String(zoom))
  }, [zoom])

  const scaleStyle = zoom !== 1 ? {
    transform: `scale(${zoom})`,
    transformOrigin: 'top left',
    width: `${(100 / zoom).toFixed(4)}vw`,
    height: `${(100 / zoom).toFixed(4)}vh`,
  } : {}
  useEffect(() => { api.connect() }, [])
  // The page title is AppProvider's job. A copy here subscribed the whole app to every chunk
  // of every chat's output, which re-rendered every Grid tile with it.

  return (
    <div className="app" data-theme={resolvedTheme} data-anim-tier={animTier} style={scaleStyle}>
      <ReadOnlyBanner />
      {!ultra && <TopBar sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setSidebarCollapsed(c => !c)} />}
      <div className="app-body">
        {/* In ultra the sidebar collapses to a 32px strip rather than disappearing: the
            same width as the rail on the far edge, so the canvas sits inside a symmetric
            frame instead of running off one side, and the way back to the project tree is
            always visible on the side the tree lives on. Expanding restores the full
            228px, since the point of asking for it is to read project names. */}
        <Sidebar
          collapsed={ultra ? !ultraSidebarShown : sidebarCollapsed}
          railToggle={ultra ? () => setUltraSidebarShown(s => !s) : undefined}
        />
        <main className="main-content">
          {/* A lazy page loads from disk in a few ms; an empty frame beats a spinner flash. */}
          <Suspense fallback={<div className="page-loading" />}>
          {showSettings ? (
            <SettingsPage />
          ) : (
            <>
              {view === 'grid' && <GridView />}
              {view === 'chat' && selectedInstanceId && splitPanes.length === 0 && <ChatView />}
              {view === 'chat' && selectedInstanceId && splitPanes.length > 0 && (
                <div className={`split-grid split-${splitPanes.length + 1}`}>
                  <div className="split-pane">
                    <ChatView />
                  </div>
                  {splitPanes.map(paneId => (
                    <div key={paneId} className="split-pane">
                      <PaneProvider instanceId={paneId}>
                        <ChatView />
                      </PaneProvider>
                      <button
                        className="split-pane-close"
                        onClick={() => setSplitPanes(prev => prev.filter(x => x !== paneId))}
                        title="Close pane"
                      >{'\u00D7'}</button>
                    </div>
                  ))}
                </div>
              )}
              {view === 'pipeline' && <PipelineBoard />}
              {view === 'agents' && <AgentsPage />}
              {view === 'usage' && <UsageReportPage />}
              {view === 'sessions' && <SessionsPage />}
              {view === 'skills' && <SkillsPage />}
              {view === 'activity' && <ActivityPage />}
              {!selectedInstanceId && view === 'chat' && (
                <div className="empty-chat-state">Pick an instance to start chattin'.</div>
              )}
            </>
          )}
          </Suspense>
        </main>
        {/* Last child of app-body so it pins to the right edge of the whole window,
            outside main-content, and every view keeps its full width minus 32px. */}
        {ultra && <CompactRail onExit={toggleUltra} />}
      </div>
      <VFXOverlay />
      <CommandMenu />
      <QuickTaskHotkey />
      <SecurityBanner />
      <ServerErrorBanner />
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <PipelineProvider>
        <AllTasksProvider>
          <ConfirmProvider>
            <AppContent />
          </ConfirmProvider>
        </AllTasksProvider>
      </PipelineProvider>
    </AppProvider>
  )
}
