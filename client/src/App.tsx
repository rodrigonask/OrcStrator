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
