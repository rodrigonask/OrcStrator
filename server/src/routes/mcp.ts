import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { db } from '../db.js'

export default async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.get('/mcp/available', async () => {
    const servers: Array<{ name: string; type: string; source: string; command?: string }> = []
    const seen = new Set<string>()

    function addServers(record: Record<string, unknown>, source: string): void {
      for (const [name, srv] of Object.entries(record)) {
        if (!seen.has(name)) {
          seen.add(name)
          const s = srv as Record<string, unknown>
          servers.push({
            name,
            type: (s.type as string) ?? 'stdio',
            source,
            command: s.command as string | undefined,
          })
        }
      }
    }

    // Source 1: ~/.claude.json (global + per-project overrides)
    const claudeJsonPath = path.join(os.homedir(), '.claude.json')
    if (fs.existsSync(claudeJsonPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as Record<string, unknown>
        addServers((config.mcpServers as Record<string, unknown>) ?? {}, 'global')
        for (const [cwd, proj] of Object.entries((config.projects as Record<string, unknown>) ?? {})) {
          const mcpSrvs = ((proj as Record<string, unknown>).mcpServers as Record<string, unknown>) ?? {}
          addServers(mcpSrvs, `project:${cwd}`)
        }
      } catch { /* malformed JSON — skip */ }
    }

    // Source 2: .mcp.json in known project directories
    try {
      const folderRows = db.prepare('SELECT path FROM folders').all() as Array<{ path: string }>
      for (const { path: dir } of folderRows) {
        const mcpJsonPath = path.join(dir, '.mcp.json')
        if (fs.existsSync(mcpJsonPath)) {
          try {
            const mcp = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')) as Record<string, unknown>
            addServers((mcp.mcpServers as Record<string, unknown>) ?? {}, `project:${dir}`)
          } catch { /* malformed — skip */ }
        }
      }
    } catch { /* db not ready */ }

    return { servers }
  })
}
