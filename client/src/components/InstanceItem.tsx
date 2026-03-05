import { useState, useCallback } from 'react'
import type { InstanceConfig, ChatMessage } from '@shared/types'
import { useApp } from '../context/AppContext'
import { api } from '../api'

interface InstanceItemProps {
  instance: InstanceConfig
  folderOrchestratorActive?: boolean
}

const AGENT_ROLES = ['planner', 'builder', 'tester', 'promoter'] as const

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')        // fenced code blocks
    .replace(/`[^`]*`/g, (m) => m.slice(1, -1))  // inline code
    .replace(/!\[.*?\]\(.*?\)/g, '')       // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links
    .replace(/#{1,6}\s+/g, '')             // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1')    // bold **
    .replace(/__([^_]+)__/g, '$1')         // bold __
    .replace(/\*([^*]+)\*/g, '$1')         // italic *
    .replace(/_([^_]+)_/g, '$1')           // italic _
    .replace(/~~([^~]+)~~/g, '$1')         // strikethrough
    .replace(/^\s*[-*+]\s+/gm, '')         // unordered lists
    .replace(/^\s*\d+\.\s+/gm, '')         // ordered lists
    .replace(/>\s+/g, '')                  // blockquotes
    .replace(/\n+/g, ' ')                  // newlines → space
    .trim()
}

export function InstanceItem({ instance, folderOrchestratorActive }: InstanceItemProps) {
  const { state, dispatch, selectInstance, deleteInstance } = useApp()
  const isSelected = state.selectedInstanceId === instance.id
  const messages: ChatMessage[] = state.messages[instance.id] || []
  const lastMsg = messages[messages.length - 1]
  const unread = state.unreadCounts?.[instance.id] || 0

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const agentNames = state.settings.orchestratorAgentNames || { planner: 'Planner', builder: 'Builder', tester: 'Tester', promoter: 'Promoter' }

  const isOrchestratorLocked = instance.orchestratorManaged && folderOrchestratorActive

  let preview = ''
  if (lastMsg) {
    const textBlock = lastMsg.content.find(b => b.type === 'text')
    if (textBlock && textBlock.type === 'text') {
      preview = stripMarkdown(textBlock.text).slice(0, 80)
    }
  }

  const handleRoleChange = useCallback(async (role: string) => {
    if (isOrchestratorLocked) return
    const newRole = role === '' ? undefined : role
    try {
      await api.updateInstance(instance.id, { agentRole: newRole as InstanceConfig['agentRole'] })
      dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { agentRole: newRole as InstanceConfig['agentRole'] } } })
    } catch (err) {
      console.error('Failed to update role:', err)
    }
  }, [instance.id, isOrchestratorLocked, dispatch])

  const handleSpecSave = useCallback(async (value: string) => {
    if (value === (instance.specialization || '')) return
    try {
      await api.updateInstance(instance.id, { specialization: value || undefined })
      dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { specialization: value || undefined } } })
    } catch (err) {
      console.error('Failed to update specialization:', err)
    }
  }, [instance.id, instance.specialization, dispatch])

  const handleToggleManaged = useCallback(async () => {
    if (isOrchestratorLocked) return
    const newManaged = !instance.orchestratorManaged
    try {
      await api.updateInstance(instance.id, { orchestratorManaged: newManaged })
      dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { orchestratorManaged: newManaged } } })
    } catch (err) {
      console.error('Failed to update orchestratorManaged:', err)
    }
  }, [instance.id, instance.orchestratorManaged, isOrchestratorLocked, dispatch])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  return (
    <div
      className={`instance-item ${isSelected ? 'selected' : ''} ${instance.orchestratorManaged ? 'orchestrator-managed' : ''}`}
      onClick={() => {
        selectInstance(instance.id)
        if (state.view === 'pipeline') dispatch({ type: 'SET_VIEW', payload: 'chat' })
      }}
      onContextMenu={handleContextMenu}
    >
      <div className={`instance-state-dot ${instance.state}`} />
      <div className="instance-info">
        <div className="instance-name">
          {instance.name}
          {instance.orchestratorManaged && <span className="orchestrator-bot-icon" title="Orchestrator managed">⚡</span>}
        </div>

        {instance.agentRole && (
          <div className="instance-role-row">
            <span className={`role-pill role-${instance.agentRole} compact ${isOrchestratorLocked ? 'locked' : ''}`}>
              {isOrchestratorLocked ? '🔒 ' : ''}{agentNames[instance.agentRole]}
            </span>
            {instance.specialization && (
              <span className="spec-pill compact">{instance.specialization}</span>
            )}
          </div>
        )}

        {preview && <div className="instance-preview">{preview}</div>}
      </div>
      {unread > 0 && <span className="instance-badge">{unread}</span>}
      <button
        className="instance-close-btn"
        onClick={(e) => { e.stopPropagation(); deleteInstance(instance.id) }}
        title="Close session"
      >
        ×
      </button>

      {contextMenu && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 199 }}
            onClick={(e) => { e.stopPropagation(); setContextMenu(null) }}
          />
          <div
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={e => e.stopPropagation()}
          >
            {AGENT_ROLES.map(role => (
              <button
                key={role}
                className={`context-menu-item ${instance.agentRole === role ? 'active' : ''}`}
                onClick={() => { handleRoleChange(role); setContextMenu(null) }}
              >
                {agentNames[role]}
              </button>
            ))}
            {instance.agentRole && (
              <button className="context-menu-item" onClick={() => { handleRoleChange(''); setContextMenu(null) }}>
                Clear Role
              </button>
            )}
            <div className="context-menu-separator" />
            <button
              className="context-menu-item"
              onClick={() => {
                setContextMenu(null)
                const name = window.prompt('Rename session:', instance.name)
                if (name !== null && name.trim() && name.trim() !== instance.name) {
                  const trimmed = name.trim()
                  api.updateInstance(instance.id, { name: trimmed })
                    .then(() => dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { name: trimmed } } }))
                    .catch(err => console.error('Failed to rename session:', err))
                }
              }}
            >
              Rename...
            </button>
            <button
              className="context-menu-item"
              onClick={() => {
                setContextMenu(null)
                const spec = window.prompt('Specialization:', instance.specialization || '')
                if (spec !== null) handleSpecSave(spec.trim())
              }}
            >
              Set Specialization...
            </button>
            <div className="context-menu-separator" />
            {!isOrchestratorLocked && (
              <button
                className={`context-menu-item ${instance.orchestratorManaged ? '' : ''}`}
                onClick={() => { handleToggleManaged(); setContextMenu(null) }}
              >
                {instance.orchestratorManaged ? 'Remove from Orchestrator' : 'Feed to Orchestrator'}
              </button>
            )}
            <div className="context-menu-separator" />
            <button
              className="context-menu-item danger"
              onClick={() => { setContextMenu(null); deleteInstance(instance.id) }}
            >
              Close Session
            </button>
          </div>
        </>
      )}
    </div>
  )
}
