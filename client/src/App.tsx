import { useEffect, useState, useCallback, useMemo } from 'react'
import { useFontSize } from './hooks/useFontSize'
import { AppProvider } from './context/AppContext'
import { useInstances } from './context/InstancesContext'
import { useMessages } from './context/MessagesContext'
import { useUI } from './context/UIContext'
import { useAppDispatch } from './context/AppDispatchContext'
import { PipelineProvider } from './context/PipelineContext'
import { AllTasksProvider } from './context/AllTasksContext'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { GridView } from './components/grid/GridView'
import { PipelineBoard } from './components/pipeline/PipelineBoard'
import { SettingsPage } from './components/SettingsPage'
import { AgentsPage } from './components/AgentsPage'
import { UsageReportPage } from './components/UsageReportPage'
import { SessionsPage } from './components/SessionsPage'
import { SkillsPage } from './components/SkillsPage'
import { ActivityPage } from './components/ActivityPage'
import { VFXOverlay } from './components/VFXOverlay'
import { CommandMenu } from './components/CommandMenu'
import { QuickTaskHotkey } from './components/pipeline/QuickTaskHotkey'
import { TopBar } from './components/TopBar'
import { CompactRail } from './components/CompactRail'
import { SecurityBanner } from './components/SecurityBanner'
import { ConfirmProvider } from './components/ConfirmModal'
import { resolveAnimTier } from './hooks/useVFX'
import { useUltraCompact, useUltraCompactHotkey } from './hooks/useUltraCompact'
import { UIContext } from './context/UIContext'
import { api } from './api'

function PaneProvider({ instanceId, children }: { instanceId: string; children: React.ReactNode }) {
  const ui = useUI()
  const overridden = useMemo(() => ({ ...ui, selectedInstanceId: instanceId }), [ui, instanceId])
  return <UIContext.Provider value={overridden}>{children}</UIContext.Provider>
}

function AppContent() {
  const { instances, folders } = useInstances()
  const { messages } = useMessages()
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
    const instanceIds = new Set(instances.map(i => i.id))
    setSplitPanes(prev => prev.filter(id => instanceIds.has(id)))
  }, [instances])

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

  // Dynamic page title (note: AppProvider also sets title; this handles the App-level concern)
  useEffect(() => {
    const instance = instances.find(i => i.id === selectedInstanceId)
    if (!instance) {
      document.title = 'OrcStrator'
      return
    }
    const folder = folders.find(f => f.id === instance.folderId)
    const parts: string[] = []
    if (folder) parts.push(folder.displayName || folder.name)
    parts.push(instance.name)
    const msgs = messages[instance.id]
    if (msgs?.length) {
      const last = msgs[msgs.length - 1]
      const textBlock = last.content.find(b => b.type === 'text')
      if (textBlock && textBlock.type === 'text') {
        const preview = textBlock.text.replace(/[#*_~`>\n]+/g, ' ').trim().slice(0, 40)
        if (preview) parts.push(preview)
      }
    }
    document.title = parts.join(' | ')
  }, [selectedInstanceId, instances, folders, messages])

  return (
    <div className="app" data-theme={resolvedTheme} data-anim-tier={animTier} style={scaleStyle}>
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
        </main>
        {/* Last child of app-body so it pins to the right edge of the whole window,
            outside main-content, and every view keeps its full width minus 32px. */}
        {ultra && <CompactRail onExit={toggleUltra} />}
      </div>
      <VFXOverlay />
      <CommandMenu />
      <QuickTaskHotkey />
      <SecurityBanner />
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
