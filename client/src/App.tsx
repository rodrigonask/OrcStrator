import { useEffect } from 'react'
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
import { WelcomeOverlay } from './components/tour/WelcomeOverlay'
import { GameScreen } from './components/game'
import { api } from './api'

function AppContent() {
  const { instances, folders } = useInstances()
  const { messages } = useMessages()
  const { selectedInstanceId, view, settings } = useUI()
  useEffect(() => { api.connect() }, [])

  // Dynamic page title (note: AppProvider also sets title; this handles the App-level concern)
  useEffect(() => {
    const instance = instances.find(i => i.id === selectedInstanceId)
    if (!instance) {
      document.title = 'NasKlaude'
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
    <div className="app" data-theme={settings.theme}>
      <Sidebar />
      <main className="main-content">
        {view === 'chat' && selectedInstanceId && <ChatView />}
        {view === 'pipeline' && <PipelineBoard />}
        {!selectedInstanceId && view === 'chat' && <GameScreen />}
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
