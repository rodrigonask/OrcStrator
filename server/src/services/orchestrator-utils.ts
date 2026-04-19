import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { DEFAULT_ROLE_MODELS, DEFAULT_ROLE_TOOLS, DEFAULT_ROLE_EFFORT, resolveModelId } from '@orcstrator/shared'
import type { OrcLogEntry } from '@orcstrator/shared'

// ── Orchestrator Event Ring Buffer ──
const ORC_LOG_MAX = 200
let orcLogSeq = 0
const orcLog: OrcLogEntry[] = []

export function emitOrcLog(entry: Omit<OrcLogEntry, 'id' | 'timestamp'>): void {
  const full: OrcLogEntry = { ...entry, id: ++orcLogSeq, timestamp: Date.now() }
  orcLog.push(full)
  if (orcLog.length > ORC_LOG_MAX) orcLog.shift()
  broadcastEvent({ type: 'orchestrator:log', payload: full })
}

export function getOrcLogs(filter?: { type?: string; limit?: number; after?: number }): OrcLogEntry[] {
  let result = [...orcLog]
  if (filter?.type) result = result.filter(e => e.type === filter.type)
  if (filter?.after) result = result.filter(e => e.id > filter.after!)
  if (filter?.limit) result = result.slice(-filter.limit)
  return result
}

export const serverStartTime = Date.now()

/** Model tiering: read from settings, fallback to defaults */
export function getRoleModels(): Record<string, string> {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'orchestratorModels'").get() as { value: string } | undefined
    if (row) {
      const models = JSON.parse(row.value) as Record<string, string>
      const result = { ...DEFAULT_ROLE_MODELS }
      for (const [role, model] of Object.entries(models)) {
        if (model && model !== 'default') result[role] = model
      }
      return result
    }
  } catch { /* use defaults */ }
  return DEFAULT_ROLE_MODELS
}

/** Tool scoping: read from settings, fallback to defaults */
export function getRoleTools(): Record<string, string> {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'orchestratorTools'").get() as { value: string } | undefined
    if (row) {
      const tools = JSON.parse(row.value) as Record<string, string[]>
      const result: Record<string, string> = {}
      for (const [role, toolList] of Object.entries(tools)) {
        if (toolList.length > 0) result[role] = toolList.join(',')
      }
      return result
    }
  } catch { /* use defaults */ }
  const result: Record<string, string> = {}
  for (const [role, tools] of Object.entries(DEFAULT_ROLE_TOOLS)) {
    result[role] = tools.join(',')
  }
  return result
}

/** Permission mode: read from settings, returns the appropriate CLI flag */
export function getPermissionFlag(): string {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'permissionMode'").get() as { value: string } | undefined
    if (row) {
      const mode = JSON.parse(row.value) as string
      if (mode === 'bypassPermissions') return '--dangerously-skip-permissions'
      if (mode === 'plan') return '--permission-mode=plan'
      if (mode === 'acceptEdits') return '--permission-mode=acceptEdits'
      if (mode === 'dontAsk') return '--permission-mode=dontAsk'
      if (mode === 'auto') return '--permission-mode=auto'
      if (mode === 'default') return '--permission-mode=default'
    }
  } catch { /* fallback */ }
  return '--dangerously-skip-permissions'
}

/** Effort levels: read from settings per-role, fallback to defaults */
export function getRoleEffort(): Record<string, string> {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'orchestratorEffort'").get() as { value: string } | undefined
    if (row) {
      const effort = JSON.parse(row.value) as Record<string, string>
      const result = { ...DEFAULT_ROLE_EFFORT }
      for (const [role, level] of Object.entries(effort)) {
        if (level) result[role] = level
      }
      return result
    }
  } catch { /* use defaults */ }
  return DEFAULT_ROLE_EFFORT
}
