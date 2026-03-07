import { useEffect } from 'react'
import { useFontSize } from './hooks/useFontSize'
import { AppProvider } from './context/AppContext'
import { useInstances } from './context/InstancesContext'
import { useMessages } from './context/MessagesContext'
import { useUI } from './context/UIContext'
import { GameProvider } from './context/GameContext'
import { PipelineProvider } from './context/PipelineContext'
import { Sidebar } from './components/Sidebar'
import { RightSidebar } from './components/RightSidebar'
import { ChatView } from './components/ChatView'
import { PipelineBoard } from './components/pipeline/PipelineBoard'
import { SettingsPage } from './components/SettingsPage'
import { WelcomeOverlay } from './components/tour/WelcomeOverlay'
import { GameScreen } from './components/game'
import { MonitorView } from './components/MonitorView'
import { api } from './api'

function AppContent() {
  const { instances, folders } = useInstances()
  const { messages } = useMessages()
  const { selectedInstanceId, view, settings, showSettings } = useUI()
  const { zoom } = useFontSize()
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
      document.title = 'Orcstrator'
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
    <div className="app" data-theme={settings.theme} style={scaleStyle}>
      <Sidebar />
      <main className="main-content">
        {showSettings ? (
          <SettingsPage />
        ) : (
          <>
            {view === 'chat' && selectedInstanceId && <ChatView />}
            {view === 'pipeline' && <PipelineBoard />}
            {view === 'monitor' && <MonitorView />}
            {!selectedInstanceId && view === 'chat' && <GameScreen />}
          </>
        )}
      </main>
      <RightSidebar />
      <WelcomeOverlay />
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
