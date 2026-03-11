import type { FeatureGate } from '@shared/constants'
import { useGame } from '../../context/GameContext'
import { useAppDispatch } from '../../context/AppDispatchContext'

interface FeatureLockedModalProps {
  gate: FeatureGate
  onClose: () => void
}

export function FeatureLockedModal({ gate, onClose }: FeatureLockedModalProps) {
  const { profile, currentLevel } = useGame()
  const { dispatch } = useAppDispatch()
  const currentXp = profile?.totalXp ?? 0
  const currentLv = currentLevel?.level ?? 1

  // Find the level entry for the gate
  const targetXp = gate.level // This is the level number, not XP

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 20 }}>{'\uD83D\uDD12'}</span>
            {gate.title}
          </span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, marginBottom: 12 }}>{gate.description}</p>
          <div style={{
            padding: '10px 14px',
            background: 'var(--bg-tertiary)',
            borderRadius: 8,
            fontSize: 12,
            color: 'var(--text-secondary)',
            marginBottom: 12,
            borderLeft: '3px solid var(--accent)',
          }}>
            <strong style={{ color: 'var(--text-primary)' }}>Claude Concept:</strong>{' '}
            {gate.concept}
          </div>
          <div style={{
            fontFamily: 'var(--font-pixel)',
            fontSize: 9,
            color: 'var(--accent)',
            textAlign: 'center',
            padding: '8px 0',
          }}>
            Reach Lv.{gate.level} to unlock (currently Lv.{currentLv})
          </div>
          <button
            className="btn"
            style={{ width: '100%', fontSize: 11, marginTop: 8, opacity: 0.7 }}
            onClick={() => {
              onClose()
              dispatch({ type: 'OPEN_SETTINGS' })
            }}
          >
            Or switch to God Mode in Settings
          </button>
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  )
}
