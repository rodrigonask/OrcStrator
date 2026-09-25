import { useEffect } from 'react'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useInstances } from '../context/InstancesContext'
import { ChatHeader } from './ChatHeader'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { NativeTaskPanel } from './NativeTaskPanel'
import { TerminalPanel } from './TerminalPanel'

export function ChatView() {
  const { terminalPanelOpen, selectedInstanceId, historyErrors } = useUI()
  const { dispatch, ackSurface } = useAppDispatch()
  const { instances } = useInstances()
  const historyError = selectedInstanceId ? historyErrors[selectedInstanceId] : undefined

  // A chat open in this view has been looked at, whether it is the selected chat or a
  // split pane (PaneProvider overrides selectedInstanceId, so this covers both). Keyed on
  // surfacedAt as well, so a fire landing on the chat the user is reading right now clears the
  // moment it lands, the same way unread is suppressed for the selected chat.
  const surfacedAt = selectedInstanceId ? instances.find(i => i.id === selectedInstanceId)?.surfacedAt : undefined
  useEffect(() => {
    if (selectedInstanceId && surfacedAt != null) ackSurface(selectedInstanceId)
  }, [selectedInstanceId, surfacedAt, ackSurface])

  return (
    <div className="chat-view">
      <ChatHeader />
      {historyError && (
        <div className="chat-error-banner" role="alert">
          <span className="chat-error-banner-text">{historyError}</span>
          <button
            className="chat-error-banner-dismiss"
            onClick={() => selectedInstanceId && dispatch({ type: 'SET_HISTORY_ERROR', payload: { instanceId: selectedInstanceId, error: null } })}
            title="Dismiss"
          >
            {'×'}
          </button>
        </div>
      )}
      <div className="chat-body">
        <div className="chat-main">
          <MessageList />
          <NativeTaskPanel />
          <MessageInput />
        </div>
        {terminalPanelOpen && (
          <TerminalPanel onClose={() => dispatch({ type: 'SET_TERMINAL_OPEN', payload: false })} />
        )}
      </div>
    </div>
  )
}
