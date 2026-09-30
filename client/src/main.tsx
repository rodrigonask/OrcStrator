import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
// The three typefaces ship with the app instead of coming from Google on every launch, so the
// UI looks the same offline and makes no outside request at start. Only the weights
// the stylesheet uses.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import './styles.css'
// Loaded after styles.css so its .topbar-tab rules win on equal specificity.
import './styles/active-tab.css'
import './styles/all-kanban.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary variant="app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
