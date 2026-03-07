import { db } from '../db.js'
import { sendMessage, type ProcessExitTokens } from './claude-process.js'
import { broadcastEvent } from '../ws/handler.js'
import { updateOverdriveOnComplete, resetOverdriveIfExpired } from './overdrive.js'
import { markScheduleRunning, appendExecution, updateScheduleAfterRun } from './task-manager.js'
import type { PipelineTask, ScheduleExecution } from '@nasklaude/shared'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const LOCK_TIMEOUT_MS = 20 * 60 * 1000 // 20 minutes (was 10)
const SEND_COOLDOWN_MS = 10 * 1000     // 10-second hard cooldown per instance
const ARCHIVE_AGE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

export const serverStartTime = Date.now()
const SAFETY_POLL_MS = 60 * 1000        // 60 seconds
const LOCK_SWEEP_MS = 2 * 60 * 1000    // 2 minutes
const ARCHIVE_SWEEP_MS = 6 * 60 * 60 * 1000 // 6 hours
const MAX_RETRIES = 3

// Master prompts live in nasklaude's source, not in Claude Code's config directory
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MASTER_PROMPTS_DIR = path.resolve(__dirname, '../../agents')

import { DEFAULT_ROLE_MODELS, DEFAULT_ROLE_TOOLS } from '@nasklaude/shared'

// Model tiering: read from settings, fallback to defaults
function getRoleModels(): Record<string, string> {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'orchestratorModels'").get() as { value: string } | undefined
    if (row) {
      const models = JSON.parse(row.value) as Record<string, string>
      // Merge with defaults, filtering out 'default' (use role's default)
      const result = { ...DEFAULT_ROLE_MODELS }
      for (const [role, model] of Object.entries(models)) {
        if (model && model !== 'default') result[role] = model
      }
      return result
    }
  } catch { /* use defaults */ }
  return DEFAULT_ROLE_MODELS
}

// MCP scoping: per-role defaults (used when settings not yet configured)
const AGENTS_DIR = path.resolve(__dirname, '../../agents')
const ROLE_MCP_DEFAULTS: Record<string, string[]> = {
  planner: [],
  builder: [],
  tester: ['playwriter'],
  promoter: [],
}

// Tool scoping: read from settings, fallback to defaults
function getRoleTools(): Record<string, string> {
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

// Permission mode: read from settings
function getPermissionFlag(): string {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'permissionMode'").get() as { value: string } | undefined
    if (row) {
      const mode = JSON.parse(row.value) as string
      if (mode === 'bypass') return '--dangerously-skip-permissions'
      if (mode === 'plan') return '--permission-mode=plan'
      if (mode === 'default') return '--permission-mode=default'
    }
  } catch { /* fallback */ }
  return '--dangerously-skip-permissions'
}

// Build a temp MCP config file containing only the named servers from ~/.claude.json
function buildMcpConfigFile(serverNames: string[]): string | null {
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

  const tmpPath = path.join(os.tmpdir(), `nasklaude-mcp-${crypto.randomUUID()}.json`)
  fs.writeFileSync(tmpPath, JSON.stringify({ mcpServers: selected }), 'utf-8')
  return tmpPath
}

// Resolve MCP config path for a role: settings → defaults → temp file → tester fallback
function getMcpConfigPath(role: string): string {
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

export interface ResumeSnapshot {
  instanceId: string
  sessionId: string
  folderId: string
  lockedTaskIds: string[]
}

const ROLE_COLUMNS: Record<string, string[]> = {
  planner: ['spec'],
  builder: ['build'],
  tester: ['qa'],
  promoter: ['ship'],
  // scheduler role does not use ROLE_COLUMNS — tasks are dispatched by SchedulerService
}

// Track scheduler instances separately so they're exempt from the 20-min kill timeout
const activeSchedulerInstances = new Set<string>()

interface SchedulerRunContext {
  taskId: string
  runId: string
  startedAt: number
}

class OrchestratorService {
  private safetyPollTimer: ReturnType<typeof setInterval> | null = null
  private lockSweepTimer: ReturnType<typeof setInterval> | null = null
  private archiveSweepTimer: ReturnType<typeof setInterval> | null = null
  private folderTriggerTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastSendTime = new Map<string, number>()  // instanceId → timestamp of last sendMessage
  private schedulerRunContexts = new Map<string, SchedulerRunContext>() // instanceId → run context

  start(): void {
    if (this.safetyPollTimer) return
    this.safetyPollTimer = setInterval(() => this.safetySweep(), SAFETY_POLL_MS)
    this.lockSweepTimer = setInterval(() => this.timeoutSweep(), LOCK_SWEEP_MS)
    this.archiveSweepTimer = setInterval(() => this.archiveSweep(), ARCHIVE_SWEEP_MS)
    // Run archive once at startup after a short delay
    setTimeout(() => this.archiveSweep(), 10_000)
    console.log('[orchestrator] Started — event-driven + 60s safety poll + 2min lock sweep + 6h archive sweep')
  }

  stop(): void {
    if (this.safetyPollTimer) clearInterval(this.safetyPollTimer)
    if (this.lockSweepTimer) clearInterval(this.lockSweepTimer)
    if (this.archiveSweepTimer) clearInterval(this.archiveSweepTimer)
  }

  // Primary trigger: called directly from claude-process.ts on process exit
  onProcessExit(instanceId: string, tokens?: ProcessExitTokens): void {
    // Scheduler instance: handle via scheduler exit path
    const schedulerCtx = this.schedulerRunContexts.get(instanceId)
    if (schedulerCtx) {
      this.schedulerRunContexts.delete(instanceId)
      activeSchedulerInstances.delete(instanceId)
      this.onSchedulerExit(instanceId, schedulerCtx.taskId, schedulerCtx.runId, schedulerCtx.startedAt)
      this.pruneMessages(instanceId)
      return
    }

    // Accumulate tokens on the locked task + post spend comment
    if (tokens && (tokens.inputTokens > 0 || tokens.outputTokens > 0)) {
      this.accumulateTaskTokens(instanceId, tokens)
    }

    // Release all task locks held by this instance — if the agent moved the task,
    // moveTask() already cleared the lock; this catches tasks the agent didn't move
    // (failed tests, context limit exits, crashes)
    try {
      const released = db.prepare(
        'UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL WHERE locked_by = ?'
      ).run(instanceId)
      if (released.changes > 0) {
        console.log(`[orchestrator] Released ${released.changes} stale lock(s) for instance ${instanceId}`)
      }
    } catch (err) {
      console.error('[orchestrator] lock release error:', err)
    }

    try {
      const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId) as Record<string, unknown> | undefined
      if (!instance || !instance.agent_role) return

      const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(instance.folder_id as string) as Record<string, unknown> | undefined
      if (!folder || !folder.orchestrator_active) return

      this.assignWork(instance.folder_id as string)
    } catch (err) {
      console.error('[orchestrator] onProcessExit error:', err)
    }
    this.pruneMessages(instanceId)
    updateOverdriveOnComplete(instanceId)
    // Keep session_id so next task resumes the session (cache hits on pinned context)
  }

  private pruneOldMessages(instanceId: string): void {
    const KEEP_LAST = 50
    try {
      const row = db.prepare('SELECT COUNT(*) as c FROM messages WHERE instance_id = ?').get(instanceId) as { c: number }
      if (row.c > KEEP_LAST) {
        const cutoffRow = db.prepare(
          'SELECT created_at FROM messages WHERE instance_id = ? ORDER BY created_at DESC LIMIT 1 OFFSET ?'
        ).get(instanceId, KEEP_LAST - 1) as { created_at: number } | undefined
        if (cutoffRow) {
          const deleted = db.prepare('DELETE FROM messages WHERE instance_id = ? AND created_at < ?')
            .run(instanceId, cutoffRow.created_at).changes
          if (deleted > 0) {
            console.log(`[orchestrator] Pruned ${deleted} old messages for ${instanceId}`)
          }
        }
      }
    } catch (err) {
      console.error('[orchestrator] pruneOldMessages error:', err)
    }
  }

  private pruneMessages(instanceId: string): void {
    try {
      const KEEP = 50
      db.prepare(`
        DELETE FROM messages
        WHERE instance_id = ?
          AND id NOT IN (
            SELECT id FROM messages
            WHERE instance_id = ?
            ORDER BY created_at DESC
            LIMIT ?
          )
      `).run(instanceId, instanceId, KEEP)
    } catch (err) {
      console.error('[orchestrator] pruneMessages error:', err)
    }
  }

  private accumulateTaskTokens(instanceId: string, tokens: ProcessExitTokens): void {
    try {
      // Find task(s) locked by this instance
      const tasks = db.prepare(
        'SELECT id, title, project_id, total_input_tokens, total_output_tokens, total_cost_usd FROM pipeline_tasks WHERE locked_by = ?'
      ).all(instanceId) as Array<{ id: string; title: string; project_id: string; total_input_tokens: number; total_output_tokens: number; total_cost_usd: number }>

      if (tasks.length === 0) return

      // Split tokens evenly across bundle tasks (usually 1)
      const perTask = {
        input: Math.round(tokens.inputTokens / tasks.length),
        output: Math.round(tokens.outputTokens / tasks.length),
        cost: +(tokens.costUsd / tasks.length).toFixed(6),
      }

      const instance = db.prepare('SELECT name, agent_role FROM instances WHERE id = ?').get(instanceId) as { name: string; agent_role: string } | undefined

      for (const task of tasks) {
        const newInput = (task.total_input_tokens || 0) + perTask.input
        const newOutput = (task.total_output_tokens || 0) + perTask.output
        const newCost = +((task.total_cost_usd || 0) + perTask.cost).toFixed(6)

        db.prepare(
          'UPDATE pipeline_tasks SET total_input_tokens = ?, total_output_tokens = ?, total_cost_usd = ? WHERE id = ?'
        ).run(newInput, newOutput, newCost, task.id)

        // Post token spend comment with cache hit info
        const cacheRead = Math.round((tokens.cacheReadTokens || 0) / tasks.length)
        const cacheCreate = Math.round((tokens.cacheCreationTokens || 0) / tasks.length)
        const cacheHitPct = perTask.input > 0 ? Math.round((cacheRead / perTask.input) * 100) : 0
        const commentBody = `Token summary ${task.id}: cost=$${perTask.cost.toFixed(4)} cache_hit=${cacheHitPct}% (read=${cacheRead} create=${cacheCreate})`
        const commentId = crypto.randomUUID()
        db.prepare(
          'INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(commentId, task.id, instance?.agent_role || 'system', commentBody, Date.now())

        console.log(`[orchestrator] Token accumulation: "${task.title}" → +${perTask.input}in/+${perTask.output}out (+$${perTask.cost.toFixed(4)}) | Total: $${newCost.toFixed(4)}`)
      }
    } catch (err) {
      console.error('[orchestrator] accumulateTaskTokens error:', err)
    }
  }

  // Fallback: runs every 60s
  private safetySweep(): void {
    try {
      const folders = db.prepare('SELECT * FROM folders WHERE orchestrator_active = 1').all() as Record<string, unknown>[]
      for (const folder of folders) {
        this.assignWork(folder.id as string)
      }
    } catch (err) {
      console.error('[orchestrator] safetySweep error:', err)
    }
  }

  // Lock timeout sweep: runs every 2 minutes
  private timeoutSweep(): void {
    try {
      const cutoff = Date.now() - LOCK_TIMEOUT_MS
      const lockedTasks = db.prepare(`
        SELECT pt.*, i.state as instance_state, i.agent_role as instance_role
        FROM pipeline_tasks pt
        LEFT JOIN instances i ON pt.locked_by = i.id
        WHERE pt.locked_by IS NOT NULL
          AND pt.locked_at < ?
          AND (i.state IS NULL OR i.state != 'running')
      `).all(cutoff) as Record<string, unknown>[]

      if (lockedTasks.length === 0) return

      // Group by group_id so bundles are released atomically
      const groupedTasks = new Map<string, Record<string, unknown>[]>()
      for (const task of lockedTasks) {
        const key = (task.group_id as string) || (task.id as string)
        const group = groupedTasks.get(key) || []
        group.push(task)
        groupedTasks.set(key, group)
      }

      for (const [, tasks] of groupedTasks) {
        const rep = tasks[0]

        // Scheduler tasks are exempt from the 20-min kill timeout — they may run for long periods
        if ((rep.instance_role as string) === 'scheduler' || activeSchedulerInstances.has(rep.locked_by as string)) {
          continue
        }

        // Task was locked before this server boot — the server was offline, not the agent's fault
        const lockedBeforeStart = (rep.locked_at as number) < serverStartTime
        if (lockedBeforeStart) {
          for (const t of tasks) {
            const history = JSON.parse((t.history as string) || '[]')
            history.push({ action: 'lock_released', timestamp: Date.now(), note: 'server was offline — timeout not counted as agent failure' })
            db.prepare(`UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL, history = ?, updated_at = ? WHERE id = ?`)
              .run(JSON.stringify(history), Date.now(), t.id)
          }
          broadcastEvent({ type: 'orchestrator:lock-released', payload: { taskId: rep.id, reason: 'server-restart' } })
          if (rep.project_id) broadcastEvent({ type: 'pipeline:updated', payload: { projectId: rep.project_id } })
          continue
        }

        const newRetryCount = ((rep.retry_count as number) || 0) + 1

        if (newRetryCount >= MAX_RETRIES) {
          for (const t of tasks) {
            const history = JSON.parse((t.history as string) || '[]')
            history.push({ action: 'moved', timestamp: Date.now(), from: t.column, to: 'backlog', note: '3 failures — stuck, needs a human' })
            // Add 'stuck' label
            let labels: string[]
            try { labels = JSON.parse((t.labels as string) || '[]') } catch { labels = [] }
            if (!labels.includes('stuck')) labels.push('stuck')
            db.prepare(`UPDATE pipeline_tasks SET "column" = 'backlog', labels = ?, locked_by = NULL, locked_at = NULL, retry_count = ?, history = ?, updated_at = ? WHERE id = ?`)
              .run(JSON.stringify(labels), newRetryCount, JSON.stringify(history), Date.now(), t.id)
          }
          broadcastEvent({ type: 'orchestrator:lock-released', payload: { taskId: rep.id, reason: 'max-retries-stuck' } })
        } else {
          for (const t of tasks) {
            const history = JSON.parse((t.history as string) || '[]')
            history.push({ action: 'lock_released', timestamp: Date.now(), note: 'timeout after 20min — the agent ghosted us' })
            db.prepare(`UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL, retry_count = ?, history = ?, updated_at = ? WHERE id = ?`)
              .run(newRetryCount, JSON.stringify(history), Date.now(), t.id)
          }
          broadcastEvent({ type: 'orchestrator:lock-released', payload: { taskId: rep.id, reason: 'timeout' } })
        }

        if (rep.project_id) {
          broadcastEvent({ type: 'pipeline:updated', payload: { projectId: rep.project_id } })
        }
      }
    } catch (err) {
      console.error('[orchestrator] timeoutSweep error:', err)
    }
  }

  // Archive sweep: purge old done tasks, their comments, and stale token_usage
  private archiveSweep(): void {
    try {
      const cutoff = Date.now() - ARCHIVE_AGE_MS
      // Delete comments for done tasks older than 14 days
      const deletedComments = db.prepare(`
        DELETE FROM task_comments WHERE task_id IN (
          SELECT id FROM pipeline_tasks WHERE "column" = 'done' AND completed_at < ?
        )
      `).run(cutoff).changes
      // Truncate description and history, then delete the tasks
      const deletedTasks = db.prepare(`
        DELETE FROM pipeline_tasks WHERE "column" = 'done' AND completed_at < ?
      `).run(cutoff).changes
      // Delete orphaned token_usage rows for tasks that no longer exist
      const deletedUsage = db.prepare(`
        DELETE FROM token_usage WHERE task_id IS NOT NULL AND task_id NOT IN (
          SELECT id FROM pipeline_tasks
        )
      `).run().changes
      if (deletedComments || deletedTasks || deletedUsage) {
        console.log(`[orchestrator] Archive sweep: ${deletedTasks} tasks, ${deletedComments} comments, ${deletedUsage} token_usage rows purged`)
        try { db.pragma('incremental_vacuum') } catch { /* non-critical */ }
      }
    } catch (err) {
      console.error('[orchestrator] archiveSweep error:', err)
    }
  }

  // Core assignment logic — find idle managed agents and give them work
  private assignWork(folderId: string): void {
    try {
      const instances = db.prepare(`
        SELECT * FROM instances
        WHERE folder_id = ? AND state = 'idle' AND agent_role IS NOT NULL
          AND orchestrator_managed = 1
      `).all(folderId) as Record<string, unknown>[]

      if (instances.length === 0) return

      // Smart assignment: prefer agents with warm sessions (cache hits are ~10x cheaper)
      const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
      const now = Date.now()
      instances.sort((a, b) => {
        const aWarm = a.session_id && a.last_task_at && (now - (a.last_task_at as number)) < CACHE_TTL_MS ? 1 : 0
        const bWarm = b.session_id && b.last_task_at && (now - (b.last_task_at as number)) < CACHE_TTL_MS ? 1 : 0
        return bWarm - aWarm // warm agents first
      })

      for (const instance of instances) {
        const role = instance.agent_role as string
        const columns = ROLE_COLUMNS[role]
        if (!columns) continue

        const task = this.findNextTask(folderId, columns, role)
        if (!task) continue

        this.assignTaskToInstance(task, instance, folderId)
      }

      this.broadcastStatus(folderId)
    } catch (err) {
      console.error('[orchestrator] assignWork error:', err)
    }
  }

  private findNextTask(folderId: string, columns: string[], role: string): Record<string, unknown> | undefined {
    const placeholders = columns.map(() => '?').join(',')

    // Builders: try bundles first
    if (role === 'builder') {
      const bundleTask = db.prepare(`
        SELECT * FROM pipeline_tasks
        WHERE project_id = ? AND "column" IN (${placeholders})
          AND locked_by IS NULL AND group_id IS NOT NULL AND group_id != ''
        ORDER BY priority ASC, created_at ASC
        LIMIT 1
      `).get(folderId, ...columns) as Record<string, unknown> | undefined

      if (bundleTask) {
        const locked = db.prepare(`SELECT COUNT(*) as count FROM pipeline_tasks WHERE group_id = ? AND locked_by IS NOT NULL`)
          .get(bundleTask.group_id as string) as { count: number }
        if (locked.count === 0) return bundleTask
      }
    }

    // Solo tasks (builders only skip group tasks here — other roles can process any task)
    const groupFilter = role === 'builder' ? `AND (group_id IS NULL OR group_id = '')` : ''
    return db.prepare(`
      SELECT * FROM pipeline_tasks
      WHERE project_id = ? AND "column" IN (${placeholders})
        AND locked_by IS NULL ${groupFilter}
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `).get(folderId, ...columns) as Record<string, unknown> | undefined
  }

  private assignTaskToInstance(task: Record<string, unknown>, instance: Record<string, unknown>, folderId: string): void {
    const instanceId = instance.id as string
    const role = instance.agent_role as string
    const now = Date.now()

    // Hard 10-second cooldown — prevent duplicate sends from burst triggers
    const lastSend = this.lastSendTime.get(instanceId) || 0
    if (now - lastSend < SEND_COOLDOWN_MS) {
      console.warn(`[orchestrator] COOLDOWN: Skipping send to ${instanceId} (${(now - lastSend) / 1000}s since last send)`)
      return
    }

    const finalColumn = task.column as string

    // Collect bundle tasks (builders only)
    let tasksToLock: Record<string, unknown>[] = [task]
    if (task.group_id && (task.group_id as string) !== '' && role === 'builder') {
      tasksToLock = db.prepare(`SELECT * FROM pipeline_tasks WHERE group_id = ? ORDER BY group_index ASC`)
        .all(task.group_id as string) as Record<string, unknown>[]
      if (tasksToLock.length === 0) tasksToLock = [task]
    }

    // Lock all tasks atomically — conditional on locked_by IS NULL to prevent double-assignment
    const lockTx = db.transaction(() => {
      for (const t of tasksToLock) {
        const history = JSON.parse((t.history as string) || '[]')
        history.push({ action: 'assigned', timestamp: now, agent: instanceId })
        const result = db.prepare(
          `UPDATE pipeline_tasks SET locked_by = ?, locked_at = ?, "column" = ?, history = ?, updated_at = ?
           WHERE id = ? AND locked_by IS NULL`
        ).run(instanceId, now, finalColumn, JSON.stringify(history), now, t.id)
        if (result.changes === 0) return false  // task already locked by someone else
      }
      return true
    })
    const locked = lockTx()
    if (!locked) {
      console.warn(`[orchestrator] Task ${task.id as string} already locked — skipping double-assignment for ${instanceId}`)
      return
    }

    // Mark as running immediately so concurrent assignWork calls see it as busy
    db.prepare("UPDATE instances SET state = 'running' WHERE id = ?").run(instanceId)

    // Build prompt
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Record<string, unknown>
    const prompt = this.buildPrompt(tasksToLock, task, instance, folder)

    const cwd = (instance.cwd as string) || (folder.path as string)
    const sessionId = (instance.session_id as string) || undefined  // Resume session for cache hits on pinned context

    const flagRows = db.prepare("SELECT value FROM settings WHERE key = 'globalFlags'").get() as { value: string } | undefined
    const globalFlags: string[] = flagRows ? JSON.parse(flagRows.value) : []

    // Model tiering — inject --model flag if not already set
    // Auto-escalation: if the task failed before, upgrade to opus for the retry
    const retryCount = (task.retry_count as number) || 0
    const roleModels = getRoleModels()
    const model = retryCount > 0 ? 'opus' : roleModels[role]
    const hasModelFlag = globalFlags.some(f => f.startsWith('--model'))
    if (!hasModelFlag && model) {
      globalFlags.push(`--model=${model}`)
    }

    // Tool scoping — reduce built-in tool surface per role
    const roleTools = getRoleTools()
    const tools = roleTools[role]
    if (tools && !globalFlags.some(f => f.startsWith('--tools'))) {
      globalFlags.push('--tools', tools)
    }

    // Cache control
    try {
      const cacheRow = db.prepare("SELECT value FROM settings WHERE key = 'disableCache'").get() as { value: string } | undefined
      if (cacheRow && JSON.parse(cacheRow.value) === true && !globalFlags.includes('--no-cache')) {
        globalFlags.push('--no-cache')
      }
    } catch { /* ignore */ }

    // Max tokens
    try {
      const maxRow = db.prepare("SELECT value FROM settings WHERE key = 'maxTokens'").get() as { value: string } | undefined
      if (maxRow) {
        const maxTokens = JSON.parse(maxRow.value) as number
        if (maxTokens > 0 && !globalFlags.some(f => f.startsWith('--max-tokens'))) {
          globalFlags.push(`--max-tokens=${maxTokens}`)
        }
      }
    } catch { /* ignore */ }
    if (retryCount > 0) {
      console.log(`[orchestrator] Auto-escalation: task "${task.title}" failed ${retryCount}x, upgrading to opus`)
    }

    let agentPrompt: string | undefined
    if (instance.agent_id) {
      const agent = db.prepare('SELECT content FROM agents WHERE id = ?').get(instance.agent_id as string) as { content: string } | undefined
      agentPrompt = agent?.content
    }

    resetOverdriveIfExpired(instanceId)

    console.log(`[orchestrator] Assigning "${task.title}" → instance ${instanceId} (${role}, model: ${roleModels[role] || 'default'})`)

    // Extract images from task attachments
    let taskImages: Array<{ base64: string; mediaType: string }> | undefined
    const rawAttachments = JSON.parse((task.attachments as string) || '[]') as Array<{ dataUrl: string; name: string }>
    if (rawAttachments.length > 0) {
      taskImages = rawAttachments
        .filter(a => typeof a.dataUrl === 'string' && a.dataUrl.includes(','))
        .map(a => {
          const [header, base64] = a.dataUrl.split(',')
          const mediaType = header.replace('data:', '').replace(';base64', '')
          return { base64, mediaType }
        })
      if (taskImages.length === 0) taskImages = undefined
    }

    // Save orchestrator prompt as a user message so it's visible in the session
    const msgId = crypto.randomUUID()
    const msgContent: Array<Record<string, unknown>> = [
      {
        type: 'orc-brief',
        taskTitle: task.title as string,
        taskId: task.id as string,
        instanceName: instance.name as string,
        projectId: folderId,
      },
      { type: 'text', text: prompt },
    ]
    if (taskImages) {
      for (const img of taskImages) {
        msgContent.push({ type: 'image', base64: img.base64, mediaType: img.mediaType })
      }
    }
    db.prepare('INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(msgId, instanceId, 'user', JSON.stringify(msgContent), now)
    broadcastEvent({ type: 'message:added', payload: { instanceId, message: { id: msgId, instanceId, role: 'user', content: msgContent, createdAt: now } } })

    this.pruneOldMessages(instanceId)

    try {
      this.lastSendTime.set(instanceId, Date.now())
      sendMessage({ instanceId, text: prompt, images: taskImages, cwd, sessionId, flags: globalFlags, agentPrompt, mcpConfigPath: getMcpConfigPath(role) })
    } catch (err) {
      console.error(`[orchestrator] sendMessage failed for ${instanceId}:`, err)
      for (const t of tasksToLock) {
        db.prepare('UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL WHERE id = ?').run(t.id)
      }
      db.prepare("UPDATE instances SET state = 'idle' WHERE id = ?").run(instanceId)
      return
    }

    broadcastEvent({ type: 'orchestrator:assigned', payload: { folderId, instanceId, taskId: task.id as string, taskTitle: task.title as string } })
    broadcastEvent({ type: 'pipeline:updated', payload: { projectId: folderId } })
  }

  private buildPrompt(tasksToLock: Record<string, unknown>[], primaryTask: Record<string, unknown>, instance: Record<string, unknown>, folder: Record<string, unknown>, isResume = false): string {
    const role = instance.agent_role as string
    const projectId = folder.id as string
    const taskId = primaryTask.id as string
    const instanceCwd = (instance.cwd as string) || (folder.path as string)

    // Resume: lightweight message — agent already has context from prior session
    if (isResume) {
      const resumeObj = {
        type: 'resume',
        task: { id: taskId, title: primaryTask.title as string, column: primaryTask.column as string, priority: primaryTask.priority as number },
        api: { move: `POST http://localhost:3333/api/pipelines/${projectId}/tasks/${taskId}/move`, comment: `POST http://localhost:3333/api/pipelines/${projectId}/tasks/${taskId}/comments` },
        instruction: `You were working on this task before. Resume where you left off. Post a comment and move the task when done. Comment author: "${role}".`
      }
      const prompt = JSON.stringify(resumeObj, null, 2)
      console.log(`[orchestrator] Resume prompt: ${prompt.length} chars for ${role} on "${primaryTask.title}"`)
      return prompt
    }

    const masterPrompt = this.loadMasterPrompt(role)
    const skills = this.loadInstanceSkills(instance)
    const isBundle = tasksToLock.length > 1

    // Cap description to prevent spec bloat (5000 chars ≈ 1250 tokens max)
    const MAX_DESC_CHARS = 5000
    let description = (primaryTask.description as string) || ''
    if (description.length > MAX_DESC_CHARS) {
      description = description.slice(0, MAX_DESC_CHARS) + '\n\n[... description truncated at 5000 chars — read the full spec from task comments or source files if needed]'
    }

    // Build structured JSON assignment
    const assignment: Record<string, unknown> = {
      scope: instanceCwd,
      role,
      task: {
        id: taskId,
        projectId,
        title: primaryTask.title as string,
        priority: primaryTask.priority as number,
        column: primaryTask.column as string,
        description,
      },
      api: {
        move: `POST http://localhost:3333/api/pipelines/${projectId}/tasks/${taskId}/move  body: {"column":"<target>"}`,
        comment: `POST http://localhost:3333/api/pipelines/${projectId}/tasks/${taskId}/comments  body: {"author":"${role}","body":"..."}`,
        columns: 'backlog | scheduled | spec | build | qa | ship | done',
      },
      rules: [
        'Only access files under scope directory.',
        'Post a short comment (1-3 sentences) before moving task.',
      ],
    }

    const rawAttachments = JSON.parse((primaryTask.attachments as string) || '[]') as Array<{ name: string }>
    if (rawAttachments.length > 0) {
      assignment.attachments = `${rawAttachments.length} screenshot(s) included with this message.`
    }

    const dependsOn = JSON.parse((primaryTask.depends_on as string) || '[]') as string[]
    if (dependsOn.length > 0) {
      assignment.prerequisites = dependsOn
    }

    const priorComments = this.loadTaskComments(taskId)
    if (priorComments) {
      assignment.priorComments = priorComments
    }

    if (isBundle) {
      assignment.bundle = tasksToLock.map(t => ({
        index: t.group_index,
        total: t.group_total,
        title: t.title as string,
      }))
    }

    // Compose: master prompt (human-readable) + JSON assignment
    const parts: string[] = []

    if (masterPrompt) {
      parts.push(masterPrompt)
      parts.push('')
    }

    if (skills.length > 0) {
      for (const skill of skills) {
        parts.push(`### Skill: ${skill.name}`)
        parts.push(skill.content)
      }
      parts.push('')
    }

    if (role === 'tester') {
      parts.push('## playwriter: `playwriter session new` then `playwriter -e "..."` (page global). Relative screenshot paths.')
      parts.push('')
    }

    parts.push('## ASSIGNMENT')
    parts.push('```json')
    parts.push(JSON.stringify(assignment, null, 2))
    parts.push('```')

    const prompt = parts.join('\n')
    const promptChars = prompt.length
    const estimatedTokens = Math.round(promptChars / 4)
    console.log(`[orchestrator] Prompt size: ${promptChars} chars (~${estimatedTokens} tokens) for ${role} on "${primaryTask.title}"`)

    // Persist prompt size for monitoring
    try {
      db.prepare(
        'INSERT INTO token_usage (instance_id, role, task_id, prompt_chars, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(instance.id as string, role, taskId, promptChars, Date.now())
    } catch { /* non-critical */ }

    return prompt
  }

  private loadMasterPrompt(role: string): string {
    const filePath = path.join(MASTER_PROMPTS_DIR, `${role}-master.md`)
    try {
      if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8')
    } catch { /* unreadable */ }
    return ''
  }

  private loadInstanceSkills(instance: Record<string, unknown>): Array<{ name: string; content: string }> {
    if (!instance.agent_id) return []
    const agent = db.prepare('SELECT skills FROM agents WHERE id = ?').get(instance.agent_id as string) as { skills: string } | undefined
    if (!agent) return []
    const skillIds = JSON.parse(agent.skills || '[]') as string[]
    if (skillIds.length === 0) return []
    const results: Array<{ name: string; content: string }> = []
    for (const skillId of skillIds) {
      const skill = db.prepare('SELECT name, content FROM skills WHERE id = ?').get(skillId) as { name: string; content: string } | undefined
      if (skill?.content) results.push(skill)
    }
    return results
  }

  private loadTaskComments(taskId: string): string {
    try {
      // Last 3 unique comments (deduplicated by body), max 1500 chars
      const rows = db.prepare(
        'SELECT author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 10'
      ).all(taskId) as Array<{ author: string; body: string; created_at: number }>
      if (rows.length === 0) return ''

      // Deduplicate by body content (planner loop-spam fix)
      const seen = new Set<string>()
      const unique = rows.filter(r => {
        const key = r.body.trim()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).slice(0, 3)

      const MAX_CHARS = 1500
      let result = ''
      for (const r of unique.reverse()) {
        // Truncate individual comments to 400 chars
        const body = r.body.length > 400 ? r.body.slice(0, 400) + '...' : r.body
        const line = `[@${r.author}]: ${body}\n`
        if (result.length + line.length > MAX_CHARS) break
        result += line
      }
      return result.trimEnd()
    } catch {
      return ''
    }
  }

  async triggerScheduledTask(task: PipelineTask): Promise<void> {
    try {
      const folderId = task.projectId
      const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Record<string, unknown>
      if (!folder) {
        console.warn(`[orchestrator] triggerScheduledTask: folder ${folderId} not found`)
        return
      }

      // Mark as running before spawning
      markScheduleRunning(task.id, true)

      const now = Date.now()
      const runId = crypto.randomUUID()

      // Build scheduler prompt
      const masterPrompt = this.loadMasterPrompt('scheduler')
      const skillContent = task.skill ? this.loadSkillByName(task.skill) : null

      const MAX_DESC_CHARS = 5000
      let description = task.description || ''
      if (description.length > MAX_DESC_CHARS) {
        description = description.slice(0, MAX_DESC_CHARS) + '\n\n[... truncated]'
      }

      const assignment = {
        role: 'scheduler',
        task: {
          id: task.id,
          projectId: folderId,
          title: task.title,
          description,
          skill: task.skill ?? null,
        },
        api: {
          comment: `POST http://localhost:3333/api/pipelines/${folderId}/tasks/${task.id}/comments  body: {"author":"scheduler","body":"..."}`,
        },
        rules: [
          'Do not move this task to another column.',
          'Post a brief summary comment when finished.',
          'If you encounter an error, post the error as a comment and exit.',
          'Only access files under your assigned scope directory.',
        ],
      }

      const parts: string[] = []
      if (masterPrompt) { parts.push(masterPrompt); parts.push('') }
      if (skillContent) { parts.push(`### Skill: ${task.skill}`); parts.push(skillContent); parts.push('') }
      parts.push('## ASSIGNMENT')
      parts.push('```json')
      parts.push(JSON.stringify(assignment, null, 2))
      parts.push('```')
      const prompt = parts.join('\n')

      // Find or create a scheduler instance in this folder
      let schedulerInstance = db.prepare(
        "SELECT * FROM instances WHERE folder_id = ? AND agent_role = 'scheduler' AND state = 'idle' LIMIT 1"
      ).get(folderId) as Record<string, unknown> | undefined

      let instanceId: string
      if (schedulerInstance) {
        instanceId = schedulerInstance.id as string
      } else {
        // Create a temporary scheduler instance
        instanceId = crypto.randomUUID()
        db.prepare(`
          INSERT INTO instances (id, folder_id, name, cwd, state, agent_role, orchestrator_managed, sort_order, created_at)
          VALUES (?, ?, 'Chrono', ?, 'idle', 'scheduler', 1, 999, ?)
        `).run(instanceId, folderId, (folder.path as string) || '', now)
        schedulerInstance = db.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId) as Record<string, unknown>
      }

      // Track this instance as a scheduler
      activeSchedulerInstances.add(instanceId)
      db.prepare("UPDATE instances SET state = 'running', active_task_id = ?, active_task_title = ?, task_started_at = ? WHERE id = ?")
        .run(task.id, task.title, now, instanceId)

      // Record initial execution entry
      const exec: ScheduleExecution = { runId, startedAt: now, instanceId, status: 'running' }
      appendExecution(task.id, exec)

      const cwd = (folder.path as string) || ''
      const flagRows = db.prepare("SELECT value FROM settings WHERE key = 'globalFlags'").get() as { value: string } | undefined
      const globalFlags: string[] = flagRows ? JSON.parse(flagRows.value) : []

      const roleModels = getRoleModels()
      const model = roleModels['scheduler'] || 'sonnet'
      if (!globalFlags.some(f => f.startsWith('--model'))) globalFlags.push(`--model=${model}`)

      const roleTools = getRoleTools()
      const tools = roleTools['scheduler']
      if (tools && !globalFlags.some(f => f.startsWith('--tools'))) globalFlags.push('--tools', tools)

      // Save message for visibility
      const msgId = crypto.randomUUID()
      const msgContent = [
        { type: 'orc-brief', taskTitle: task.title, taskId: task.id, instanceName: 'Chrono', projectId: folderId },
        { type: 'text', text: prompt },
      ]
      db.prepare('INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(msgId, instanceId, 'user', JSON.stringify(msgContent), now)
      broadcastEvent({ type: 'message:added', payload: { instanceId, message: { id: msgId, instanceId, role: 'user', content: msgContent, createdAt: now } } })

      console.log(`[orchestrator] Scheduler dispatch: "${task.title}" → instance ${instanceId}`)

      // Store run context so onProcessExit can route to scheduler exit handler
      this.schedulerRunContexts.set(instanceId, { taskId: task.id, runId, startedAt: now })

      sendMessage({ instanceId, text: prompt, cwd, flags: globalFlags, mcpConfigPath: getMcpConfigPath('scheduler') })

      broadcastEvent({ type: 'pipeline:updated', payload: { projectId: folderId } })
    } catch (err) {
      console.error('[orchestrator] triggerScheduledTask error:', err)
      markScheduleRunning(task.id, false)
    }
  }

  private onSchedulerExit(
    instanceId: string,
    taskId: string,
    runId: string,
    startedAt: number,
  ): void {
    // Read cost data from token_usage table
    let costUsd: number | undefined
    let tokensUsed: number | undefined
    try {
      const usageRow = db.prepare(
        'SELECT cost_usd, input_tokens, output_tokens FROM token_usage WHERE instance_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(instanceId) as { cost_usd: number; input_tokens: number; output_tokens: number } | undefined
      if (usageRow) {
        costUsd = usageRow.cost_usd
        tokensUsed = (usageRow.input_tokens || 0) + (usageRow.output_tokens || 0)
      }
    } catch { /* non-critical */ }
    try {
      const now = Date.now()
      // Update the execution entry
      const task = db.prepare('SELECT * FROM pipeline_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined
      if (task) {
        let executions: ScheduleExecution[]
        try { executions = JSON.parse((task.executions as string) || '[]') } catch { executions = [] }
        const idx = executions.findIndex(e => e.runId === runId)
        if (idx >= 0) {
          executions[idx] = { ...executions[idx], endedAt: now, status: 'completed', costUsd, tokensUsed }
        }
        db.prepare('UPDATE pipeline_tasks SET executions = ? WHERE id = ?').run(JSON.stringify(executions), taskId)
      }

      updateScheduleAfterRun(taskId, now)

      db.prepare("UPDATE instances SET state = 'idle', active_task_id = NULL, active_task_title = NULL WHERE id = ?").run(instanceId)

      const projectId = (task?.project_id as string) ?? ''
      broadcastEvent({ type: 'pipeline:updated', payload: { projectId } })
      console.log(`[orchestrator] Scheduler run complete: task ${taskId}, cost=$${costUsd?.toFixed(4) ?? '?'}`)
    } catch (err) {
      console.error('[orchestrator] onSchedulerExit error:', err)
    }
  }

  private loadSkillByName(skillName: string): string | null {
    try {
      const row = db.prepare('SELECT content FROM skills WHERE name = ? LIMIT 1').get(skillName) as { content: string } | undefined
      return row?.content ?? null
    } catch {
      return null
    }
  }

  broadcastStatus(folderId: string): void {
    try {
      const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Record<string, unknown>
      const active = Boolean(folder?.orchestrator_active)

      const idleAgents = db.prepare(`SELECT COUNT(*) as count FROM instances WHERE folder_id = ? AND agent_role IS NOT NULL AND state = 'idle'`)
        .get(folderId) as { count: number }

      const pendingTasks = db.prepare(`SELECT COUNT(*) as count FROM pipeline_tasks WHERE project_id = ? AND "column" IN ('spec','build','qa','ship') AND locked_by IS NULL`)
        .get(folderId) as { count: number }

      broadcastEvent({ type: 'orchestrator:status', payload: { folderId, active, idleAgents: idleAgents.count, pendingTasks: pendingTasks.count } })
    } catch (err) {
      console.error('[orchestrator] broadcastStatus error:', err)
    }
  }

  // Immediately check a folder when activated — debounced to coalesce burst triggers
  triggerFolder(folderId: string): void {
    // 50ms debounce: coalesces rapid triggers (LaunchTeamModal 4x PATCH, onProcessExit + safetySweep bursts)
    const existing = this.folderTriggerTimers.get(folderId)
    if (existing) clearTimeout(existing)
    this.folderTriggerTimers.set(folderId, setTimeout(() => {
      this.folderTriggerTimers.delete(folderId)
      this.assignWork(folderId)
      this.broadcastStatus(folderId)
    }, 50))
  }

  // Resume agents whose sessions were alive before server restart
  resumeStaleInstances(snapshots: ResumeSnapshot[]): void {
    for (const snap of snapshots) {
      try {
        const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(snap.instanceId) as Record<string, unknown> | undefined
        if (!instance) continue

        const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(snap.folderId) as Record<string, unknown> | undefined
        if (!folder) continue

        const placeholders = snap.lockedTaskIds.map(() => '?').join(',')
        const tasks = db.prepare(
          `SELECT * FROM pipeline_tasks WHERE id IN (${placeholders}) ORDER BY priority ASC, created_at ASC`
        ).all(...snap.lockedTaskIds) as Record<string, unknown>[]
        if (tasks.length === 0) continue

        const primaryTask = tasks[0]
        const now = Date.now()

        // Re-lock tasks to this instance (they were cleared by startup reset)
        for (const t of tasks) {
          const history = JSON.parse((t.history as string) || '[]')
          history.push({ action: 'reassigned', timestamp: now, agent: snap.instanceId, note: 'server restart resume' })
          db.prepare(
            "UPDATE pipeline_tasks SET locked_by = ?, locked_at = ?, history = ?, updated_at = ? WHERE id = ?"
          ).run(snap.instanceId, now, JSON.stringify(history), now, t.id)
        }

        // Mark instance as running so triggerAll() below won't double-assign it
        db.prepare("UPDATE instances SET state = 'running' WHERE id = ?").run(snap.instanceId)

        const cwd = (instance.cwd as string) || (folder.path as string)

        const flagRows = db.prepare("SELECT value FROM settings WHERE key = 'globalFlags'").get() as { value: string } | undefined
        const globalFlags: string[] = flagRows ? JSON.parse(flagRows.value) : []

        // Model tiering for resumed sessions
        const role = instance.agent_role as string
        const roleModels = getRoleModels()
        const hasModelFlag = globalFlags.some(f => f.startsWith('--model'))
        if (!hasModelFlag && role && roleModels[role]) {
          globalFlags.push(`--model=${roleModels[role]}`)
        }

        // Tool scoping for resumed sessions
        const roleTools = getRoleTools()
        const rTools = roleTools[role]
        if (rTools && !globalFlags.some(f => f.startsWith('--tools'))) {
          globalFlags.push('--tools', rTools)
        }

        let agentPrompt: string | undefined
        if (instance.agent_id) {
          const agent = db.prepare('SELECT content FROM agents WHERE id = ?').get(instance.agent_id as string) as { content: string } | undefined
          agentPrompt = agent?.content
        }

        // Use lightweight resume prompt — agent already has context from prior session
        const prompt = this.buildPrompt(tasks, primaryTask, instance, folder, true)

        console.log(`[orchestrator] Resuming "${primaryTask.title as string}" → instance ${snap.instanceId} (--resume ${snap.sessionId}, model: ${roleModels[role] || 'default'})`)

        try {
          this.lastSendTime.set(snap.instanceId, Date.now())
          sendMessage({ instanceId: snap.instanceId, text: prompt, cwd, sessionId: snap.sessionId, flags: globalFlags, agentPrompt, mcpConfigPath: getMcpConfigPath(role) })
        } catch (err) {
          console.error(`[orchestrator] resumeStaleInstances sendMessage failed for ${snap.instanceId}:`, err)
          // Rollback: unlock tasks and reset instance to idle so triggerAll can reassign normally
          for (const t of tasks) {
            db.prepare('UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL WHERE id = ?').run(t.id)
          }
          db.prepare("UPDATE instances SET state = 'idle' WHERE id = ?").run(snap.instanceId)
          continue
        }

        broadcastEvent({ type: 'orchestrator:assigned', payload: { folderId: snap.folderId, instanceId: snap.instanceId, taskId: primaryTask.id as string, taskTitle: primaryTask.title as string } })
        broadcastEvent({ type: 'pipeline:updated', payload: { projectId: snap.folderId } })
      } catch (err) {
        console.error('[orchestrator] resumeStaleInstances error for', snap.instanceId, err)
      }
    }

    // Fresh assignments for any idle agents that had no in-progress work
    this.triggerAll()
  }

  // Trigger assignment for all active folders (used at startup)
  triggerAll(): void {
    try {
      const folders = db.prepare('SELECT * FROM folders WHERE orchestrator_active = 1').all() as Record<string, unknown>[]
      for (const folder of folders) {
        this.assignWork(folder.id as string)
      }
      console.log(`[orchestrator] triggerAll — checked ${folders.length} active folders`)
    } catch (err) {
      console.error('[orchestrator] triggerAll error:', err)
    }
  }
}

export const orchestrator = new OrchestratorService()
