import { useUI } from '../context/UIContext'

export function ConnectionStatus() {
  const { connected } = useUI()

  return (
    <div className="connection-status">
      <div className={`connection-dot ${connected ? 'connected' : 'disconnected'}`} />
      {!connected && <span className="connection-text">Reconnecting...</span>}
    </div>
  )
}
