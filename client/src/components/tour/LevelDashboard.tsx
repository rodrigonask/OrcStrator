import { useMemo } from 'react'
import { useGame } from '../../context/GameContext'
import { LEVELS } from '@shared/constants'

interface LevelDashboardProps {
  onClose: () => void
}

const LEVEL_FEATURES: Record<number, string[]> = {
  1: ['Basic chat interface', 'Single instance management'],
  2: ['Folder organization', 'Usage monitoring'],
  3: ['Pipeline board', 'Task management'],
  4: ['Agent creation', 'Custom prompts'],
  5: ['Skill library', 'Advanced configurations'],
  6: ['MCP server connections', 'Multi-agent orchestration'],
  7: ['Full orchestrator mode', 'All features unlocked'],
}

export function LevelDashboard({ onClose }: LevelDashboardProps) {
  const { state } = useGame()

  const { currentLevel, nextLevel, xpIntoLevel, xpForNext, xpProgress } = useMemo(() => {
    const totalXp = state.profile.totalXp
    let current = LEVELS[0]
    let next = LEVELS[1] || null

    for (let i = LEVELS.length - 1; i >= 0; i--) {
      if (totalXp >= LEVELS[i].xpRequired) {
        current = LEVELS[i]
        next = LEVELS[i + 1] || null
        break
      }
    }

    const xpIntoLevel = totalXp - current.xpRequired
    const xpForNext = next ? next.xpRequired - current.xpRequired : 1
    const xpProgress = next ? Math.min((xpIntoLevel / xpForNext) * 100, 100) : 100

    return { currentLevel: current, nextLevel: next, xpIntoLevel, xpForNext, xpProgress }
  }, [state.profile.totalXp])

  return (
    <div className="level-dashboard-overlay" onClick={onClose}>
      <div className="level-dashboard" onClick={e => e.stopPropagation()}>
        <div className="level-dashboard-hero">
          <div className="level-dashboard-level">{currentLevel.level}</div>
          <div className="level-dashboard-name">{currentLevel.name}</div>
          <div className="level-dashboard-xp">
            <div className="level-dashboard-xp-text">
              {state.profile.totalXp.toLocaleString()} XP total
              {nextLevel && ` | ${xpIntoLevel} / ${xpForNext} to next level`}
            </div>
            <div className="level-dashboard-xp-bar">
              <div
                className="level-dashboard-xp-fill"
                style={{ width: `${xpProgress}%` }}
              />
            </div>
          </div>
        </div>

        <div className="level-dashboard-features">
          <div className="level-dashboard-features-title">Features by Level</div>
          {LEVELS.map(level => {
            const unlocked = state.profile.totalXp >= level.xpRequired
            const features = LEVEL_FEATURES[level.level] || []
            return features.map((feature, i) => (
              <div
                key={`${level.level}-${i}`}
                className={`level-feature-item ${unlocked ? 'unlocked' : 'locked'}`}
              >
                <span className="level-feature-icon">
                  {unlocked ? '\u2705' : '\u{1F512}'}
                </span>
                <span>
                  <strong>Lv.{level.level}</strong> {feature}
                </span>
              </div>
            ))
          })}
        </div>

        <div className="level-dashboard-footer">
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
