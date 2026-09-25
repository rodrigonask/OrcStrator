import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
// Loaded after styles.css so its .topbar-tab rules win on equal specificity.
import './styles/active-tab.css'
import './styles/all-kanban.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
