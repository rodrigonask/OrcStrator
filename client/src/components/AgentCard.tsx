import type { AgentConfig } from '@shared/types'
import { PersonalityEditor, personalitySummary } from './PersonalityEditor'
import { api } from '../api'
import { useAppDispatch } from '../context/AppDispatchContext'

interface Props {
  agent: AgentConfig
  onRefresh: () => void
}

export function AgentCard({ agent, onRefresh }: Props) {
  const { dispatch } = useAppDispatch()
  const summary = personalitySummary(agent.personality)

  const handleEdit = async () => {
    try {
      const result = await api.createAgentEditSession(agent.id)
      dispatch({ type: 'SELECT_INSTANCE', payload: result.instanceId })
      dispatch({ type: 'SET_VIEW', payload: 'chat' })
    } catch (err) {
      console.error('Failed to create edit session:', err)
    }
  }

  const handleSavePersonality = async (personality: NonNullable<AgentConfig['personality']>) => {
    try {
      await api.updateAgent(agent.id, { personality })
      onRefresh()
    } catch (err) {
      console.error('Failed to save personality:', err)
    }
  }

  return (
    <div className="agent-card">
      <div className="agent-card-header">
        <div className="agent-card-info">
          <span className="agent-card-name font-pixel">{agent.name}</span>
          <div className="agent-card-meta">
            <span className={`agent-source-badge ${agent.source === 'native' ? 'native' : 'user'}`}>
              {agent.source === 'native' ? 'Native' : 'User'}
            </span>
            <span className="agent-level-badge font-mono">Lv.{agent.level}</span>
          </div>
        </div>
        <button className="agent-edit-btn" onClick={handleEdit} title="Edit with interview">
          ✎
        </button>
      </div>

      {summary && (
        <div className="agent-card-personality-summary font-mono">{summary}</div>
      )}

      {agent.content && (
        <div className="agent-card-content font-mono">
          {agent.content.slice(0, 120)}{agent.content.length > 120 ? '…' : ''}
        </div>
      )}

      <PersonalityEditor
        personality={agent.personality}
        onSave={handleSavePersonality}
      />
    </div>
  )
}
