import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import type { AccountProfile, TourState, XpEventType } from '@shared/types'
import { LEVELS, XP_TABLE } from '@shared/constants'

interface GameContextValue {
  profile: AccountProfile | null
  tour: TourState | null
  currentLevel: (typeof LEVELS)[number] | null
  nextLevel: (typeof LEVELS)[number] | null
  xpProgress: number // 0-1 progress toward next level
  addXp: (event: XpEventType, detail?: string) => Promise<void>
  completeStep: (stepId: string) => Promise<void>
  dismissHint: (hintId: string) => Promise<void>
  isStepCompleted: (stepId: string) => boolean
  isHintDismissed: (hintId: string) => boolean
  loading: boolean
}

const GameContext = createContext<GameContextValue | null>(null)

export function GameProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<AccountProfile | null>(null)
  const [tour, setTour] = useState<TourState | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    Promise.all([api.getProfile(), api.getTour()])
      .then(([profileData, tourData]) => {
        if (mounted) {
          setProfile(profileData)
          setTour(tourData)
        }
      })
      .catch((err) => {
        console.error('Failed to load game state:', err)
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })

    return () => {
      mounted = false
    }
  }, [])

  const currentLevel = profile
    ? [...LEVELS].reverse().find((l) => profile.totalXp >= l.xpRequired) || LEVELS[0]
    : null

  const nextLevel = currentLevel
    ? LEVELS.find((l) => l.level === currentLevel.level + 1) || null
    : null

  const xpProgress =
    currentLevel && nextLevel && profile
      ? (profile.totalXp - currentLevel.xpRequired) /
        (nextLevel.xpRequired - currentLevel.xpRequired)
      : currentLevel && !nextLevel
        ? 1
        : 0

  const addXp = useCallback(async (event: XpEventType, detail?: string) => {
    try {
      const updated = await api.addXp(event, detail)
      setProfile(updated)
    } catch (err) {
      console.error('Failed to add XP:', err)
    }
  }, [])

  const completeStep = useCallback(async (stepId: string) => {
    try {
      const updated = await api.completeStep(stepId)
      setTour(updated)
    } catch (err) {
      console.error('Failed to complete step:', err)
    }
  }, [])

  const dismissHint = useCallback(async (hintId: string) => {
    try {
      const updated = await api.dismissHint(hintId)
      setTour(updated)
    } catch (err) {
      console.error('Failed to dismiss hint:', err)
    }
  }, [])

  const isStepCompleted = useCallback(
    (stepId: string) => tour?.completedSteps.includes(stepId) ?? false,
    [tour]
  )

  const isHintDismissed = useCallback(
    (hintId: string) => tour?.dismissedHints.includes(hintId) ?? false,
    [tour]
  )

  const value: GameContextValue = {
    profile,
    tour,
    currentLevel,
    nextLevel,
    xpProgress,
    addXp,
    completeStep,
    dismissHint,
    isStepCompleted,
    isHintDismissed,
    loading,
  }

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext)
  if (!ctx) throw new Error('useGame must be used within a GameProvider')
  return ctx
}
