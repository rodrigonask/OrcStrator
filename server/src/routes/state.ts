import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { getClientCount } from '../ws/handler.js'
import { getActiveProcessCount } from '../services/claude-process.js'
import type { FolderConfig, InstanceConfig, AppSettings } from '@nasklaude/shared'

const startTime = Date.now()

export default async function stateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/state', async () => {
    const folderRows = db.prepare('SELECT * FROM folders ORDER BY sort_order ASC').all() as Record<string, unknown>[]
    const instanceRows = db.prepare('SELECT * FROM instances ORDER BY sort_order ASC').all() as Record<string, unknown>[]
    const settingRows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>

    const folders: FolderConfig[] = folderRows.map(r => ({
      id: r.id as string,
      path: r.path as string,
      name: r.name as string,
      displayName: r.display_name as string | undefined,
      emoji: r.emoji as string | undefined,
      client: r.client as string | undefined,
      projectType: r.project_type as FolderConfig['projectType'],
      color: r.color as string | undefined,
      status: (r.status as FolderConfig['status']) || 'active',
      repoUrl: r.repo_url as string | undefined,
      notes: r.notes as string | undefined,
      expanded: Boolean(r.expanded),
      sortOrder: r.sort_order as number,
      createdAt: r.created_at as number
    }))

    const instances: InstanceConfig[] = instanceRows.map(r => ({
      id: r.id as string,
      folderId: r.folder_id as string,
      name: r.name as string,
      cwd: r.cwd as string,
      sessionId: r.session_id as string | undefined,
      state: (r.state as InstanceConfig['state']) || 'idle',
      agentId: r.agent_id as string | undefined,
      idleRestartMinutes: r.idle_restart_minutes as number,
      sortOrder: r.sort_order as number,
      createdAt: r.created_at as number
    }))

    const settings: Record<string, unknown> = {}
    for (const row of settingRows) {
      try {
        settings[row.key] = JSON.parse(row.value)
      } catch {
        settings[row.key] = row.value
      }
    }

    return { folders, instances, settings: settings as unknown as AppSettings }
  })

  app.get('/health', async () => {
    return {
      status: 'ok',
      uptime: Date.now() - startTime,
      clients: getClientCount(),
      processes: getActiveProcessCount()
    }
  })
}
