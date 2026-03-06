import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { ChatHeader } from './ChatHeader'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { TerminalPanel } from './TerminalPanel'

export function ChatView() {
  const { terminalPanelOpen } = useUI()
  const { dispatch } = useAppDispatch()

  return (
    <div className="chat-view">
      <ChatHeader />
      <div className="chat-body">
        <div className="chat-main">
          <MessageList />
          <MessageInput />
        </div>
        {terminalPanelOpen && (
          <TerminalPanel onClose={() => dispatch({ type: 'SET_TERMINAL_OPEN', payload: false })} />
        )}
      </div>
    </div>
  )
}
