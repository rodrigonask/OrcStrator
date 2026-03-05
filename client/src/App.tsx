import { useEffect } from 'react'
import { AppProvider, useApp } from './context/AppContext'
import { GameProvider } from './context/GameContext'
import { PipelineProvider } from './context/PipelineContext'
import { Sidebar } from './components/Sidebar'
import { RightSidebar } from './components/RightSidebar'
import { ChatView } from './components/ChatView'
import { PipelineBoard } from './components/pipeline/PipelineBoard'
import { WelcomeOverlay } from './components/tour/WelcomeOverlay'
import { api } from './api'

function AppContent() {
  const { state } = useApp()
  useEffect(() => { api.connect() }, [])

  // Dynamic page title
  useEffect(() => {
    const instance = state.instances.find(i => i.id === state.selectedInstanceId)
    if (!instance) {
      document.title = 'NasKlaude'
      return
    }
    const folder = state.folders.find(f => f.id === instance.folderId)
    const parts: string[] = []
    if (folder) parts.push(folder.displayName || folder.name)
    if (instance.agentRole) parts.push(instance.agentRole.toUpperCase())
    parts.push(instance.name)
    const msgs = state.messages[instance.id]
    if (msgs?.length) {
      const last = msgs[msgs.length - 1]
      const textBlock = last.content.find(b => b.type === 'text')
      if (textBlock && textBlock.type === 'text') {
        const preview = textBlock.text.replace(/[#*_~`>\n]+/g, ' ').trim().slice(0, 40)
        if (preview) parts.push(preview)
      }
    }
    document.title = parts.join(' | ')
  }, [state.selectedInstanceId, state.instances, state.folders, state.messages])

  return (
    <div className="app" data-theme={state.settings.theme}>
      <Sidebar />
      <main className="main-content">
        {state.view === 'chat' && state.selectedInstanceId && <ChatView />}
        {state.view === 'pipeline' && <PipelineBoard />}
        {!state.selectedInstanceId && state.view === 'chat' && (
          <div className="empty-state">
            <h2>Welcome to NasKlaude</h2>
            <p>Select an instance or create a new project to get started</p>
          </div>
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
