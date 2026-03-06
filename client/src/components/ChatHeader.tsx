import { useCallback, useMemo } from 'react'
import type { ChatMessage } from '@shared/types'
import { LEVELS } from '@shared/constants'
import { useUI } from '../context/UIContext'
import { useMessages } from '../context/MessagesContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'

export function ChatHeader() {
  const { selectedInstanceId: instanceId, terminalPanelOpen, settings } = useUI()
  const { messages: allMessages } = useMessages()
  const { instances, folders } = useInstances()
  const { dispatch } = useAppDispatch()
  const instance = instances.find(i => i.id === instanceId)
  const folder = instance ? folders.find(f => f.id === instance.folderId) : undefined
  const messages: ChatMessage[] = instanceId ? (allMessages[instanceId] || []) : []
  const agentNames = settings.orchestratorAgentNames || { planner: 'Planner', builder: 'Builder', tester: 'Tester', promoter: 'Promoter' }
  const isOrchestratorLocked = instance?.orchestratorManaged && folder?.orchestratorActive

  const totalTokens = useMemo(() => {
    let input = 0
    let output = 0
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'cost') {
          input += block.inputTokens
          output += block.outputTokens
        }
      }
    }
    return { input, output }
  }, [messages])

  const handlePause = useCallback(() => {
    if (instanceId) api.pauseInstance(instanceId)
  }, [instanceId])

  const handleResume = useCallback(() => {
    if (instanceId) api.resumeInstance(instanceId)
  }, [instanceId])

  const handleCopyLast = useCallback(() => {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistant) return
    const text = lastAssistant.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('\n')
    navigator.clipboard.writeText(text)
  }, [messages])

  const handleClear = useCallback(() => {
    if (instanceId && confirm('Clear chat history for this instance?')) {
      api.clearHistory(instanceId)
      dispatch({ type: 'CLEAR_MESSAGES', payload: instanceId })
    }
  }, [instanceId, dispatch])

  const instanceLevel = instance ? LEVELS.slice().reverse().find(l => (instance.xpTotal ?? 0) >= l.xpRequired) : undefined
  const tierColor: Record<string, string> = {
    Beginner: '#10b981', Intermediate: '#3b82f6', Advanced: '#8b5cf6',
    Elite: '#f59e0b', Mythic: '#ef4444', Cosmic: '#ec4899',
  }

  if (!instance) return null

  return (
    <div className="chat-header">
      <div className="chat-header-left">
        {instance.agentRole && (
          <span className={`role-pill role-${instance.agentRole} compact header-role-pill ${isOrchestratorLocked ? 'locked' : ''}`}>
            {isOrchestratorLocked ? '🔒 ' : ''}{agentNames[instance.agentRole]}
            {instance.specialization && <span className="role-spec-label">{instance.specialization}</span>}
          </span>
        )}
        {(instance.level ?? 1) > 1 && (
          <span className="chat-level-badge" style={{ color: tierColor[instanceLevel?.tier ?? 'Beginner'] ?? '#10b981' }}>
            Lv.{instance.level}
          </span>
        )}
        {instance.agentRole && <span className="chat-instance-name-sep"> | </span>}
        <span className="chat-instance-name">{instance.name}</span>
        <span className={`chat-state-badge ${instance.state}`}>
          {instance.state}
        </span>
      </div>
      <div className="chat-header-right">
        <span className="chat-token-count">
          {totalTokens.input.toLocaleString()}in / {totalTokens.output.toLocaleString()}out
        </span>
        {instance.state === 'running' && (
          <button className="chat-header-btn" onClick={handlePause}>
            Pause
          </button>
        )}
        {instance.state === 'paused' && (
          <button className="chat-header-btn primary" onClick={handleResume}>
            Resume
          </button>
        )}
        <button
          className={`chat-header-btn ${terminalPanelOpen ? 'active' : ''}`}
          onClick={() => dispatch({ type: 'TOGGLE_TERMINAL' })}
          title="Toggle terminal panel"
        >
          Terminal
        </button>
        <button className="chat-header-btn" onClick={handleCopyLast} title="Copy last response">
          Copy
        </button>
        <button className="chat-header-btn" onClick={handleClear} title="Clear history">
          Clear
        </button>
      </div>
    </div>
  )
}
