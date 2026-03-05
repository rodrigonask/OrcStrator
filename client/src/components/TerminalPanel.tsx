import { useMemo } from 'react'
import { useApp } from '../context/AppContext'
import { useAutoScroll } from '../hooks/useAutoScroll'

interface BashEntry {
  key: string
  command: string
  output?: string
  isError?: boolean
  isRunning: boolean
}

function parseCommand(input: string): string {
  try {
    return JSON.parse(input).command ?? input
  } catch {
    return input
  }
}

export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const { state } = useApp()
  const instanceId = state.selectedInstanceId

  const historicalEntries = useMemo<BashEntry[]>(() => {
    if (!instanceId) return []
    const msgs = state.messages[instanceId] || []
    const toolResults = new Map<string, { output: string; isError?: boolean }>()
    for (const msg of msgs) {
      for (const block of msg.content) {
        if (block.type === 'tool-result') {
          toolResults.set(block.toolId, { output: block.output, isError: block.isError })
        }
      }
    }
    const entries: BashEntry[] = []
    for (const msg of msgs) {
      for (const block of msg.content) {
        if (block.type === 'tool-call' && block.toolName === 'Bash') {
          const result = toolResults.get(block.toolId)
          entries.push({
            key: block.toolId,
            command: parseCommand(block.input),
            output: result?.output,
            isError: result?.isError,
            isRunning: false,
          })
        }
      }
    }
    return entries
  }, [state.messages, instanceId])

  const liveEntries = useMemo<BashEntry[]>(() => {
    if (!instanceId) return []
    return (state.streamingToolCalls[instanceId] || [])
      .filter(tc => tc.toolName === 'Bash')
      .map(tc => ({
        key: tc.toolId,
        command: parseCommand(tc.input || ''),
        output: tc.output,
        isError: tc.isError,
        isRunning: tc.isRunning,
      }))
  }, [state.streamingToolCalls, instanceId])

  const entries = [...historicalEntries, ...liveEntries]
  const scrollRef = useAutoScroll([entries.length, liveEntries])

  return (
    <div className="terminal-panel">
      <div className="terminal-panel-header">
        <span className="terminal-panel-title">Terminal</span>
        <button className="terminal-panel-close" onClick={onClose} title="Close terminal">✕</button>
      </div>
      <div className="terminal-panel-body" ref={scrollRef}>
        {entries.length === 0 ? (
          <div className="terminal-panel-empty">No bash commands yet.</div>
        ) : (
          entries.map(entry => (
            <div key={entry.key} className="terminal-entry">
              <div className="terminal-prompt">
                <span className="terminal-dollar">$</span>
                <span className="terminal-cmd">{entry.command}</span>
              </div>
              {entry.output !== undefined && (
                <pre className={`terminal-output ${entry.isError ? 'error' : ''}`}>{entry.output}</pre>
              )}
              {entry.isRunning && entry.output === undefined && (
                <span className="terminal-cursor-blink" />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
