import { useEffect, useState, useCallback } from 'react'
import { useFontSize } from './hooks/useFontSize'
import { AppProvider } from './context/AppContext'
import { useInstances } from './context/InstancesContext'
import { useMessages } from './context/MessagesContext'
import { useUI } from './context/UIContext'
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
import { api } from './api'

function AppContent() {
  const { instances, folders } = useInstances()
  const { messages } = useMessages()
  const { selectedInstanceId, view, settings, showSettings } = useUI()
  const { zoom } = useFontSize()
  const { profile } = useGame()
  const [levelUpPopup, setLevelUpPopup] = useState<number | null>(null)

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

  // Sync theme to <html> so portals outside .app inherit theme variables
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme)
  }, [resolvedTheme])

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
    document.title = 'OrcStrator: ' + parts.join(' | ')
  }, [selectedInstanceId, instances, folders, messages])

  return (
    <div className="app" data-theme={resolvedTheme} style={scaleStyle}>
      <Sidebar />
      <main className="main-content" data-tour-id="tour-chat">
        {showSettings ? (
          <SettingsPage />
        ) : (
          <>
            {view === 'chat' && selectedInstanceId && <ChatView />}
            {view === 'pipeline' && <PipelineBoard />}
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
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <GameProvider>
        <PipelineProvider>
          <AppContent />
        </PipelineProvider>
      </GameProvider>
    </AppProvider>
  )
}
