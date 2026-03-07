import { useState, useMemo } from 'react'
import { useGame } from '../../context/GameContext'
import { LEVELS } from '@shared/constants'
import { LevelDashboard } from './LevelDashboard'

export function LevelBar() {
  const { profile, currentLevel: lvl, xpProgress: progress } = useGame()
  const [showDashboard, setShowDashboard] = useState(false)

  const currentLevel = lvl || LEVELS[0]
  const xpProgress = (progress || 0) * 100

  return (
    <>
      <div className="level-bar" onClick={() => setShowDashboard(true)}>
        <div className="level-bar-header">
          <span className="level-number" style={{ fontFamily: 'var(--font-pixel)', fontSize: 10 }}>Lv.{currentLevel.level}</span>
          <span className="level-name" style={{ fontFamily: 'var(--font-pixel)', fontSize: 8 }}>{currentLevel.name}</span>
        </div>
        <div className="level-xp-bar-track xp-bar-track">
          <div
            className="level-xp-bar-fill xp-bar-fill"
            style={{ width: `${xpProgress}%` }}
          />
        </div>
      </div>

      {showDashboard && (
        <LevelDashboard onClose={() => setShowDashboard(false)} />
      )}
    </>
  )
}
