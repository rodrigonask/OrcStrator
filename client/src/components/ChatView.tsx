import { ChatHeader } from './ChatHeader'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'

export function ChatView() {
  return (
    <div className="chat-view">
      <ChatHeader />
      <MessageList />
      <MessageInput />
    </div>
  )
}
