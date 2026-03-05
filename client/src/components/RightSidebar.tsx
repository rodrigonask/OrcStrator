import { useState } from 'react'
import { useApp } from '../context/AppContext'
import { useGame } from '../context/GameContext'

const TIER_COLORS: Record<string, string> = {
  Beginner: '#10b981',
  Intermediate: '#3b82f6',
  Advanced: '#8b5cf6',
  Elite: '#f59e0b',
  Mythic: '#ef4444',
  Cosmic: '#ec4899',
}

const TIER_ICONS: Record<string, string> = {
  Beginner: '🌱',
  Intermediate: '🔥',
  Advanced: '⚡',
  Elite: '👑',
  Mythic: '🏛',
  Cosmic: '🌌',
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const SHORTCUTS = [
  { keys: 'Ctrl+K', label: 'Command menu' },
  { keys: 'Ctrl+,', label: 'Settings' },
  { keys: 'Ctrl+Enter', label: 'Send message' },
  { keys: 'Ctrl+L', label: 'Clear chat' },
  { keys: 'Esc', label: 'Dismiss / cancel' },
]

export function RightSidebar() {
  const { state, dispatch } = useApp()
  const { profile, currentLevel, nextLevel, xpProgress } = useGame()
  const [collapsed, setCollapsed] = useState(false)

  const userName = (state.settings.userName as string | undefined) || 'Nask'
  const userEmoji = (state.settings.userEmoji as string | undefined) || '🧠'
  const tier = currentLevel?.tier ?? 'Beginner'
  const tierColor = TIER_COLORS[tier] ?? '#10b981'
  const tierIcon = TIER_ICONS[tier] ?? '🌱'

  const xpToNext = nextLevel && profile
    ? nextLevel.xpRequired - profile.totalXp
    : 0

  const activeAgents = state.instances.filter(i => i.state === 'running').length
  const totalProjects = state.folders.length

  const usage = state.usage
  const primaryBucket = usage?.buckets?.[0]
  const usagePercent = primaryBucket?.percentage ?? 0
  const usageBarClass = usagePercent >= 90 ? 'danger' : usagePercent >= 70 ? 'warning' : ''

  return (
    <aside className={`right-sidebar${collapsed ? ' rs-collapsed' : ''}`}>
      {/* Collapse toggle */}
      <button
        className="rs-collapse-btn"
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? 'Expand panel' : 'Collapse panel'}
      >
        {collapsed ? '◀' : '▶'}
      </button>

      {collapsed ? (
        <div className="rs-collapsed-avatar" title={userName}>{userEmoji}</div>
      ) : (
        <>
          {/* Identity card */}
          <div className="rs-section rs-identity">
            <div className="rs-avatar">{userEmoji}</div>
            <div className="rs-name">{userName}</div>
            <div className="rs-tier-badge" style={{ color: tierColor, borderColor: tierColor }}>
              {tierIcon} {tier}
            </div>
          </div>

          {/* Level + XP */}
          <div className="rs-section rs-level">
            <div className="rs-section-label">Level</div>
            <div className="rs-level-heading">
              <span className="rs-level-num" style={{ color: tierColor }}>
                Lv.{currentLevel?.level ?? 1}
              </span>
              <span className="rs-level-name">{currentLevel?.name ?? 'Novice'}</span>
            </div>
            <div className="rs-xp-bar-track">
              <div
                className="rs-xp-bar-fill"
                style={{ width: `${Math.min(xpProgress * 100, 100)}%`, background: tierColor }}
              />
            </div>
            <div className="rs-xp-label">
              {profile ? fmtNum(profile.totalXp) : '0'} XP
              {nextLevel && xpToNext > 0 && (
                <span className="rs-xp-next"> · {fmtNum(xpToNext)} to next</span>
              )}
            </div>
          </div>

          {/* RPG Stats grid */}
          <div className="rs-section">
            <div className="rs-section-label">Stats</div>
            <div className="rs-stats-grid">
              <div className="rs-stat-card">
                <div className="rs-stat-icon">💬</div>
                <div className="rs-stat-value">{fmtNum(profile?.messagesSent ?? 0)}</div>
                <div className="rs-stat-label">Messages</div>
              </div>
              <div className="rs-stat-card">
                <div className="rs-stat-icon">📤</div>
                <div className="rs-stat-value">{fmtNum(profile?.tokensSent ?? 0)}</div>
                <div className="rs-stat-label">Tokens In</div>
              </div>
              <div className="rs-stat-card">
                <div className="rs-stat-icon">📥</div>
                <div className="rs-stat-value">{fmtNum(profile?.tokensReceived ?? 0)}</div>
                <div className="rs-stat-label">Tokens Out</div>
              </div>
              <div className="rs-stat-card">
                <div className="rs-stat-icon">✨</div>
                <div className="rs-stat-value">{fmtNum(profile?.totalXp ?? 0)}</div>
                <div className="rs-stat-label">Total XP</div>
              </div>
              <div className="rs-stat-card">
                <div className="rs-stat-icon">🤖</div>
                <div className="rs-stat-value">{activeAgents}</div>
                <div className="rs-stat-label">Active</div>
              </div>
              <div className="rs-stat-card">
                <div className="rs-stat-icon">📁</div>
                <div className="rs-stat-value">{totalProjects}</div>
                <div className="rs-stat-label">Projects</div>
              </div>
            </div>
          </div>

          {/* Usage */}
          {usage && usage.buckets.length > 0 && (
            <div className="rs-section">
              <div className="rs-section-label">Usage</div>
              {usage.buckets.map((bucket, i) => {
                const pct = bucket.percentage ?? 0
                const cls = pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : ''
                return (
                  <div key={i} className="rs-usage-row">
                    <div className="rs-usage-labels">
                      <span className="rs-usage-name">{bucket.label}</span>
                      <span className={`rs-usage-pct ${cls}`}>{Math.round(pct)}%</span>
                    </div>
                    <div className="rs-usage-track">
                      <div
                        className={`rs-usage-fill ${cls}`}
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                    {bucket.resetCountdown && (
                      <div className="rs-usage-reset">Resets {bucket.resetCountdown}</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Shortcuts */}
          <div className="rs-section rs-shortcuts">
            <div className="rs-section-label">Shortcuts</div>
            <div className="rs-shortcut-list">
              {SHORTCUTS.map(({ keys, label }) => (
                <div key={keys} className="rs-shortcut-row">
                  <kbd className="rs-kbd">{keys}</kbd>
                  <span className="rs-shortcut-label">{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="rs-footer">
            <button
              className="rs-settings-btn"
              onClick={() => dispatch({ type: 'OPEN_SETTINGS' })}
              title="Settings"
            >
              ⚙ Settings
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
