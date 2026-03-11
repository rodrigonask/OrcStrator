import { useGame } from '../context/GameContext'
import { FEATURE_GATES, type FeatureGate } from '@shared/constants'
import { useState, useCallback } from 'react'

export function useFeatureGate(featureKey: string): {
  unlocked: boolean
  gate: FeatureGate | undefined
  check: () => boolean
  showLockedModal: boolean
  dismissModal: () => void
} {
  const { tour, currentLevel } = useGame()
  const [showLockedModal, setShowLockedModal] = useState(false)

  const gate = FEATURE_GATES.find(g => g.key === featureKey)
  const level = currentLevel?.level ?? 1

  // God mode or no guided mode set → everything unlocked
  const isGodMode = !tour?.guidedMode || tour.guidedMode === 'god'
  const unlocked = isGodMode || !gate || level >= gate.level

  const check = useCallback(() => {
    if (unlocked) return true
    setShowLockedModal(true)
    return false
  }, [unlocked])

  const dismissModal = useCallback(() => {
    setShowLockedModal(false)
  }, [])

  return { unlocked, gate, check, showLockedModal, dismissModal }
}
