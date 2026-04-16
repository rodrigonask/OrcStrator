import { useEffect, useState, useCallback, useMemo } from 'react'
import { useFontSize } from './hooks/useFontSize'
import { AppProvider } from './context/AppContext'
import { useInstances } from './context/InstancesContext'
import { useMessages } from './context/MessagesContext'
import { useUI } from './context/UIContext'
import { useAppDispatch } from './context/AppDispatchContext'
import { GameProvider, useGame } from './context/GameContext'
import { PipelineProvider } from './context/PipelineContext'
import { Sidebar } from './components/Sidebar'
import { RightSidebar } from './components/RightSidebar'
import { ChatView } from './components/ChatView'
import { PipelineBoard } from './components/pipeline/PipelineBoard'
import { SettingsPage } from './components/SettingsPage'
import { WelcomeOverlay } from './components/tour/WelcomeOverlay'
import { GuidedTour } from './components/tour/GuidedTour'
import { LevelUpFeaturePopup } from './components/tour/LevelUpFeaturePopup'
import { GameScreen } from './components/game'
import { AgentsPage } from './components/AgentsPage'
import { UsageReportPage } from './components/UsageReportPage'
import { SessionsPage } from './components/SessionsPage'
import { VFXOverlay } from './components/VFXOverlay'
import { CommandMenu } from './components/CommandMenu'
import { ConfirmProvider } from './components/ConfirmModal'
import { resolveAnimTier } from './hooks/useVFX'
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
  const { profile } = useGame()
  const [levelUpPopup, setLevelUpPopup] = useState<number | null>(null)

  // Split view: array of instanceIds for extra panes (up to 3 more beyond selected)
  const [splitPanes, setSplitPanes] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('orcstrator.splitPanes') || '[]') } catch { return [] }
  })
  useEffect(() => {
    localStorage.setItem('orcstrator.splitPanes', JSON.stringify(splitPanes))
  }, [splitPanes])

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

  // Sync theme to <html> so portals outside .app inherit theme variables
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme)
  }, [resolvedTheme])

  // Sync animation tier to root elements for CSS gating
  useEffect(() => {
    document.documentElement.setAttribute('data-anim-tier', String(animTier))
  }, [animTier])

  // Listen for level-up events from WebSocket
  useEffect(() => {
    const unsub = api.onEvent('profile:level-up', (payload: { level: number }) => {
      setLevelUpPopup(payload.level)
    })
    return unsub
  }, [])
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
    if (instance.agentRole) parts.push(instance.agentRole.toUpperCase())
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
      <Sidebar />
      <main className="main-content" data-tour-id="tour-chat">
        {showSettings ? (
          <SettingsPage />
        ) : (
          <>
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
            {!selectedInstanceId && view === 'chat' && <GameScreen />}
          </>
        )}
      </main>
      <RightSidebar />
      <WelcomeOverlay />
      <GuidedTour />
      {levelUpPopup !== null && (
        <LevelUpFeaturePopup level={levelUpPopup} onClose={() => setLevelUpPopup(null)} />
      )}
      <VFXOverlay />
      <CommandMenu />
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <GameProvider>
        <PipelineProvider>
          <ConfirmProvider>
            <AppContent />
          </ConfirmProvider>
        </PipelineProvider>
      </GameProvider>
    </AppProvider>
  )
}
