// Convenience hook: emit VFX events, check tier gates

import { useUI } from '../context/UIContext'
import { vfxBus, type VFXEventType, type VFXEvent } from '../systems/vfx-bus'
import { useCallback } from 'react'

export function useVFX() {
  const { settings } = useUI()
  const animTier = settings.animationTier ?? (settings.animationsEnabled === false ? 0 : 0)
  const soundTier = settings.soundTier ?? (settings.soundsEnabled === false ? 0 : 0)

  const emit = useCallback((type: VFXEventType, opts?: Partial<Omit<VFXEvent, 'type'>>) => {
    vfxBus.fire(type, opts)
  }, [])

  return { animTier, soundTier, emit }
}

/** Resolve animation tier from settings (works outside React) */
export function resolveAnimTier(settings: { animationTier?: number; animationsEnabled?: boolean }): number {
  if (settings.animationTier != null) return settings.animationTier
  return settings.animationsEnabled === false ? 0 : 0
}

/** Resolve sound tier from settings (works outside React) */
export function resolveSoundTier(settings: { soundTier?: number; soundsEnabled?: boolean }): number {
  if (settings.soundTier != null) return settings.soundTier
  return settings.soundsEnabled === false ? 0 : 0
}
