import type { VerbosityLevel } from '@shared/types'
import { useUI } from '../context/UIContext'

export function useVerbosity(instanceId: string | null): VerbosityLevel {
  const { verbosityOverrides, settings } = useUI()
  if (instanceId && verbosityOverrides[instanceId]) {
    return verbosityOverrides[instanceId]
  }
  return settings.verbosity ?? 3
}
