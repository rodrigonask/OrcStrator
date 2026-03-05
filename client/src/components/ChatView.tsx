import { useApp } from '../context/AppContext'
import { ChatHeader } from './ChatHeader'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { TerminalPanel } from './TerminalPanel'

export function ChatView() {
  const { state, dispatch } = useApp()

  return (
    <div className="chat-view">
      <ChatHeader />
      <div className="chat-body">
        <div className="chat-main">
          <MessageList />
          <MessageInput />
        </div>
        {state.terminalPanelOpen && (
          <TerminalPanel onClose={() => dispatch({ type: 'SET_TERMINAL_OPEN', payload: false })} />
        )}
      </div>
    </div>
  )
}
