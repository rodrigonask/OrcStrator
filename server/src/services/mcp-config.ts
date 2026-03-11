import { db } from '../db.js'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const AGENTS_DIR = path.resolve(__dirname, '../../agents')

const ROLE_MCP_DEFAULTS: Record<string, string[]> = {
  planner: [],
  builder: [],
  tester: [],
  promoter: [],
}

/** Build a temp MCP config file containing only the named servers from ~/.claude.json */
export function buildMcpConfigFile(serverNames: string[]): string | null {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json')
  if (!fs.existsSync(claudeJsonPath)) return null
  let config: Record<string, unknown>
  try { config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) } catch { return null }

  const all: Record<string, unknown> = { ...((config.mcpServers as Record<string, unknown>) ?? {}) }
  for (const proj of Object.values((config.projects as Record<string, unknown>) ?? {})) {
    Object.assign(all, (((proj as Record<string, unknown>).mcpServers as Record<string, unknown>) ?? {}))
  }

  const selected: Record<string, unknown> = {}
  for (const name of serverNames) {
    if (all[name]) selected[name] = all[name]
  }
  if (Object.keys(selected).length === 0) return null

  const tmpPath = path.join(os.tmpdir(), `orcstrator-mcp-${crypto.randomUUID()}.json`)
  fs.writeFileSync(tmpPath, JSON.stringify({ mcpServers: selected }), 'utf-8')
  return tmpPath
}

/** Resolve MCP config path for a role: settings -> defaults -> temp file -> tester fallback */
export function getMcpConfigPath(role: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'orchestratorMcpServers'").get() as { value: string } | undefined
  const roleMap: Record<string, string[]> = row
    ? JSON.parse(row.value) as Record<string, string[]>
    : ROLE_MCP_DEFAULTS
  const servers = roleMap[role] ?? ROLE_MCP_DEFAULTS[role] ?? []

  if (servers.length === 0) return 'none'

  const tmpPath = buildMcpConfigFile(servers)
  if (tmpPath) return tmpPath

  // Fallback for tester: use bundled mcp-tester.json if ~/.claude.json doesn't have the servers
  if (role === 'tester') {
    const mcpTesterPath = path.join(AGENTS_DIR, 'mcp-tester.json')
    if (fs.existsSync(mcpTesterPath)) return mcpTesterPath
  }
  return 'none'
}
