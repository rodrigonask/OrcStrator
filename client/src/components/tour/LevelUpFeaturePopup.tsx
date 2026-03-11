import { FEATURE_GATES, LEVELS } from '@shared/constants'

interface LevelUpFeaturePopupProps {
  level: number
  onClose: () => void
}

export function LevelUpFeaturePopup({ level, onClose }: LevelUpFeaturePopupProps) {
  const levelInfo = LEVELS.find(l => l.level === level)
  const unlockedFeatures = FEATURE_GATES.filter(g => g.level === level)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 440, textAlign: 'center' }}>
        <div className="modal-body" style={{ padding: '24px 20px' }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>{'\u2728'}</div>
          <div style={{ fontFamily: 'var(--font-pixel)', fontSize: 16, color: 'var(--accent)', marginBottom: 4 }}>
            Level Up!
          </div>
          <div style={{ fontFamily: 'var(--font-pixel)', fontSize: 12, color: 'var(--text-primary)', marginBottom: 16 }}>
            Lv.{level} — {levelInfo?.name ?? 'Unknown'}
          </div>

          {unlockedFeatures.length > 0 ? (
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontFamily: 'var(--font-pixel)', fontSize: 10, color: 'var(--text-primary)', marginBottom: 8 }}>
                New Feature{unlockedFeatures.length > 1 ? 's' : ''} Unlocked:
              </div>
              {unlockedFeatures.map(feat => (
                <div key={feat.key} style={{
                  padding: '10px 14px',
                  background: 'var(--bg-tertiary)',
                  borderRadius: 8,
                  marginBottom: 8,
                  borderLeft: '3px solid var(--accent)',
                }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                    {feat.title}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>
                    {feat.description}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                    {feat.concept}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Keep going! More features unlock at higher levels.
            </p>
          )}
        </div>
        <div className="modal-footer" style={{ justifyContent: 'center' }}>
          <button className="btn btn-primary" onClick={onClose}>
            {unlockedFeatures.length > 0 ? 'Try it now' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
