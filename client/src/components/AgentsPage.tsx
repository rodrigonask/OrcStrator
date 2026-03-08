import { useAgents } from '../hooks/useAgents'
import { AgentCard } from './AgentCard'
import { api } from '../api'

export function AgentsPage() {
  const { agents, loading, refresh } = useAgents()

  const handleCreateAgent = async () => {
    try {
      await api.createAgent({ name: 'New Agent', content: '', level: 0 })
      refresh()
    } catch (err) {
      console.error('Failed to create agent:', err)
    }
  }

  return (
    <div className="agents-page">
      <div className="agents-banner">
        <div className="agents-banner-icon">🧠</div>
        <div className="agents-banner-text">
          <h2 className="font-pixel" style={{ fontSize: '14px', margin: 0 }}>Agent Library</h2>
          <p className="font-mono" style={{ fontSize: '11px', margin: '4px 0 0', opacity: 0.8 }}>
            Agents are personalities doing roles. Each brings its own mindset — how it asks questions,
            what it prioritizes, how much it double-checks. Personality is the hidden variable that determines quality.
          </p>
        </div>
      </div>

      <div className="agents-toolbar">
        <button className="agents-create-btn" onClick={handleCreateAgent}>
          <span className="font-mono" style={{ fontSize: '11px' }}>+ New Agent</span>
        </button>
      </div>

      {loading ? (
        <div className="agents-loading font-mono">Loading agents…</div>
      ) : agents.length === 0 ? (
        <div className="agents-empty font-mono">No agents yet. Create one or sync native agents.</div>
      ) : (
        <div className="agents-grid">
          {agents.map(agent => (
            <AgentCard key={agent.id} agent={agent} onRefresh={refresh} />
          ))}
        </div>
      )}
    </div>
  )
}
