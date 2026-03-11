import { useUI } from '../context/UIContext'
import { DEFAULT_AGENT_NAMES } from '@shared/constants'

export function useAgentNames(): Record<string, string> {
  const { settings } = useUI()
  return settings.orchestratorAgentNames || DEFAULT_AGENT_NAMES
}
