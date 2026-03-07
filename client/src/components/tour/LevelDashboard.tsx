import { useMemo } from 'react'
import { useGame } from '../../context/GameContext'
import { LEVELS } from '@shared/constants'
import type { LevelTier } from '@shared/constants'

interface LevelDashboardProps {
  onClose: () => void
}

const TIER_COLORS: Record<LevelTier, string> = {
  Beginner: '#22c55e',
  Intermediate: '#3b82f6',
  Advanced: '#a855f7',
  Elite: '#f59e0b',
  Mythic: '#ef4444',
  Cosmic: '#ec4899',
}

const TIER_ICONS: Record<LevelTier, string> = {
  Beginner: '\uD83C\uDF31',
  Intermediate: '\uD83D\uDD25',
  Advanced: '\u26A1',
  Elite: '\uD83D\uDC51',
  Mythic: '\uD83C\uDFDB\uFE0F',
  Cosmic: '\uD83C\uDF0C',
}

const LEVEL_FEATURES: Record<number, string[]> = {
  1: ['Basic chat interface', 'Single instance'],
  2: ['Multiple folders', 'Command reference'],
  3: ['Context & memory tools', 'CLAUDE.md editor'],
  4: ['Plan mode', 'Workflow guide'],
  5: ['Multi-project workflow'],
  6: ['Agent creation', 'Agent assignment'],
  7: ['Agent levels', 'Agent detail panel'],
  8: ['Skill editor', 'Up to 4 agents'],
  9: ['Hook configuration', 'Automation rules'],
  10: ['MCP server browser', 'Unlimited agents'],
  11: ['Knowledge base editor'],
  12: ['Lesson editor', 'Guided learning paths'],
  13: ['Pipeline board', 'Task routing'],
  14: ['Headless mode', 'Idle auto-restart'],
  15: ['Agent Teams', 'Full platform access'],
  16: ['Dark Factory \u2014 4-agent autonomous pipeline'],
  17: ['Pipeline analytics', 'Task dependency chains'],
  18: ['Custom agent archetypes', 'Agent memory sharing'],
  19: ['Multi-project orchestration', 'Cross-project agents'],
  20: ['Public profile', 'Mentor badge', 'Leaderboard'],
  21: ['Self-healing pipelines', 'Auto-retry on failure'],
  22: ['Agent-to-agent delegation', 'Recursive task splitting'],
  23: ['Live dashboard \u2014 real-time pipeline telemetry'],
  24: ['Custom MCP server creation', 'Plugin SDK'],
  25: ['Swarm mode \u2014 parallel agent coordination'],
  26: ['Autonomous project bootstrap from spec'],
  27: ['Cross-repo knowledge synthesis'],
  28: ['Predictive task routing', 'AI cost optimizer'],
  29: ['Full API access', 'White-label agent deployment'],
  30: ['Singularity \u2014 self-improving agent network'],
}

export function LevelDashboard({ onClose }: LevelDashboardProps) {
  const { profile, currentLevel: lvl, nextLevel, xpProgress: progress } = useGame()

  const totalXp = profile?.totalXp ?? 0
  const currentLevel = lvl || LEVELS[0]
  const xpIntoLevel = totalXp - currentLevel.xpRequired
  const xpForNext = nextLevel ? nextLevel.xpRequired - currentLevel.xpRequired : 1
  const xpProgress = (progress || 0) * 100

  // Group levels by tier
  const tierGroups = useMemo(() => {
    const groups: { tier: LevelTier; levels: typeof LEVELS }[] = []
    let current = ''
    for (const def of LEVELS) {
      if (def.tier !== current) {
        current = def.tier
        groups.push({ tier: def.tier, levels: [] })
      }
      groups[groups.length - 1].levels.push(def)
    }
    return groups
  }, [])

  return (
    <div className="level-dashboard-overlay" onClick={onClose}>
      <div className="level-dashboard" onClick={e => e.stopPropagation()}>
        <div className="level-dashboard-hero">
          <div style={{ fontSize: 36 }}>{TIER_ICONS[currentLevel.tier] || '\uD83C\uDF31'}</div>
          <div className="level-dashboard-level" style={{ fontFamily: 'var(--font-pixel)', fontSize: 24 }}>{currentLevel.level}</div>
          <div className="level-dashboard-name" style={{ color: TIER_COLORS[currentLevel.tier], fontFamily: 'var(--font-pixel)', fontSize: 10 }}>
            {currentLevel.name}
          </div>
          <div className="level-dashboard-xp">
            <div className="level-dashboard-xp-text" style={{ fontFamily: 'var(--font-pixel)', fontSize: 7 }}>
              {totalXp.toLocaleString()} XP total
              {nextLevel && ` | ${xpIntoLevel} / ${xpForNext} to next level`}
            </div>
            <div className="level-dashboard-xp-bar xp-bar-track">
              <div
                className="level-dashboard-xp-fill xp-bar-fill"
                style={{ width: `${xpProgress}%` }}
              />
            </div>
          </div>
        </div>

        <div className="level-dashboard-features" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {tierGroups.map(group => {
            const tierColor = TIER_COLORS[group.tier]
            const tierIcon = TIER_ICONS[group.tier]
            const firstLevel = group.levels[0]?.level ?? 0
            const lastLevel = group.levels[group.levels.length - 1]?.level ?? 0
            const tierReached = totalXp >= group.levels[0].xpRequired

            return (
              <div key={group.tier} style={{ marginBottom: 16 }}>
                <div className="level-tier-header" style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 0', marginBottom: 4,
                  borderBottom: `2px solid ${tierReached ? tierColor : 'var(--border)'}`,
                  opacity: tierReached ? 1 : 0.4,
                }}>
                  <span>{tierIcon}</span>
                  <span style={{
                    fontFamily: 'var(--font-pixel)', fontSize: 8, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: 1, color: tierReached ? tierColor : 'var(--text-muted)',
                  }}>
                    {group.tier}
                  </span>
                  <span style={{ fontFamily: 'var(--font-pixel)', fontSize: 7, color: 'var(--text-muted)' }}>
                    Lv {firstLevel}-{lastLevel}
                  </span>
                </div>
                {group.levels.map(level => {
                  const unlocked = totalXp >= level.xpRequired
                  const isCurrent = currentLevel.level === level.level
                  const features = LEVEL_FEATURES[level.level] || []
                  return (
                    <div
                      key={level.level}
                      className={`level-feature-item ${unlocked ? 'unlocked' : 'locked'}`}
                      style={{
                        border: isCurrent ? `1px solid ${tierColor}` : '1px solid transparent',
                        borderRadius: 6,
                        padding: '6px 8px',
                        marginBottom: 2,
                      }}
                    >
                      <span style={{
                        width: 22, height: 22, borderRadius: '50%',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: 'var(--font-pixel)', fontSize: 7, fontWeight: 700, marginRight: 8,
                        background: unlocked ? tierColor : 'var(--bg-tertiary)',
                        color: unlocked ? '#fff' : 'var(--text-muted)',
                      }}>
                        {unlocked && level.level < currentLevel.level ? '\u2713' : level.level}
                      </span>
                      <span>
                        <strong style={{ fontFamily: 'var(--font-pixel)', fontSize: 7 }}>{level.name}</strong>
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginLeft: 6, fontSize: 10 }}>
                          {level.xpRequired.toLocaleString()} XP
                        </span>
                      </span>
                      {features.length > 0 && (
                        <div style={{ marginLeft: 30, marginTop: 4 }}>
                          {features.map(f => (
                            <div key={f} style={{ fontFamily: 'var(--font-pixel)', fontSize: 7, color: 'var(--text-secondary)', padding: '2px 0' }}>
                              {f}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>

        <div className="level-dashboard-footer">
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
