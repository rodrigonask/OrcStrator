import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useInstances } from '../context/InstancesContext'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { useFeatureGate } from '../hooks/useFeatureGate'
import { FeatureLockedModal } from './tour/FeatureLockedModal'
import { api } from '../api'
import { rest } from '../api/rest'
import type { ChatMessage } from '@shared/types'

interface Command {
  name: string
  description: string
  shortcut?: string
  category?: string
  action: () => void
}

export function CommandMenu() {
  const { folders, instances } = useInstances()
  const { selectedInstanceId } = useUI()
  const { dispatch } = useAppDispatch()
  const pipelineGate = useFeatureGate('pipeline')
  const multiProjectGate = useFeatureGate('multi-project')
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [
      // Navigation
      ...instances.map(inst => {
        const folder = folders.find(f => f.id === inst.folderId)
        return {
          name: inst.name,
          description: `${folder?.displayName || folder?.name || 'Unknown'} — ${inst.state}`,
          category: 'Chats',
          action: () => {
            dispatch({ type: 'SELECT_INSTANCE', payload: inst.id })
            dispatch({ type: 'SET_VIEW', payload: 'chat' })
          },
        }
      }),
      ...folders.map(f => ({
        name: f.displayName || f.name,
        description: f.path,
        category: 'Projects',
        action: () => {
          rest.openFolder(f.id).catch(console.error)
        },
      })),
      // Views
      { name: 'Pipeline', description: 'Open pipeline board', category: 'Views', action: () => { if (pipelineGate.check()) dispatch({ type: 'SET_VIEW', payload: 'pipeline' }) } },
      { name: 'Agents', description: 'Manage agent configs', category: 'Views', action: () => dispatch({ type: 'SET_VIEW', payload: 'agents' }) },
      { name: 'Sessions', description: 'View session history', category: 'Views', action: () => dispatch({ type: 'SET_VIEW', payload: 'sessions' }) },
      { name: 'Usage', description: 'Token usage & costs', category: 'Views', action: () => dispatch({ type: 'SET_VIEW', payload: 'usage' }) },
      { name: 'Settings', description: 'Application settings', category: 'Views', shortcut: '', action: () => dispatch({ type: 'OPEN_SETTINGS' }) },
      // Actions
      { name: 'New Chat', description: 'Create a new chat in the first folder', category: 'Actions', action: () => {
        const folderId = folders[0]?.id
        if (folderId) {
          api.createInstance({ folderId }).then(instance => {
            dispatch({ type: 'ADD_INSTANCE', payload: instance })
            dispatch({ type: 'SELECT_INSTANCE', payload: instance.id })
          }).catch(console.error)
        }
      }},
      { name: 'Add Project', description: 'Add an existing folder as a project', category: 'Actions', action: () => { if (multiProjectGate.check()) dispatch({ type: 'OPEN_FOLDER_BROWSER' }) } },
      { name: 'Pause All', description: 'Pause all running chats', category: 'Actions', action: () => instances.forEach(i => api.pauseInstance(i.id)) },
      { name: 'Resume All', description: 'Resume all paused chats', category: 'Actions', action: () => instances.forEach(i => api.resumeInstance(i.id)) },
      { name: 'Refresh Usage', description: 'Force refresh usage data', category: 'Actions', action: () => api.refreshUsage() },
    ]
    // CLI slash commands for selected instance — full registry
    if (selectedInstanceId) {
      const cli = (name: string, desc: string, category: string) => ({
        name, description: desc, category,
        action: () => {
          const userMsg: ChatMessage = {
            id: crypto.randomUUID(),
            instanceId: selectedInstanceId,
            role: 'user',
            content: [{ type: 'text', text: name }],
            createdAt: Date.now(),
          }
          dispatch({ type: 'ADD_MESSAGE', payload: userMsg })
          api.sendCommand(selectedInstanceId, name).then(res => {
            const assistantMsg: ChatMessage = {
              id: crypto.randomUUID(),
              instanceId: selectedInstanceId,
              role: 'assistant',
              content: [{ type: 'text', text: res.result }],
              createdAt: Date.now(),
            }
            dispatch({ type: 'ADD_MESSAGE', payload: assistantMsg })
            // Process client-side actions
            if (res.action === 'clear-history') {
              rest.clearHistory(selectedInstanceId)
              dispatch({ type: 'CLEAR_MESSAGES', payload: selectedInstanceId })
            }
            if (res.action === 'open-url' && res.url) window.open(res.url, '_blank')
            if (res.action === 'open-settings') dispatch({ type: 'OPEN_SETTINGS' })
            if (res.action === 'copy-to-clipboard' && res.value) navigator.clipboard.writeText(res.value)
            if (res.action === 'kill-process') rest.killInstance(selectedInstanceId)
            if (res.action === 'new-instance') {
              const inst = instances.find(i => i.id === selectedInstanceId)
              if (inst) {
                rest.createInstance({ folderId: inst.folderId }).then(newInst => {
                  dispatch({ type: 'ADD_INSTANCE', payload: newInst })
                  dispatch({ type: 'SELECT_INSTANCE', payload: newInst.id })
                })
              }
            }
          }).catch(() => {
            dispatch({ type: 'ADD_MESSAGE', payload: {
              id: crypto.randomUUID(), instanceId: selectedInstanceId, role: 'assistant',
              content: [{ type: 'text', text: 'Command failed.' }], createdAt: Date.now(),
            } as ChatMessage })
          })
        },
      })
      cmds.push(
        // Context & Cost
        cli('/compact', 'Compress conversation context', 'Context & Cost'),
        cli('/context', 'Show context window usage breakdown', 'Context & Cost'),
        cli('/cost', 'Show token usage & cost for session', 'Context & Cost'),
        cli('/usage', 'Show plan usage & rate limits', 'Context & Cost'),
        cli('/stats', 'Daily usage statistics', 'Context & Cost'),
        // Session
        cli('/clear', 'Clear conversation history', 'Session'),
        cli('/reset', 'Reset session (kill + clear)', 'Session'),
        cli('/new', 'Create new chat instance', 'Session'),
        cli('/rename', 'Rename this chat', 'Session'),
        cli('/branch', 'Fork session into new branch', 'Session'),
        cli('/exit', 'Kill process', 'Session'),
        // Model & Effort
        cli('/model', 'Change AI model', 'Model & Effort'),
        cli('/effort', 'Set effort level (low/medium/high/max)', 'Model & Effort'),
        cli('/fast', 'Toggle fast mode', 'Model & Effort'),
        // Code Review
        cli('/diff', 'Show uncommitted git changes', 'Code Review'),
        cli('/review', 'Code review current changes', 'Code Review'),
        cli('/simplify', 'Review changed code for quality & reuse', 'Code Review'),
        cli('/security-review', 'Analyze branch for security vulnerabilities', 'Code Review'),
        // Project & Memory
        cli('/memory', 'Show CLAUDE.md memory files', 'Project & Memory'),
        cli('/init', 'Initialize CLAUDE.md for project', 'Project & Memory'),
        cli('/add-dir', 'Add directory to context', 'Project & Memory'),
        // Planning
        cli('/plan', 'Toggle plan mode', 'Planning'),
        cli('/ultraplan', 'Enable ultra plan mode', 'Planning'),
        cli('/tasks', 'Show pipeline tasks', 'Planning'),
        cli('/bashes', 'Show running processes', 'Planning'),
        // Skills
        cli('/batch', 'Batch edit files', 'Skills'),
        cli('/debug', 'Debug current issue', 'Skills'),
        cli('/loop', 'Run a command on interval', 'Skills'),
        cli('/claude-api', 'Build with the Claude API', 'Skills'),
        cli('/schedule', 'Manage scheduled remote agents', 'Skills'),
        // Diagnostics
        cli('/status', 'Show version, auth & account info', 'Diagnostics'),
        cli('/doctor', 'Diagnose installation & settings', 'Diagnostics'),
        cli('/help', 'Show all available commands', 'Diagnostics'),
        cli('/release-notes', 'Show release notes', 'Diagnostics'),
        cli('/insights', 'Generate usage insights report', 'Diagnostics'),
        cli('/feedback', 'Submit feedback to Anthropic', 'Diagnostics'),
        cli('/bug', 'Report a bug', 'Diagnostics'),
        // Configuration
        cli('/config', 'Show Claude Code settings', 'Configuration'),
        cli('/settings', 'Open settings', 'Configuration'),
        cli('/permissions', 'Show permission rules', 'Configuration'),
        cli('/allowed-tools', 'Show allowed tools', 'Configuration'),
        cli('/hooks', 'Show configured hooks', 'Configuration'),
        cli('/skills', 'List available skills', 'Configuration'),
        cli('/mcp', 'List MCP server status', 'Configuration'),
        cli('/agents', 'List configured agents', 'Configuration'),
        cli('/plugin', 'Show installed plugins', 'Configuration'),
        // Clipboard & Export
        cli('/copy', 'Copy last assistant reply', 'Clipboard & Export'),
        cli('/export', 'Export session transcript', 'Clipboard & Export'),
        // Authentication
        cli('/upgrade', 'Show version & upgrade info', 'Authentication'),
        cli('/passes', 'Open billing & passes', 'Authentication'),
        cli('/extra-usage', 'Open usage management', 'Authentication'),
        // Integrations
        cli('/install-github-app', 'Install Claude GitHub App', 'Integrations'),
        cli('/install-slack-app', 'Install Claude Slack App', 'Integrations'),
        cli('/web-setup', 'Open Claude Code web interface', 'Integrations'),
        // Onboarding
        cli('/team-onboarding', 'Open team onboarding docs', 'Onboarding'),
        cli('/stickers', 'Get Claude stickers', 'Onboarding'),
        cli('/powerup', 'Upgrade plan & billing', 'Onboarding'),
      )
    }
    return cmds
  }, [folders, instances, selectedInstanceId, dispatch])

  const filtered = useMemo(() => {
    if (!filter) return commands
    const lower = filter.toLowerCase()
    return commands.filter(
      c => c.name.toLowerCase().includes(lower) || c.description.toLowerCase().includes(lower)
    )
  }, [commands, filter])

  // Global keyboard shortcut: Ctrl+K or Shift+Space
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(o => !o)
        return
      }
      if (e.shiftKey && e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const tag = (e.target as HTMLElement).tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        setOpen(o => !o)
      }
      if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open])

  // Focus input on open
  useEffect(() => {
    if (open) {
      setFilter('')
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  // Reset active index on filter change
  useEffect(() => {
    setActiveIndex(0)
  }, [filter])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[activeIndex]) {
        filtered[activeIndex].action()
        setOpen(false)
      }
    }
  }, [filtered, activeIndex])

  if (!open) return (
    <>
      {pipelineGate.showLockedModal && pipelineGate.gate && (
        <FeatureLockedModal gate={pipelineGate.gate} onClose={pipelineGate.dismissModal} />
      )}
      {multiProjectGate.showLockedModal && multiProjectGate.gate && (
        <FeatureLockedModal gate={multiProjectGate.gate} onClose={multiProjectGate.dismissModal} />
      )}
    </>
  )

  return (
    <>
      <div className="command-menu-overlay" onClick={() => setOpen(false)}>
        <div className="command-menu" onClick={e => e.stopPropagation()}>
          <input
            ref={inputRef}
            className="command-menu-input"
            placeholder="Search chats, projects, commands..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="command-menu-list">
            {(() => {
              let lastCategory = ''
              return filtered.map((cmd, i) => {
                const showCategory = cmd.category && cmd.category !== lastCategory
                lastCategory = cmd.category || ''
                return (
                  <div key={`${cmd.category}-${cmd.name}`}>
                    {showCategory && (
                      <div className="command-menu-category" style={{ fontFamily: 'var(--font-pixel)', fontSize: 8 }}>
                        {cmd.category}
                      </div>
                    )}
                    <div
                      className={`command-menu-item ${i === activeIndex ? 'active' : ''}`}
                      onClick={() => { cmd.action(); setOpen(false) }}
                      onMouseEnter={() => setActiveIndex(i)}
                    >
                      <div>
                        <div className="command-menu-item-name" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>{cmd.name}</div>
                        <div className="command-menu-item-desc" style={{ fontFamily: 'var(--font-mono)' }}>{cmd.description}</div>
                      </div>
                      {cmd.shortcut && (
                        <span className="command-menu-item-shortcut" style={{ fontFamily: 'var(--font-mono)', fontSize: 7 }}>{cmd.shortcut}</span>
                      )}
                    </div>
                  </div>
                )
              })
            })()}
            {filtered.length === 0 && (
              <div className="command-menu-item" style={{ cursor: 'default', opacity: 0.5 }}>
                <div className="command-menu-item-desc">No matches</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {pipelineGate.showLockedModal && pipelineGate.gate && (
        <FeatureLockedModal gate={pipelineGate.gate} onClose={pipelineGate.dismissModal} />
      )}
      {multiProjectGate.showLockedModal && multiProjectGate.gate && (
        <FeatureLockedModal gate={multiProjectGate.gate} onClose={multiProjectGate.dismissModal} />
      )}
    </>
  )
}
