import { useUI } from '../context/UIContext'

export function ConnectionStatus() {
  const { connected } = useUI()

  return (
    <div className="connection-status">
      <div className={`connection-dot ${connected ? 'connected' : 'disconnected'}`} />
      {!connected && <span className="connection-text" style={{ fontFamily: 'var(--font-mono)', fontSize: 7 }}>Reconnecting...</span>}
    </div>
  )
}
