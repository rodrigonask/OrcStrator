import type { ReactElement } from 'react'
import { ToolCallBlock } from './ToolCallBlock'
import type { VerbosityLevel } from '@shared/types'

export interface NestedToolCallEntry {
  toolId: string
  toolName: string
  input: string
  output?: string
  isError?: boolean
  isRunning?: boolean
  parentToolUseId?: string
}

interface NestedToolCallsProps {
  calls: NestedToolCallEntry[]
  /** Optional results lookup (used by persisted ToolCallGroup where output lives in a separate map). */
  resolveResult?: (toolId: string) => { output?: string; isError?: boolean; isRunning?: boolean } | undefined
  defaultExpanded?: boolean
  verbosity?: VerbosityLevel
}

/**
 * Render a flat list of tool calls as a tree, nesting children whose `parentToolUseId`
 * matches a sibling's `toolId` under that parent. Children that reference a parent not
 * present in the list are rendered at the root level (so we never lose them).
 *
 * Depth ≥ 1 is rendered with a left-border indent (.tool-call-children); the renderer
 * recurses so chains (Task → Task → ...) also nest correctly.
 */
export function NestedToolCalls({ calls, resolveResult, defaultExpanded, verbosity }: NestedToolCallsProps) {
  const idSet = new Set(calls.map(c => c.toolId))
  const childrenByParent = new Map<string, NestedToolCallEntry[]>()
  const roots: NestedToolCallEntry[] = []
  for (const c of calls) {
    if (c.parentToolUseId && idSet.has(c.parentToolUseId)) {
      const arr = childrenByParent.get(c.parentToolUseId) ?? []
      arr.push(c)
      childrenByParent.set(c.parentToolUseId, arr)
    } else {
      roots.push(c)
    }
  }

  const renderNode = (tc: NestedToolCallEntry): ReactElement => {
    const result = resolveResult ? resolveResult(tc.toolId) : undefined
    const output = result?.output ?? tc.output
    const isError = result?.isError ?? tc.isError
    const isRunning = result?.isRunning ?? tc.isRunning ?? (resolveResult ? !result : false)
    const kids = childrenByParent.get(tc.toolId)
    return (
      <div key={tc.toolId} className="tool-call-node">
        <ToolCallBlock
          toolName={tc.toolName}
          toolId={tc.toolId}
          input={tc.input || '{}'}
          output={output}
          isError={isError}
          isRunning={isRunning}
          defaultExpanded={defaultExpanded}
          verbosity={verbosity}
        />
        {kids && kids.length > 0 && (
          <div className="tool-call-children">
            {kids.map(renderNode)}
          </div>
        )}
      </div>
    )
  }

  return <>{roots.map(renderNode)}</>
}
