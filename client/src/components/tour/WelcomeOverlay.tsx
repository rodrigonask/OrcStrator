import { useCallback } from 'react'
import { useGame } from '../../context/GameContext'

export function WelcomeOverlay() {
  const { state, dispatch } = useGame()

  const handleGetStarted = useCallback(() => {
    dispatch({ type: 'COMPLETE_ONBOARDING' })
  }, [dispatch])

  if (state.tour.onboardingComplete) return null

  return (
    <div className="welcome-overlay">
      <div className="welcome-card">
        <div className="welcome-logo">Nasklaude</div>
        <div className="welcome-subtitle">
          Your multi-instance Claude orchestration platform.
          Manage projects, run agents, and build with AI.
        </div>

        <div className="welcome-features">
          <div className="welcome-feature">
            <div className="welcome-feature-icon">\uD83D\uDCAC</div>
            <div>
              <strong>Chat Interface</strong> - Talk to Claude instances in real-time
              with markdown rendering and tool call visibility
            </div>
          </div>
          <div className="welcome-feature">
            <div className="welcome-feature-icon">\uD83D\uDCC1</div>
            <div>
              <strong>Project Management</strong> - Organize your projects into folders
              with color coding and metadata
            </div>
          </div>
          <div className="welcome-feature">
            <div className="welcome-feature-icon">\uD83D\uDCCB</div>
            <div>
              <strong>Pipeline Board</strong> - Track tasks through your development
              pipeline from Backlog to Done
            </div>
          </div>
          <div className="welcome-feature">
            <div className="welcome-feature-icon">\uD83C\uDFAE</div>
            <div>
              <strong>Level System</strong> - Earn XP as you use the platform
              and unlock new features progressively
            </div>
          </div>
        </div>

        <button className="btn btn-primary" onClick={handleGetStarted} style={{ width: '100%', padding: '12px', fontSize: 15 }}>
          Get Started
        </button>
      </div>
    </div>
  )
}
