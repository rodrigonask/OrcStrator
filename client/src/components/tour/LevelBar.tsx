import { useState, useMemo } from 'react'
import { useGame } from '../../context/GameContext'
import { LEVELS } from '@shared/constants'
import { LevelDashboard } from './LevelDashboard'

export function LevelBar() {
  const { state } = useGame()
  const [showDashboard, setShowDashboard] = useState(false)

  const { currentLevel, xpProgress, xpForNext } = useMemo(() => {
    const totalXp = state.profile.totalXp
    let currentLevel = LEVELS[0]
    let nextLevel = LEVELS[1]

    for (let i = LEVELS.length - 1; i >= 0; i--) {
      if (totalXp >= LEVELS[i].xpRequired) {
        currentLevel = LEVELS[i]
        nextLevel = LEVELS[i + 1] || null
        break
      }
    }

    const xpIntoLevel = totalXp - currentLevel.xpRequired
    const xpForNext = nextLevel ? nextLevel.xpRequired - currentLevel.xpRequired : 1
    const xpProgress = nextLevel ? Math.min((xpIntoLevel / xpForNext) * 100, 100) : 100

    return { currentLevel, xpProgress, xpForNext: xpForNext }
  }, [state.profile.totalXp])

  return (
    <>
      <div className="level-bar" onClick={() => setShowDashboard(true)}>
        <div className="level-bar-header">
          <span className="level-number">Lv.{currentLevel.level}</span>
          <span className="level-name">{currentLevel.name}</span>
        </div>
        <div className="level-xp-bar-track">
          <div
            className="level-xp-bar-fill"
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
