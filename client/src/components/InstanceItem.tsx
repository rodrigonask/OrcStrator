import type { InstanceConfig, ChatMessage } from '@shared/types'
import { useApp } from '../context/AppContext'

interface InstanceItemProps {
  instance: InstanceConfig
  index?: number
  total?: number
}

export function InstanceItem({ instance, index, total }: InstanceItemProps) {
  const { state, selectInstance } = useApp()
  const isSelected = state.selectedInstanceId === instance.id
  const messages: ChatMessage[] = state.messages[instance.id] || []
  const lastMsg = messages[messages.length - 1]
  const unread = state.unreadCounts?.[instance.id] || 0

  let preview = ''
  if (lastMsg) {
    const textBlock = lastMsg.content.find(b => b.type === 'text')
    if (textBlock && textBlock.type === 'text') {
      preview = textBlock.text.slice(0, 60)
    }
  }

  return (
    <div
      className={`instance-item ${isSelected ? 'selected' : ''}`}
      onClick={() => selectInstance(instance.id)}
    >
      <div className={`instance-state-dot ${instance.state}`} />
      <div className="instance-info">
        <div className="instance-name">{(total && total > 1) ? `${instance.name} #${index}` : instance.name}</div>
        {preview && <div className="instance-preview">{preview}</div>}
      </div>
      {unread > 0 && <span className="instance-badge">{unread}</span>}
    </div>
  )
}
