import type { FastifyInstance } from 'fastify'
import { db, dbReadOnlyReason } from '../db.js'
import { getClientCount } from '../ws/handler.js'
import { processRegistry, getMaxConcurrentProcesses, isAgentLimitEnforced } from '../services/process-registry.js'
import { getTurnProgress } from '../services/turn-progress.js'
import { allPendingPermissionRequests } from '../services/pending-permissions.js'
import { getNativeTasks } from '../services/native-tasks.js'
import { parsePermissionRules } from './instances.js'
import type { FolderConfig, InstanceConfig, AppSettings, ProcessState } from '@orcstrator/shared'

const startTime = Date.now()

export default async function stateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/state', async () => {
    const folderRows = db.prepare('SELECT * FROM folders ORDER BY sort_order ASC').all() as Record<string, unknown>[]
    const instanceRows = db.prepare('SELECT * FROM instances ORDER BY sort_order ASC').all() as Record<string, unknown>[]
    const settingRows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>

    // Per-instance uncommitted count straight from the lock table (one grouped query).
    const dirtyRows = db.prepare('SELECT instance_id, COUNT(*) c FROM file_locks GROUP BY instance_id').all() as Array<{ instance_id: string; c: number }>
    const dirtyMap = new Map(dirtyRows.map(r => [r.instance_id, r.c]))

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
      stealthMode: Boolean(r.stealth_mode),
      hidden: Boolean(r.hidden),
      // The project's own allow list (migration049). Read on the fresh-tab load like the per-chat
      // one beside it, because the refusal card explains a denial from the rules the browser
      // already holds, and a scope missing here would have it name the wrong cause.
      permissionRules: parsePermissionRules(r.permission_rules),
    }))

    // The CLI's task files are the source of truth, but they are read by the native-tasks
    // poller and served here from its memory. This used to be several synchronous
    // disk reads per chat on every load; now only a session never seen before is read, once.
    const sessionIds = [...new Set(instanceRows.map(r => r.session_id as string | null).filter((s): s is string => Boolean(s)))]
    const tasksBySession = new Map(await Promise.all(sessionIds.map(async s => [s, await getNativeTasks(s)] as const)))

    const instances: InstanceConfig[] = instanceRows.map(r => {
      // Live turn progress (elapsed timer + round-trip tokens) survives a page reload
      // mid-turn because it's hydrated here from the in-memory store, not the DB.
      const turn = getTurnProgress(r.id as string)
      return {
        id: r.id as string,
        folderId: r.folder_id as string,
        name: r.name as string,
        cwd: r.cwd as string,
        sessionId: r.session_id as string | undefined,
        state: (r.state as InstanceConfig['state']) || 'idle',
        processState: (r.process_state as ProcessState) || 'idle',
        agentId: r.agent_id as string | undefined,
        idleRestartMinutes: r.idle_restart_minutes as number,
        sortOrder: r.sort_order as number,
        createdAt: r.created_at as number,
        overdriveTasks: (r.overdrive_tasks as number) ?? 0,
        overdriveStartedAt: r.overdrive_started_at as number | undefined,
        lastTaskAt: r.last_task_at as number | undefined,
        contextHealth: computeContextHealth(r),
        ctxTokens: (r.ctx_tokens as number) || undefined,
        ctxModel: (r.ctx_model as string) || undefined,
        dirtyCount: dirtyMap.get(r.id as string) || undefined,
        keepWarm: Boolean(r.keep_warm),
        // Not sidebar decoration: the client saves rules as `{ ...permissionRules, ...patch }` and the
        // PUT replaces the column, so omitting this wipes every per-chat rule in one click.
        permissionRules: parsePermissionRules(r.permission_rules),
        lastTurnMs: (r.last_turn_ms as number) || undefined,
        maxTurnMs: (r.max_turn_ms as number) || undefined,
        turnStartedAt: turn?.startedAt,
        turnOutputTokens: turn?.outputTokens,
        // Blocked on the user. Hydrated from the DB on purpose: it has to survive a browser
        // reload and a server restart, because the question is still unanswered either way.
        awaitingInput: (r.awaiting_input as InstanceConfig['awaitingInput']) || undefined,
        awaitingInputAt: (r.awaiting_input_at as number) || undefined,
        // A scheduled fire that has not been looked at yet. Hydrated on purpose: a cold open
        // must still pull the chat into the grid and still owe it its one glow.
        surfacedAt: (r.surfaced_at as number) || undefined,
        surfacedSource: (r.surfaced_source as InstanceConfig['surfacedSource']) || undefined,
        surfaceSilent: Boolean(r.surface_silent),
        // Per-chat Claude CLI overrides. Undefined = this chat inherits the app-wide setting.
        outputStyle: (r.output_style as string) || undefined,
        language: (r.language as string) || undefined,
        // From the task-file poller's memory, not the DB: the CLI's task files are the truth.
        nativeTasks: tasksBySession.get(r.session_id as string) ?? [],
      }
    })

    const settings: Record<string, unknown> = {}
    for (const row of settingRows) {
      try {
        settings[row.key] = JSON.parse(row.value)
      } catch {
        settings[row.key] = row.value
      }
    }

    // Requests a chat is blocked on right now. Without these a reload lost the banner while the
    // CLI kept waiting on stdin, and the turn sat there with nothing on screen to answer it.
    return { folders, instances, settings: settings as unknown as AppSettings, pendingPermissions: allPendingPermissionRequests() }
  })

  app.get('/health', async () => {
    const memUsage = process.memoryUsage()
    const instanceRows = db.prepare('SELECT id, name, state FROM instances').all() as Array<{ id: string; name: string; state: string }>
    return {
      status: dbReadOnlyReason ? 'read-only' : 'ok',
      // Set when the pre-migration backup failed and the database opened read-only.
      dbReadOnly: dbReadOnlyReason,
      uptime: Date.now() - startTime,
      bootTime: startTime,
      clients: getClientCount(),
      processes: processRegistry.getActiveCount(),
      maxProcesses: getMaxConcurrentProcesses(),
      // Whether that cap is enforced at all: off unless switched on in Settings.
      maxProcessesEnforced: isAgentLimitEnforced(),
      totalInstances: instanceRows.length,
      runningInstances: instanceRows.filter(i => i.state === 'running').length,
      memoryMb: Math.round(memUsage.rss / 1024 / 1024),
      heapMb: Math.round(memUsage.heapUsed / 1024 / 1024),
    }
  })

  // Live process monitor: returns per-process data + recent token spend
  app.get('/processes', async () => {
    const tracked = processRegistry.getProcessInfo()
    const now = Date.now()

    const result = tracked.map(proc => {
      // Get instance info
      const inst = db.prepare('SELECT name, session_id, process_pid FROM instances WHERE id = ?')
        .get(proc.instanceId) as { name: string; session_id: string | null; process_pid: number | null } | undefined

      // This chat's latest turn (token_usage, read here before, has not been written
      // for months, so lastCostUsd was always null).
      const usage = db.prepare(
        'SELECT cost_usd, input_tokens, output_tokens FROM turn_costs WHERE instance_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(proc.instanceId) as { cost_usd: number; input_tokens: number; output_tokens: number } | undefined

      return {
        instanceId: proc.instanceId,
        instanceName: inst?.name ?? '?',
        pid: proc.pid,
        state: proc.state,
        runningSec: proc.runningSec,
        lastCostUsd: usage?.cost_usd ?? null,
        lastInputTokens: usage?.input_tokens ?? null,
        lastOutputTokens: usage?.output_tokens ?? null,
      }
    })

    return { processes: result, timestamp: now }
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
  return 'stale'  // 20+ tasks in same session: compaction summaries stacking up
}
