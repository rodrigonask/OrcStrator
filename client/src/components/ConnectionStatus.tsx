import { useApp } from '../context/AppContext'

export function ConnectionStatus() {
  const { state } = useApp()
  const connected = state.connected

  return (
    <div className="connection-status">
      <div className={`connection-dot ${connected ? 'connected' : 'disconnected'}`} />
      {!connected && <span className="connection-text">Reconnecting...</span>}
    </div>
  )
}
