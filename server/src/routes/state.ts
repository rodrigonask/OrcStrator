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

    const lockedTaskRows = db.prepare(
      "SELECT locked_by as instanceId, id as taskId, title as taskTitle FROM pipeline_tasks WHERE locked_by IS NOT NULL"
    ).all() as Array<{ instanceId: string; taskId: string; taskTitle: string }>
    const lockedByInstance = new Map(lockedTaskRows.map(r => [r.instanceId, { taskId: r.taskId, taskTitle: r.taskTitle }]))

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
      createdAt: r.created_at as number,
      orchestratorActive: Boolean(r.orchestrator_active),
      stealthMode: Boolean(r.stealth_mode),
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
      createdAt: r.created_at as number,
      agentRole: r.agent_role as InstanceConfig['agentRole'],
      specialization: r.specialization as string | undefined,
      orchestratorManaged: Boolean(r.orchestrator_managed),
      xpTotal: (r.xp_total as number) ?? 0,
      level: (r.level as number) ?? 1,
      overdriveTasks: (r.overdrive_tasks as number) ?? 0,
      overdriveStartedAt: r.overdrive_started_at as number | undefined,
      lastTaskAt: r.last_task_at as number | undefined,
      activeTaskId: lockedByInstance.get(r.id as string)?.taskId,
      activeTaskTitle: lockedByInstance.get(r.id as string)?.taskTitle,
      // Context health: fresh (0-3 tasks), warm (4-10), heavy (11-20), stale (20+)
      // Helps users know when a session might benefit from a fresh start
      contextHealth: computeContextHealth(r),
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
    const memUsage = process.memoryUsage()
    const instanceRows = db.prepare('SELECT id, name, state, agent_role FROM instances').all() as Array<{ id: string; name: string; state: string; agent_role: string | null }>
    return {
      status: 'ok',
      uptime: Date.now() - startTime,
      clients: getClientCount(),
      processes: getActiveProcessCount(),
      totalInstances: instanceRows.length,
      runningInstances: instanceRows.filter(i => i.state === 'running').length,
      memoryMb: Math.round(memUsage.rss / 1024 / 1024),
      heapMb: Math.round(memUsage.heapUsed / 1024 / 1024),
    }
  })

}


type ContextHealth = 'cold' | 'fresh' | 'warm' | 'heavy' | 'stale'

function computeContextHealth(row: Record<string, unknown>): ContextHealth {
  const sessionId = row.session_id as string | null
  const tasks = (row.overdrive_tasks as number) ?? 0
  const lastTaskAt = row.last_task_at as number | undefined
  const CACHE_TTL_MS = 60 * 60 * 1000

  // No session = cold
  if (!sessionId) return 'cold'

  // Cache expired = cold
  if (lastTaskAt && (Date.now() - lastTaskAt) > CACHE_TTL_MS) return 'cold'

  // Fewer tasks = fresher context
  if (tasks <= 3) return 'fresh'
  if (tasks <= 10) return 'warm'
  if (tasks <= 20) return 'heavy'
  return 'stale'  // 20+ tasks in same session — compaction summaries stacking up
}
