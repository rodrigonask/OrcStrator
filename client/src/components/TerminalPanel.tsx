import { useMemo, useState, useEffect } from 'react'
import { useUI } from '../context/UIContext'
import { useMessages } from '../context/MessagesContext'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { api } from '../api'

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
  const { selectedInstanceId: instanceId } = useUI()
  const { messages: allMessages, streamingToolCalls, rawOutput } = useMessages()
  const [tab, setTab] = useState<'bash' | 'stream'>('stream')

  useEffect(() => {
    if (!instanceId) return
    api.subscribeTerminal(instanceId)
    return () => { api.unsubscribeTerminal(instanceId) }
  }, [instanceId])

  const historicalEntries = useMemo<BashEntry[]>(() => {
    if (!instanceId) return []
    const msgs = allMessages[instanceId] || []
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
  }, [allMessages, instanceId])

  const liveEntries = useMemo<BashEntry[]>(() => {
    if (!instanceId) return []
    return (streamingToolCalls[instanceId] || [])
      .filter(tc => tc.toolName === 'Bash')
      .map(tc => ({
        key: tc.toolId,
        command: parseCommand(tc.input || ''),
        output: tc.output,
        isError: tc.isError,
        isRunning: tc.isRunning,
      }))
  }, [streamingToolCalls, instanceId])

  const entries = [...historicalEntries, ...liveEntries]
  const rawLines = instanceId ? (rawOutput[instanceId] || []) : []

  const bashScrollRef = useAutoScroll([entries.length, liveEntries])
  const streamScrollRef = useAutoScroll([rawLines.length])

  return (
    <div className="terminal-panel">
      <div className="terminal-panel-header">
        <span className="terminal-panel-title">Terminal</span>
        <div className="terminal-tabs">
          <button
            className={`terminal-tab ${tab === 'bash' ? 'active' : ''}`}
            onClick={() => setTab('bash')}
          >Bash</button>
          <button
            className={`terminal-tab ${tab === 'stream' ? 'active' : ''}`}
            onClick={() => setTab('stream')}
          >Stream</button>
        </div>
        <button className="terminal-panel-close" onClick={onClose} title="Close terminal">✕</button>
      </div>

      {tab === 'bash' ? (
        <div className="terminal-panel-body" ref={bashScrollRef}>
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
      ) : (
        <div className="terminal-stream-body" ref={streamScrollRef}>
          {rawLines.length === 0 ? (
            <div className="terminal-panel-empty">No stream output yet.</div>
          ) : (
            rawLines.map((entry, i) => (
              <div key={i} className={`terminal-stream-line${entry.isStderr ? ' stderr' : ''}`}>{entry.line}</div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
