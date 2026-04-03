import { db } from '../db.js'
import { sendMessage, type ProcessExitTokens } from './claude-process.js'
import { processRegistry } from './process-registry.js'
import { broadcastEvent } from '../ws/handler.js'
import { updateOverdriveOnComplete, resetOverdriveIfExpired } from './overdrive.js'
import { markScheduleRunning, appendExecution, updateScheduleAfterRun, safeJsonParse } from './task-manager.js'
import { emitOrcLog, getRoleModels, getRoleTools, getRoleEffort, getPermissionFlag, serverStartTime } from './orchestrator-utils.js'
import { getMcpConfigPath, AGENTS_DIR } from './mcp-config.js'
import { cloudSync } from './cloud-sync.js'
import type { PipelineTask, ScheduleExecution, OrcLogEntry } from '@orcstrator/shared'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

// Re-export for consumers that import from orchestrator.ts
export { getOrcLogs, serverStartTime } from './orchestrator-utils.js'

const LOCK_TIMEOUT_MS = 20 * 60 * 1000
const SEND_COOLDOWN_MS = 10 * 1000
const MIN_REASSIGN_INTERVAL_MS = 90 * 1000
const ARCHIVE_AGE_MS = 14 * 24 * 60 * 60 * 1000
const MAX_RETRIES = 3
const TICK_INTERVAL_MS = 10_000

const MASTER_PROMPTS_DIR = AGENTS_DIR

export interface ResumeSnapshot {
  instanceId: string
  sessionId: string
  folderId: string
  lockedTaskIds: string[]
}

// ── Process State Helpers ──

/** Map process_state to the backward-compatible 'state' column value */
function stateFromProcessState(ps: string): string {
  if (ps === 'idle' || ps === 'reserved') return 'idle'
  return 'running' // spawning, running, exiting → UI sees 'running'
}

/** Attempt a version-checked process_state transition. Returns false if rejected. */
function transitionProcessState(instanceId: string, from: string, to: string, extra?: Record<string, unknown>): boolean {
  const sets = ['process_state = ?', 'state = ?', 'version = version + 1']
  const params: unknown[] = [to, stateFromProcessState(to)]

  if (extra) {
    for (const [col, val] of Object.entries(extra)) {
      sets.push(`${col} = ?`)
      params.push(val)
    }
  }

  params.push(instanceId, from)
  const r = db.prepare(
    `UPDATE instances SET ${sets.join(', ')} WHERE id = ? AND process_state = ?`
  ).run(...params)

  if (r.changes === 0) {
    console.warn(`[orchestrator] State transition REJECTED: ${instanceId} ${from} → ${to}`)
    return false
  }
  return true
}

// ── Orchestrator Service ──

class OrchestratorService {
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private tickCounter = 0
  private tickRunning = false
  private startupLocked = true
  private pendingFolders = new Set<string>()

  start(): void {
    if (this.tickTimer) return
    this.tickTimer = setInterval(() => {
      this.tick().catch(err => console.error('[orchestrator] tick error:', err))
    }, TICK_INTERVAL_MS)
    // Run archive once after short delay
    setTimeout(() => {
      try { this.archiveSweep() } catch (err) { console.error('[orchestrator] archiveSweep startup error:', err) }
    }, 10_000)
    console.log('[orchestrator] Started — unified tick (10s)')
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  // ── Unified Tick Loop ──

  private async tick(): Promise<void> {
    if (this.tickRunning) return
    this.tickRunning = true
    this.tickCounter++
    try {
      // Phase 1: Zombie + adopted process detection (every tick = 10s)
      this.zombieAndAdoptedSweep()

      // Phase 2: Lock timeout sweep (every 12th tick ~2min)
      if (this.tickCounter % 12 === 0) this.timeoutSweep()

      // Phase 3: Assignment sweep (every 6th tick ~60s + pending folders)
      if (this.tickCounter % 6 === 0 || this.pendingFolders.size > 0) {
        await this.assignmentSweep()
      }

      // Phase 4: Archive sweep (every 2160th tick ~6h)
      if (this.tickCounter % 2160 === 0) this.archiveSweep()

      // Phase 5: Cloud sync (every tick — internally skips unchanged projects)
      try {
        await cloudSync.syncIfNeeded()
      } catch (err) {
        // Never block the tick loop for sync errors
        console.error('[orchestrator] Cloud sync error (non-fatal):', err)
      }

      // Phase 6: Full cloud sync (every 360th tick ~1h)
      if (this.tickCounter % 360 === 0) {
        cloudSync.fullSync().catch(err => {
          console.error('[orchestrator] Full cloud sync error (non-fatal):', err)
        })
      }
    } finally {
      this.tickRunning = false
    }
  }

  // ── Trigger: Immediate assignment for a folder ──

  triggerFolder(folderId: string): void {
    this.pendingFolders.add(folderId)
    if (!this.tickRunning) {
      this.tickRunning = true
      this.assignmentSweep()
        .catch(err => console.error('[orchestrator] assignmentSweep error:', err))
        .finally(() => { this.tickRunning = false })
    }
  }

  // ── Primary: Process Exit Handler ──

  onProcessExit(instanceId: string, tokens?: ProcessExitTokens): void {
    try {
      console.log(`[orchestrator] onProcessExit: instance ${instanceId} | tokens=${tokens ? `in=${tokens.inputTokens} out=${tokens.outputTokens} cost=$${tokens.costUsd}` : 'none'}`)
      const exitInst = db.prepare('SELECT name, is_scheduler_run, scheduler_context, assigned_task_ids, folder_id, agent_role FROM instances WHERE id = ?')
        .get(instanceId) as { name: string; is_scheduler_run: number; scheduler_context: string | null; assigned_task_ids: string | null; folder_id: string; agent_role: string | null } | undefined

      // Scheduler instance: handle via scheduler exit path
      if (exitInst?.is_scheduler_run) {
        const ctx = exitInst.scheduler_context ? safeJsonParse<{ taskId: string; runId: string; startedAt: number } | null>(exitInst.scheduler_context, null) : null
        if (ctx) {
          this.onSchedulerExit(instanceId, ctx.taskId, ctx.runId, ctx.startedAt)
        }
        // Reset scheduler state
        db.prepare(
          `UPDATE instances SET process_state = 'idle', state = 'idle', process_pid = NULL,
           assigned_task_ids = NULL, is_scheduler_run = 0, scheduler_context = NULL, version = version + 1
           WHERE id = ?`
        ).run(instanceId)
        broadcastEvent({ type: 'instance:state', payload: { instanceId, state: 'idle' } })
        this.pruneMessages(instanceId)
        return
      }

      // Read assigned task IDs from DB (not in-memory Map)
      const taskIds: string[] = exitInst?.assigned_task_ids ? safeJsonParse(exitInst.assigned_task_ids, []) : []

      // Auto-post the agent's last message as a comment and move the task to the next column
      // MUST run before accumulateTaskTokens
      if (taskIds.length > 0 && exitInst?.agent_role) {
        this.autoCommentAndMove(instanceId, taskIds, exitInst.agent_role)
      }

      // Accumulate tokens on the locked task + post spend comment
      if (tokens && (tokens.inputTokens > 0 || tokens.outputTokens > 0) && taskIds.length > 0) {
        this.accumulateTaskTokens(instanceId, tokens, taskIds)
      }

      // Release all task locks held by this instance — catches tasks where auto-move failed
      try {
        const lockedTasks = db.prepare(
          'SELECT id, title, retry_count, labels, history, project_id FROM pipeline_tasks WHERE locked_by = ?'
        ).all(instanceId) as Array<{ id: string; title: string; retry_count: number; labels: string; history: string; project_id: string }>

        for (const task of lockedTasks) {
          const newRetry = ((task.retry_count) || 0) + 1
          const now = Date.now()
          const history = safeJsonParse<Record<string, unknown>[]>(task.history, [])
          history.push({ action: 'lock_released', timestamp: now, agent: instanceId, note: 'process exited without moving task' })

          if (newRetry >= MAX_RETRIES) {
            let labels: string[]
            try { labels = JSON.parse(task.labels || '[]') } catch { labels = [] }
            if (!labels.includes('stuck')) labels.push('stuck')
            history.push({ action: 'moved', timestamp: now, from: 'current', to: 'in_review', note: `${MAX_RETRIES} failures - stuck, needs human` })
            db.prepare(
              `UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL, retry_count = ?, "column" = 'in_review',
               labels = ?, history = ?, lock_version = lock_version + 1, version = version + 1, updated_at = ? WHERE id = ?`
            ).run(newRetry, JSON.stringify(labels), JSON.stringify(history), now, task.id)
            console.warn(`[orchestrator] Task "${task.title}" failed ${newRetry}x — moved to in_review as stuck`)
            emitOrcLog({ type: 'task_stuck', instanceId, instanceName: exitInst?.name, agentRole: exitInst?.agent_role || undefined, taskId: task.id, taskTitle: task.title, detail: `${newRetry} failures — moved to in_review` })
            broadcastEvent({ type: 'orchestrator:lock-released', payload: { taskId: task.id, reason: 'max-retries-stuck' } })
            broadcastEvent({ type: 'pipeline:updated', payload: { projectId: task.project_id } })
          } else {
            db.prepare(
              `UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL, retry_count = ?,
               history = ?, lock_version = lock_version + 1, version = version + 1, updated_at = ? WHERE id = ?`
            ).run(newRetry, JSON.stringify(history), now, task.id)
            console.log(`[orchestrator] Released lock on "${task.title}" (retry ${newRetry}/${MAX_RETRIES})`)
          }
        }
      } catch (err) {
        console.error('[orchestrator] lock release error:', err)
      }

      // Transition instance to idle (final state)
      db.prepare(
        `UPDATE instances SET process_state = 'idle', state = 'idle', process_pid = NULL,
         assigned_task_ids = NULL, is_scheduler_run = 0, scheduler_context = NULL, version = version + 1
         WHERE id = ?`
      ).run(instanceId)
      broadcastEvent({ type: 'instance:state', payload: { instanceId, state: 'idle' } })

      // Trigger re-assignment
      try {
        if (exitInst?.agent_role) {
          const folder = db.prepare('SELECT orchestrator_active FROM folders WHERE id = ?').get(exitInst.folder_id) as { orchestrator_active: number } | undefined
          if (folder?.orchestrator_active) {
            this.triggerFolder(exitInst.folder_id)
          }
        }
      } catch (err) {
        console.error('[orchestrator] onProcessExit trigger error:', err)
      }

      this.pruneMessages(instanceId)
      updateOverdriveOnComplete(instanceId)
      updateDevLock()
    } catch (err) {
      console.error(`[orchestrator] onProcessExit FATAL error for ${instanceId}:`, err)
      // Last-resort: ensure instance goes idle even if everything else failed
      try {
        db.prepare("UPDATE instances SET process_state = 'idle', state = 'idle', process_pid = NULL, version = version + 1 WHERE id = ?").run(instanceId)
        broadcastEvent({ type: 'instance:state', payload: { instanceId, state: 'idle' } })
      } catch { /* truly nothing we can do */ }
    }
  }

  // ── Auto Comment & Move ──

  private autoCommentAndMove(instanceId: string, taskIds: string[], role: string): void {
    try {
      if (role === 'scheduler') return

      // Get last assistant text message
      const lastMsg = db.prepare(
        'SELECT content FROM messages WHERE instance_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1'
      ).get(instanceId, 'assistant') as { content: string } | undefined

      let commentText = ''
      if (lastMsg?.content) {
        try {
          const blocks = JSON.parse(lastMsg.content) as Array<{ type: string; text?: string }>
          commentText = blocks
            .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
            .map((b: { type: string; text?: string }) => b.text!)
            .join('\n')
            .trim()
        } catch {
          if (typeof lastMsg.content === 'string') {
            commentText = lastMsg.content.trim()
          }
        }
      }

      const isFailure = commentText.includes('[ACTION NEEDED]')

      for (const taskId of taskIds) {
        const task = db.prepare('SELECT id, title, locked_by, "column" as col, history, project_id, pipeline_id, current_step, total_steps, current_step_role FROM pipeline_tasks WHERE id = ?')
          .get(taskId) as { id: string; title: string; locked_by: string | null; col: string; history: string; project_id: string; pipeline_id: string | null; current_step: number; total_steps: number; current_step_role: string | null } | undefined
        if (!task || task.locked_by !== instanceId) continue

        const now = Date.now()

        if (commentText) {
          const commentId = crypto.randomUUID()
          db.prepare(
            'INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)'
          ).run(commentId, taskId, role, commentText, now)
          console.log(`[orchestrator] Auto-posted comment for task ${taskId} by ${role}`)
        }

        let targetColumn: string
        let newStep = task.current_step
        let newStepRole: string | null = task.current_step_role
        let completedAt: number | null = null

        if (isFailure) {
          targetColumn = 'in_review'
          let labels: string[]
          try {
            const labelsRow = db.prepare('SELECT labels FROM pipeline_tasks WHERE id = ?').get(taskId) as { labels: string }
            labels = JSON.parse(labelsRow.labels || '[]')
          } catch { labels = [] }
          if (!labels.includes('stuck')) labels.push('stuck')

          const history = safeJsonParse<Record<string, unknown>[]>(task.history, [])
          history.push({ action: 'moved', timestamp: now, agent: role, from: task.col, to: targetColumn, note: 'ACTION NEEDED — stuck' })
          db.prepare(`
            UPDATE pipeline_tasks SET "column" = ?, labels = ?, history = ?, updated_at = ?,
              locked_by = NULL, locked_at = NULL, retry_count = 0,
              lock_version = lock_version + 1, version = version + 1
            WHERE id = ?
          `).run(targetColumn, JSON.stringify(labels), JSON.stringify(history), now, taskId)
        } else {
          if (task.current_step >= task.total_steps) {
            targetColumn = 'done'
            completedAt = now
          } else {
            targetColumn = 'in_progress'
            newStep = task.current_step + 1
            if (task.pipeline_id) {
              const bp = db.prepare('SELECT steps FROM pipeline_blueprints WHERE id = ?').get(task.pipeline_id) as { steps: string } | undefined
              if (bp) {
                const steps = JSON.parse(bp.steps) as Array<{ role: string }>
                newStepRole = steps[newStep - 1]?.role || null
              }
            }
          }

          const history = safeJsonParse<Record<string, unknown>[]>(task.history, [])
          history.push({ action: 'moved', timestamp: now, agent: role, from: task.col, to: targetColumn })
          db.prepare(`
            UPDATE pipeline_tasks SET "column" = ?, current_step = ?, current_step_role = ?, history = ?, updated_at = ?,
              completed_at = COALESCE(?, completed_at), locked_by = NULL, locked_at = NULL, retry_count = 0,
              lock_version = lock_version + 1, version = version + 1
            WHERE id = ?
          `).run(targetColumn, newStep, newStepRole, JSON.stringify(history), now, completedAt, taskId)
        }

        const logTarget = isFailure ? `${targetColumn} (stuck)` : targetColumn === 'done' ? 'done' : `${targetColumn} step ${newStep}/${task.total_steps}`
        console.log(`[orchestrator] Auto-moved task ${taskId}: ${task.col} → ${logTarget} (${role})`)
        const movedInst = db.prepare('SELECT name FROM instances WHERE id = ?').get(instanceId) as { name: string } | undefined
        const moveType = targetColumn === 'done' ? 'process_exited' : 'task_moved'
        emitOrcLog({ type: moveType, instanceId, instanceName: movedInst?.name, agentRole: role, taskId, taskTitle: task.title })
        broadcastEvent({ type: 'pipeline:updated', payload: { projectId: task.project_id } })

        setImmediate(() => {
          this.triggerFolder(task.project_id)
        })
      }
    } catch (err) {
      console.error('[orchestrator] autoCommentAndMove error:', err)
    }
  }

  private accumulateTaskTokens(instanceId: string, tokens: ProcessExitTokens, taskIds: string[]): void {
    try {
      const placeholders = taskIds.map(() => '?').join(',')
      const tasks = db.prepare(
        `SELECT id, title, project_id, total_input_tokens, total_output_tokens, total_cost_usd FROM pipeline_tasks WHERE id IN (${placeholders})`
      ).all(...taskIds) as Array<{ id: string; title: string; project_id: string; total_input_tokens: number; total_output_tokens: number; total_cost_usd: number }>

      if (tasks.length === 0) return

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

  // ── Assignment Sweep ──

  private async assignmentSweep(): Promise<void> {
    if (this.startupLocked) return

    // Collect folders to check: pending triggers + all active folders on schedule
    const folderIds = new Set<string>(this.pendingFolders)
    this.pendingFolders.clear()

    try {
      const activeFolders = db.prepare('SELECT id FROM folders WHERE orchestrator_active = 1').all() as { id: string }[]
      for (const f of activeFolders) folderIds.add(f.id)
    } catch { /* ignore */ }

    if (folderIds.size === 0) return

    for (const folderId of folderIds) {
      try {
        await this.assignWork(folderId)
      } catch (err) {
        console.error(`[orchestrator] assignWork error for folder ${folderId}:`, err)
      }
    }
  }

  // ── Zombie + Adopted Process Detection ──

  private zombieAndAdoptedSweep(): void {
    try {
      // Find instances marked 'running' in DB with no tracked ChildProcess
      const running = db.prepare(
        "SELECT id, process_pid, name FROM instances WHERE process_state = 'running'"
      ).all() as Array<{ id: string; process_pid: number | null; name: string }>

      for (const inst of running) {
        if (processRegistry.isTracked(inst.id)) continue // Has a live ChildProcess handle

        // Not tracked: either adopted from previous run, or zombie
        if (inst.process_pid && isProcessAliveCheck(inst.process_pid)) {
          // Still alive — adopted process from previous server run, leave it
          continue
        }

        // Dead: reset to idle, release locks
        console.warn(`[orchestrator] ZOMBIE/ADOPTED DEAD: instance ${inst.id} (${inst.name}) — running in DB but no live process`)
        emitOrcLog({ type: 'zombie_detected', instanceId: inst.id, instanceName: inst.name, detail: 'running in DB but no tracked/alive process' })

        db.transaction(() => {
          db.prepare(
            `UPDATE instances SET process_state = 'idle', state = 'idle', process_pid = NULL,
             assigned_task_ids = NULL, is_scheduler_run = 0, scheduler_context = NULL, version = version + 1
             WHERE id = ?`
          ).run(inst.id)

          const locked = db.prepare('SELECT id, history, project_id FROM pipeline_tasks WHERE locked_by = ?')
            .all(inst.id) as Array<{ id: string; history: string; project_id: string }>
          for (const task of locked) {
            const history = safeJsonParse<Record<string, unknown>[]>(task.history, [])
            history.push({ action: 'lock_released', timestamp: Date.now(), note: 'zombie/adopted process — no live process' })
            db.prepare(
              'UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL, lock_version = lock_version + 1, version = version + 1, history = ? WHERE id = ?'
            ).run(JSON.stringify(history), task.id)
            broadcastEvent({ type: 'pipeline:updated', payload: { projectId: task.project_id } })
          }
        })()

        broadcastEvent({ type: 'instance:state', payload: { instanceId: inst.id, state: 'idle' } })
      }
    } catch (err) {
      console.error('[orchestrator] zombieAndAdoptedSweep error:', err)
    }
  }

  // ── Lock Timeout Sweep ──

  private timeoutSweep(): void {
    try {
      const cutoff = Date.now() - LOCK_TIMEOUT_MS
      const lockedTasks = db.prepare(`
        SELECT pt.*, i.process_state as inst_process_state, i.agent_role as instance_role, i.is_scheduler_run
        FROM pipeline_tasks pt
        LEFT JOIN instances i ON pt.locked_by = i.id
        WHERE pt.locked_by IS NOT NULL
          AND pt.locked_at < ?
          AND (i.process_state IS NULL OR i.process_state NOT IN ('running', 'spawning'))
      `).all(cutoff) as Record<string, unknown>[]

      if (lockedTasks.length === 0) return
      console.log(`[orchestrator] timeout sweep — ${lockedTasks.length} expired lock(s)`)

      const groupedTasks = new Map<string, Record<string, unknown>[]>()
      for (const task of lockedTasks) {
        const key = (task.group_id as string) || (task.id as string)
        const group = groupedTasks.get(key) || []
        group.push(task)
        groupedTasks.set(key, group)
      }

      for (const [, tasks] of groupedTasks) {
        const rep = tasks[0]

        // Scheduler tasks are exempt from kill timeout
        if ((rep.instance_role as string) === 'scheduler' || rep.is_scheduler_run) continue

        // Task locked before this server boot — not agent's fault
        const lockedBeforeStart = (rep.locked_at as number) < serverStartTime
        if (lockedBeforeStart) {
          for (const t of tasks) {
            const history = safeJsonParse<Record<string, unknown>[]>(t.history as string, [])
            history.push({ action: 'lock_released', timestamp: Date.now(), note: 'server was offline — timeout not counted as agent failure' })
            db.prepare(`UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL, lock_version = lock_version + 1, version = version + 1, history = ?, updated_at = ? WHERE id = ?`)
              .run(JSON.stringify(history), Date.now(), t.id)
          }
          emitOrcLog({ type: 'lock_timeout', instanceId: rep.locked_by as string, taskId: rep.id as string, taskTitle: rep.title as string, detail: 'server was offline — lock released without penalty' })
          broadcastEvent({ type: 'orchestrator:lock-released', payload: { taskId: rep.id, reason: 'server-restart' } })
          if (rep.project_id) broadcastEvent({ type: 'pipeline:updated', payload: { projectId: rep.project_id } })
          continue
        }

        const newRetryCount = ((rep.retry_count as number) || 0) + 1

        if (newRetryCount >= MAX_RETRIES) {
          for (const t of tasks) {
            const history = safeJsonParse<Record<string, unknown>[]>(t.history as string, [])
            history.push({ action: 'moved', timestamp: Date.now(), from: t.column, to: 'in_review', note: '3 failures — stuck, needs a human' })
            let labels: string[]
            try { labels = JSON.parse((t.labels as string) || '[]') } catch { labels = [] }
            if (!labels.includes('stuck')) labels.push('stuck')
            db.prepare(`UPDATE pipeline_tasks SET "column" = 'in_review', labels = ?, locked_by = NULL, locked_at = NULL, retry_count = ?, lock_version = lock_version + 1, version = version + 1, history = ?, updated_at = ? WHERE id = ?`)
              .run(JSON.stringify(labels), newRetryCount, JSON.stringify(history), Date.now(), t.id)
          }
          emitOrcLog({ type: 'lock_timeout', instanceId: rep.locked_by as string, taskId: rep.id as string, taskTitle: rep.title as string, detail: `${newRetryCount} failures — moved to in_review as stuck` })
          broadcastEvent({ type: 'orchestrator:lock-released', payload: { taskId: rep.id, reason: 'max-retries-stuck' } })
        } else {
          for (const t of tasks) {
            const history = safeJsonParse<Record<string, unknown>[]>(t.history as string, [])
            history.push({ action: 'lock_released', timestamp: Date.now(), note: 'timeout after 20min — the agent ghosted us' })
            db.prepare(`UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL, retry_count = ?, lock_version = lock_version + 1, version = version + 1, history = ?, updated_at = ? WHERE id = ?`)
              .run(newRetryCount, JSON.stringify(history), Date.now(), t.id)
          }
          emitOrcLog({ type: 'lock_timeout', instanceId: rep.locked_by as string, taskId: rep.id as string, taskTitle: rep.title as string, detail: `timeout after 20min — retry ${newRetryCount}/${MAX_RETRIES}` })
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

  // ── Archive Sweep ──

  private archiveSweep(): void {
    try {
      const cutoff = Date.now() - ARCHIVE_AGE_MS
      const archiveTx = db.transaction(() => {
        const deletedComments = db.prepare(`
          DELETE FROM task_comments WHERE task_id IN (
            SELECT id FROM pipeline_tasks WHERE "column" = 'done' AND completed_at < ?
          )
        `).run(cutoff).changes
        const deletedTasks = db.prepare(`
          DELETE FROM pipeline_tasks WHERE "column" = 'done' AND completed_at < ?
        `).run(cutoff).changes
        const deletedUsage = db.prepare(`
          DELETE FROM token_usage WHERE task_id IS NOT NULL AND task_id NOT IN (
            SELECT id FROM pipeline_tasks
          )
        `).run().changes
        return { deletedComments, deletedTasks, deletedUsage }
      })
      const { deletedComments, deletedTasks, deletedUsage } = archiveTx()
      if (deletedComments || deletedTasks || deletedUsage) {
        console.log(`[orchestrator] Archive sweep: ${deletedTasks} tasks, ${deletedComments} comments, ${deletedUsage} token_usage rows purged`)
        try { db.pragma('incremental_vacuum') } catch { /* non-critical */ }
      }
    } catch (err) {
      console.error('[orchestrator] archiveSweep error:', err)
    }
  }

  // ── Message Pruning ──

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

  unlockStartup(): void {
    this.startupLocked = false
    console.log('[orchestrator] Startup lock released — assignments enabled')
  }

  // ── Core Assignment Logic ──

  private async assignWork(folderId: string): Promise<void> {
    if (this.startupLocked) return

    const instances = db.prepare(`
      SELECT * FROM instances
      WHERE folder_id = ? AND process_state = 'idle' AND agent_role IS NOT NULL
        AND orchestrator_managed = 1
    `).all(folderId) as Record<string, unknown>[]

    if (instances.length === 0) {
      emitOrcLog({ type: 'no_idle_agents', detail: `folder=${folderId.slice(0, 8)}` })
      return
    }

    console.log(`[orchestrator] assignWork: ${instances.length} idle agent(s) in folder ${folderId}: ${instances.map(i => `${i.name}(${i.agent_role})`).join(', ')}`)

    // Smart assignment: prefer agents with warm sessions
    const CACHE_TTL_MS = 60 * 60 * 1000
    const now = Date.now()
    instances.sort((a, b) => {
      const aWarm = a.session_id && a.last_task_at && (now - (a.last_task_at as number)) < CACHE_TTL_MS ? 1 : 0
      const bWarm = b.session_id && b.last_task_at && (now - (b.last_task_at as number)) < CACHE_TTL_MS ? 1 : 0
      return bWarm - aWarm
    })

    // Auto-assign default blueprint to ready tasks without one
    this.autoAssignDefaultBlueprint(folderId)

    const cooldownThreshold = now - MIN_REASSIGN_INTERVAL_MS
    const allTasks = db.prepare(`
      SELECT * FROM pipeline_tasks
      WHERE project_id = ? AND "column" IN ('ready', 'in_progress')
        AND locked_by IS NULL
        AND labels NOT LIKE '%stuck%' AND labels NOT LIKE '%blocked%' AND labels NOT LIKE '%paused%'
        AND (last_assigned_at IS NULL OR last_assigned_at < ?)
      ORDER BY priority ASC, created_at ASC
    `).all(folderId, cooldownThreshold) as Record<string, unknown>[]

    const claimedTaskIds = new Set<string>()

    for (const instance of instances) {
      const role = instance.agent_role as string
      if (role === 'scheduler') continue

      // Cooldown check: use reserved_at from DB
      const reservedAt = instance.reserved_at as number | null
      if (reservedAt && now - reservedAt < SEND_COOLDOWN_MS) {
        console.warn(`[orchestrator] COOLDOWN: Skipping send to ${instance.id} (${((now - reservedAt) / 1000).toFixed(1)}s since last send)`)
        emitOrcLog({ type: 'cooldown_hit', instanceId: instance.id as string, instanceName: instance.name as string, detail: `${((now - reservedAt) / 1000).toFixed(1)}s since last send` })
        continue
      }

      const task = this.matchTaskForRole(role, allTasks, claimedTaskIds)
      if (!task) continue

      claimedTaskIds.add(task.id as string)
      if (task.group_id && (task.group_id as string) !== '' && role === 'builder') {
        for (const t of allTasks) {
          if (t.group_id === task.group_id) claimedTaskIds.add(t.id as string)
        }
      }

      console.log(`[orchestrator] assignWork: found task "${task.title}" (${task.id}) for ${instance.name}(${role})`)
      await this.assignTaskToInstance(task, instance, folderId)
    }

    this.broadcastStatus(folderId)
  }

  private matchTaskForRole(role: string, allTasks: Record<string, unknown>[], claimed: Set<string>): Record<string, unknown> | undefined {
    const roleTasks = allTasks.filter(t =>
      t.current_step_role === role && !claimed.has(t.id as string)
    )

    if (role === 'builder') {
      const bundleTask = roleTasks.find(t => t.group_id && (t.group_id as string) !== '')
      if (bundleTask) {
        const locked = db.prepare(`SELECT COUNT(*) as count FROM pipeline_tasks WHERE group_id = ? AND locked_by IS NOT NULL`)
          .get(bundleTask.group_id as string) as { count: number }
        if (locked.count === 0) return bundleTask
      }
      return roleTasks.find(t => !t.group_id || (t.group_id as string) === '')
    }

    return roleTasks[0]
  }

  private autoAssignDefaultBlueprint(folderId: string): void {
    const tasksWithoutPipeline = db.prepare(
      "SELECT id FROM pipeline_tasks WHERE project_id = ? AND \"column\" = 'ready' AND pipeline_id IS NULL"
    ).all(folderId) as Array<{ id: string }>

    if (tasksWithoutPipeline.length === 0) return

    const defaultBp = db.prepare("SELECT id, steps FROM pipeline_blueprints WHERE is_default = 1 LIMIT 1").get() as { id: string; steps: string } | undefined
    if (!defaultBp) return

    const steps = JSON.parse(defaultBp.steps) as Array<{ role: string }>
    const totalSteps = steps.length
    const firstRole = steps[0]?.role || null

    for (const task of tasksWithoutPipeline) {
      db.prepare(
        'UPDATE pipeline_tasks SET pipeline_id = ?, current_step = 1, total_steps = ?, current_step_role = ? WHERE id = ?'
      ).run(defaultBp.id, totalSteps, firstRole, task.id)
    }
  }

  // ── Transactional Reserve + Assign ──

  private async assignTaskToInstance(task: Record<string, unknown>, instance: Record<string, unknown>, folderId: string): Promise<void> {
    const instanceId = instance.id as string
    const role = instance.agent_role as string
    const now = Date.now()

    // Concurrency limit check (DB-based)
    if (!processRegistry.canSpawn()) {
      console.warn(`[orchestrator] CONCURRENCY LIMIT: Skipping spawn for ${instanceId}`)
      emitOrcLog({ type: 'concurrency_limit', instanceId, instanceName: instance.name as string, taskId: task.id as string, taskTitle: task.title as string, detail: `registry full (active=${processRegistry.getActiveCount()})` })
      return
    }

    // If task is in 'ready', move it to 'in_progress' as part of the lock
    const finalColumn = (task.column as string) === 'ready' ? 'in_progress' : (task.column as string)

    // Collect bundle tasks
    let tasksToLock: Record<string, unknown>[] = [task]
    if (task.group_id && (task.group_id as string) !== '' && role === 'builder') {
      tasksToLock = db.prepare(`SELECT * FROM pipeline_tasks WHERE group_id = ? ORDER BY group_index ASC`)
        .all(task.group_id as string) as Record<string, unknown>[]
      if (tasksToLock.length === 0) tasksToLock = [task]
    }

    const taskIds = tasksToLock.map(t => t.id as string)

    // Transactional reserve: lock tasks + transition instance to 'reserved' atomically
    const reserved = db.transaction(() => {
      for (const t of tasksToLock) {
        const history = safeJsonParse<Record<string, unknown>[]>(t.history as string, [])
        history.push({ action: 'assigned', timestamp: now, agent: instanceId })
        const result = db.prepare(
          `UPDATE pipeline_tasks SET locked_by = ?, locked_at = ?, "column" = ?, history = ?, updated_at = ?, last_assigned_at = ?,
           lock_version = lock_version + 1, version = version + 1
           WHERE id = ? AND locked_by IS NULL`
        ).run(instanceId, now, finalColumn, JSON.stringify(history), now, now, t.id)
        if (result.changes === 0) return null // task already locked
      }

      // Transition: idle → reserved
      const ir = db.prepare(
        `UPDATE instances SET process_state = 'reserved', state = 'idle', reserved_at = ?,
         assigned_task_ids = ?, version = version + 1
         WHERE id = ? AND process_state = 'idle'`
      ).run(now, JSON.stringify(taskIds), instanceId)
      if (ir.changes === 0) return null // instance not idle

      return true
    })()

    if (!reserved) {
      console.warn(`[orchestrator] Reserve FAILED: task ${task.id as string} already locked or instance ${instanceId} not idle`)
      return
    }

    console.log(`[orchestrator] Reserved: ${instanceId.slice(0, 8)} → tasks [${taskIds.map(id => id.slice(0, 8)).join(', ')}]`)

    // Build prompt
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Record<string, unknown> | undefined
    if (!folder) {
      console.error(`[orchestrator] assignTaskToInstance: folder not found: ${folderId}`)
      return
    }
    const prompt = this.buildPrompt(tasksToLock, task, instance, folder)

    const cwd = (instance.cwd as string) || (folder.path as string)
    const sessionId = (instance.session_id as string) || undefined

    const flagRows = db.prepare("SELECT value FROM settings WHERE key = 'globalFlags'").get() as { value: string } | undefined
    const globalFlags: string[] = flagRows ? JSON.parse(flagRows.value) : []

    const retryCount = (task.retry_count as number) || 0

    // Permission mode — strip any existing dangerously-skip-permissions from globalFlags and apply from settings
    if (!globalFlags.some(f => f.startsWith('--permission-mode') || f === '--dangerously-skip-permissions')) {
      globalFlags.push(getPermissionFlag())
    }

    const roleModels = getRoleModels()
    const model = retryCount > 0 ? 'opus' : roleModels[role]
    const hasModelFlag = globalFlags.some(f => f.startsWith('--model'))
    if (!hasModelFlag && model) globalFlags.push(`--model=${model}`)

    const roleTools = getRoleTools()
    const tools = roleTools[role]
    if (tools && !globalFlags.some(f => f.startsWith('--tools'))) globalFlags.push('--tools', tools)

    // Effort level per role
    const roleEffort = getRoleEffort()
    const effort = roleEffort[role]
    if (effort && !globalFlags.some(f => f.startsWith('--effort'))) globalFlags.push(`--effort=${effort}`)

    try {
      const cacheRow = db.prepare("SELECT value FROM settings WHERE key = 'disableCache'").get() as { value: string } | undefined
      if (cacheRow && JSON.parse(cacheRow.value) === true && !globalFlags.includes('--no-cache')) globalFlags.push('--no-cache')
    } catch { /* ignore */ }

    try {
      const maxRow = db.prepare("SELECT value FROM settings WHERE key = 'maxTokens'").get() as { value: string } | undefined
      if (maxRow) {
        const maxTokens = JSON.parse(maxRow.value) as number
        if (maxTokens > 0 && !globalFlags.some(f => f.startsWith('--max-tokens'))) globalFlags.push(`--max-tokens=${maxTokens}`)
      }
    } catch { /* ignore */ }

    try {
      const budgetRow = db.prepare("SELECT value FROM settings WHERE key = 'maxBudgetUsd'").get() as { value: string } | undefined
      if (budgetRow) {
        const budget = JSON.parse(budgetRow.value) as number
        if (budget > 0 && !globalFlags.some(f => f.startsWith('--max-budget-usd'))) globalFlags.push(`--max-budget-usd=${budget}`)
      }
    } catch { /* ignore */ }

    try {
      const fallbackRow = db.prepare("SELECT value FROM settings WHERE key = 'fallbackModel'").get() as { value: string } | undefined
      if (fallbackRow) {
        const fm = JSON.parse(fallbackRow.value) as string
        if (fm && fm !== 'default' && !globalFlags.some(f => f.startsWith('--fallback-model'))) globalFlags.push(`--fallback-model=${fm}`)
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

    // Save orchestrator prompt as a user message
    const msgId = crypto.randomUUID()
    const msgContent: Array<Record<string, unknown>> = [
      { type: 'orc-brief', taskTitle: task.title as string, taskId: task.id as string, instanceName: instance.name as string, projectId: folderId },
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

    // Prune old messages
    this.pruneOldMessages(instanceId)

    // Spawn the process
    try {
      await sendMessage({ instanceId, text: prompt, images: taskImages, cwd, sessionId, flags: globalFlags, agentPrompt, mcpConfigPath: getMcpConfigPath(role), compact: !!sessionId })
    } catch (err) {
      console.error(`[orchestrator] sendMessage failed for ${instanceId}:`, err)
      emitOrcLog({ type: 'spawn_failed', instanceId, instanceName: instance.name as string, taskId: task.id as string, taskTitle: task.title as string, detail: String(err) })
      // Rollback reservation
      this.rollbackReservation(instanceId, taskIds)
      return
    }

    emitOrcLog({ type: 'assigned', instanceId, instanceName: instance.name as string, taskId: task.id as string, taskTitle: task.title as string, detail: `role=${role} model=${roleModels[role] || 'default'}` })
    broadcastEvent({ type: 'orchestrator:assigned', payload: { folderId, instanceId, taskId: task.id as string, taskTitle: task.title as string } })
    broadcastEvent({ type: 'pipeline:updated', payload: { projectId: folderId } })
    updateDevLock()
  }

  // ── Rollback: undo a failed reservation ──

  private rollbackReservation(instanceId: string, taskIds: string[]): void {
    db.transaction(() => {
      for (const taskId of taskIds) {
        db.prepare(
          `UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL,
           lock_version = lock_version + 1, version = version + 1
           WHERE id = ? AND locked_by = ?`
        ).run(taskId, instanceId)
      }
      db.prepare(
        `UPDATE instances SET process_state = 'idle', state = 'idle', assigned_task_ids = NULL,
         version = version + 1
         WHERE id = ? AND process_state IN ('reserved', 'spawning')`
      ).run(instanceId)
    })()
    broadcastEvent({ type: 'instance:state', payload: { instanceId, state: 'idle' } })
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
          db.prepare('DELETE FROM messages WHERE instance_id = ? AND created_at < ?')
            .run(instanceId, cutoffRow.created_at)
        }
      }
    } catch (err) {
      console.error('[orchestrator] pruneOldMessages error:', err)
    }
  }

  // ── Prompt Building ──

  private buildPrompt(tasksToLock: Record<string, unknown>[], primaryTask: Record<string, unknown>, instance: Record<string, unknown>, folder: Record<string, unknown>, isResume = false): string {
    const role = instance.agent_role as string
    const projectId = folder.id as string
    const taskId = primaryTask.id as string
    const instanceCwd = (instance.cwd as string) || (folder.path as string)

    if (isResume) {
      const resumeObj = {
        type: 'resume',
        task: { id: taskId, title: primaryTask.title as string, column: primaryTask.column as string, priority: primaryTask.priority as number },
        instruction: `You were working on this task before. Resume where you left off. Write a short summary as your final message, then exit. The server will post it as a comment and move the task automatically.`
      }
      return JSON.stringify(resumeObj, null, 2)
    }

    const masterPrompt = this.loadMasterPrompt(role)
    const skills = this.loadInstanceSkills(instance)
    const isBundle = tasksToLock.length > 1

    const MAX_DESC_CHARS = 5000
    let description = (primaryTask.description as string) || ''
    if (description.length > MAX_DESC_CHARS) {
      description = description.slice(0, MAX_DESC_CHARS) + '\n\n[... description truncated at 5000 chars — read the full spec from task comments or source files if needed]'
    }

    const currentStep = (primaryTask.current_step as number) || 1
    const totalSteps = (primaryTask.total_steps as number) || 1
    const stepRole = (primaryTask.current_step_role as string) || role

    const taskObj: Record<string, unknown> = {
      id: taskId,
      projectId,
      title: primaryTask.title as string,
      priority: primaryTask.priority as number,
      column: primaryTask.column as string,
      description,
    }
    if (totalSteps > 1) {
      taskObj.step = currentStep
      taskObj.totalSteps = totalSteps
      taskObj.stepRole = stepRole
    }

    const assignment: Record<string, unknown> = {
      scope: instanceCwd,
      role,
      task: taskObj,
      rules: [
        'Only access files under scope directory.',
        'Write a short summary (1-3 sentences) as your final message before exiting. The server will post it as a task comment automatically.',
      ],
    }

    const stepInstructions = primaryTask.step_instructions ? JSON.parse((primaryTask.step_instructions as string) || '{}') : {}
    const taskStepInstruction = stepInstructions[String(currentStep)]
    let blueprintStepInstruction: string | undefined
    if (primaryTask.pipeline_id) {
      const bp = db.prepare('SELECT steps FROM pipeline_blueprints WHERE id = ?').get(primaryTask.pipeline_id as string) as { steps: string } | undefined
      if (bp) {
        const steps = JSON.parse(bp.steps) as Array<{ role: string; instruction?: string }>
        blueprintStepInstruction = steps[currentStep - 1]?.instruction
      }
    }
    const stepInstruction = taskStepInstruction || blueprintStepInstruction
    if (stepInstruction) assignment.stepInstruction = stepInstruction

    if (role === 'planner') {
      assignment.api = {
        updateTask: `PUT http://localhost:3333/api/pipelines/${projectId}/tasks/${taskId}  body: {"title":"...","description":"..."}`,
      }
    }

    if (description) {
      try {
        const spec = JSON.parse(description)
        if (spec.frontend?.files && Array.isArray(spec.frontend.files)) {
          assignment.filesToModify = spec.frontend.files
        }
      } catch { /* not JSON */ }
    }

    const rawAttachments = JSON.parse((primaryTask.attachments as string) || '[]') as Array<{ name: string }>
    if (rawAttachments.length > 0) assignment.attachments = `${rawAttachments.length} screenshot(s) included with this message.`

    const dependsOn = JSON.parse((primaryTask.depends_on as string) || '[]') as string[]
    if (dependsOn.length > 0) assignment.prerequisites = dependsOn

    const priorComments = this.loadTaskComments(taskId)
    if (priorComments) assignment.priorComments = priorComments

    if (isBundle) {
      assignment.bundle = tasksToLock.map(t => ({
        index: t.group_index,
        total: t.group_total,
        title: t.title as string,
      }))
    }

    const parts: string[] = []
    if (masterPrompt) { parts.push(masterPrompt); parts.push('') }
    if (skills.length > 0) {
      for (const skill of skills) {
        parts.push(`### Skill: ${skill.name}`)
        parts.push(skill.content)
      }
      parts.push('')
    }
    parts.push('## ASSIGNMENT')
    parts.push('```json')
    parts.push(JSON.stringify(assignment, null, 2))
    parts.push('```')

    const prompt = parts.join('\n')
    const promptChars = prompt.length

    // Persist prompt size for monitoring
    try {
      db.prepare(
        'INSERT INTO token_usage (instance_id, role, task_id, prompt_chars, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(instance.id as string, role, taskId, promptChars, Date.now())
    } catch (err) {
      console.error(`[orchestrator] token_usage INSERT failed for task ${taskId}:`, err)
    }

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
      const rows = db.prepare(
        'SELECT author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 10'
      ).all(taskId) as Array<{ author: string; body: string; created_at: number }>
      if (rows.length === 0) return ''

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

  // ── Scheduler Task Dispatch ──

  async triggerScheduledTask(task: PipelineTask): Promise<void> {
    try {
      const folderId = task.projectId
      const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Record<string, unknown>
      if (!folder) return

      markScheduleRunning(task.id, true)

      const now = Date.now()
      const runId = crypto.randomUUID()

      const masterPrompt = this.loadMasterPrompt('scheduler')
      const skillContent = task.skill ? this.loadSkillByName(task.skill) : null

      const MAX_DESC_CHARS = 5000
      let description = task.description || ''
      if (description.length > MAX_DESC_CHARS) description = description.slice(0, MAX_DESC_CHARS) + '\n\n[... truncated]'

      const assignment = {
        role: 'scheduler',
        task: { id: task.id, projectId: folderId, title: task.title, description, skill: task.skill ?? null },
        rules: [
          'Do not move this task to another column.',
          'Write a short summary (1-2 sentences) as your final message before exiting. The server will post it as a task comment automatically.',
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

      // Find or create a scheduler instance
      let schedulerInstance = db.prepare(
        "SELECT * FROM instances WHERE folder_id = ? AND agent_role = 'scheduler' AND process_state = 'idle' LIMIT 1"
      ).get(folderId) as Record<string, unknown> | undefined

      let instanceId: string
      if (schedulerInstance) {
        instanceId = schedulerInstance.id as string
      } else {
        instanceId = crypto.randomUUID()
        db.prepare(`
          INSERT INTO instances (id, folder_id, name, cwd, state, process_state, agent_role, orchestrator_managed, sort_order, created_at, version)
          VALUES (?, ?, 'Chrono', ?, 'idle', 'idle', 'scheduler', 1, 999, ?, 1)
        `).run(instanceId, folderId, (folder.path as string) || '', now)
        schedulerInstance = db.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId) as Record<string, unknown>
      }

      if (!processRegistry.canSpawn()) {
        console.warn(`[orchestrator] CONCURRENCY LIMIT: Skipping scheduler dispatch for "${task.title}"`)
        markScheduleRunning(task.id, false)
        return
      }

      // Transition to reserved with scheduler context
      const schedulerCtx = JSON.stringify({ taskId: task.id, runId, startedAt: now })
      const reserved = db.prepare(
        `UPDATE instances SET process_state = 'reserved', state = 'idle', reserved_at = ?,
         assigned_task_ids = ?, is_scheduler_run = 1, scheduler_context = ?, version = version + 1
         WHERE id = ? AND process_state = 'idle'`
      ).run(now, JSON.stringify([task.id]), schedulerCtx, instanceId)

      if (reserved.changes === 0) {
        markScheduleRunning(task.id, false)
        return
      }

      const exec: ScheduleExecution = { runId, startedAt: now, instanceId, status: 'running' }
      appendExecution(task.id, exec)

      const cwd = (folder.path as string) || ''
      const flagRows = db.prepare("SELECT value FROM settings WHERE key = 'globalFlags'").get() as { value: string } | undefined
      const globalFlags: string[] = flagRows ? JSON.parse(flagRows.value) : []

      const roleModels = getRoleModels()
      const model = roleModels['scheduler'] || 'sonnet'
      if (!globalFlags.some(f => f.startsWith('--model'))) globalFlags.push(`--model=${model}`)

      const roleTools = getRoleTools()
      const rTools = roleTools['scheduler']
      if (rTools && !globalFlags.some(f => f.startsWith('--tools'))) globalFlags.push('--tools', rTools)

      const msgId = crypto.randomUUID()
      const msgContent = [
        { type: 'orc-brief', taskTitle: task.title, taskId: task.id, instanceName: 'Chrono', projectId: folderId },
        { type: 'text', text: prompt },
      ]
      db.prepare('INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(msgId, instanceId, 'user', JSON.stringify(msgContent), now)
      broadcastEvent({ type: 'message:added', payload: { instanceId, message: { id: msgId, instanceId, role: 'user', content: msgContent, createdAt: now } } })

      await sendMessage({ instanceId, text: prompt, cwd, flags: globalFlags, mcpConfigPath: getMcpConfigPath('scheduler') })

      broadcastEvent({ type: 'pipeline:updated', payload: { projectId: folderId } })
    } catch (err) {
      console.error('[orchestrator] triggerScheduledTask error:', err)
      markScheduleRunning(task.id, false)
    }
  }

  private onSchedulerExit(instanceId: string, taskId: string, runId: string, startedAt: number): void {
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

  // ── Status Broadcast ──

  broadcastStatus(folderId: string): void {
    try {
      const folder = db.prepare('SELECT orchestrator_active FROM folders WHERE id = ?').get(folderId) as { orchestrator_active: number } | undefined
      const active = Boolean(folder?.orchestrator_active)

      const idleAgents = db.prepare(`SELECT COUNT(*) as count FROM instances WHERE folder_id = ? AND agent_role IS NOT NULL AND process_state = 'idle'`)
        .get(folderId) as { count: number }

      const pendingTasks = db.prepare(`SELECT COUNT(*) as count FROM pipeline_tasks WHERE project_id = ? AND "column" IN ('ready','in_progress') AND locked_by IS NULL`)
        .get(folderId) as { count: number }

      broadcastEvent({ type: 'orchestrator:status', payload: { folderId, active, idleAgents: idleAgents.count, pendingTasks: pendingTasks.count } })
    } catch (err) {
      console.error('[orchestrator] broadcastStatus error:', err)
    }
  }

  // ── Resume Stale Instances ──

  async resumeStaleInstances(snapshots: ResumeSnapshot[]): Promise<void> {
    let resumed = 0, failed = 0
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

        // Re-lock tasks and reserve instance transactionally
        const ok = db.transaction(() => {
          for (const t of tasks) {
            const history = safeJsonParse<Record<string, unknown>[]>(t.history as string, [])
            history.push({ action: 'reassigned', timestamp: now, agent: snap.instanceId, note: 'server restart resume' })
            db.prepare(
              "UPDATE pipeline_tasks SET locked_by = ?, locked_at = ?, history = ?, updated_at = ?, version = version + 1 WHERE id = ?"
            ).run(snap.instanceId, now, JSON.stringify(history), now, t.id)
          }
          db.prepare(
            `UPDATE instances SET process_state = 'reserved', state = 'running', reserved_at = ?,
             assigned_task_ids = ?, version = version + 1
             WHERE id = ?`
          ).run(now, JSON.stringify(snap.lockedTaskIds), snap.instanceId)
          return true
        })()

        if (!ok) continue

        const cwd = (instance.cwd as string) || (folder.path as string)
        const flagRows = db.prepare("SELECT value FROM settings WHERE key = 'globalFlags'").get() as { value: string } | undefined
        const globalFlags: string[] = flagRows ? JSON.parse(flagRows.value) : []

        const role = instance.agent_role as string
        const roleModels = getRoleModels()
        if (!globalFlags.some(f => f.startsWith('--model')) && role && roleModels[role]) globalFlags.push(`--model=${roleModels[role]}`)

        const roleTools = getRoleTools()
        const rTools = roleTools[role]
        if (rTools && !globalFlags.some(f => f.startsWith('--tools'))) globalFlags.push('--tools', rTools)

        let agentPrompt: string | undefined
        if (instance.agent_id) {
          const agent = db.prepare('SELECT content FROM agents WHERE id = ?').get(instance.agent_id as string) as { content: string } | undefined
          agentPrompt = agent?.content
        }

        const prompt = this.buildPrompt(tasks, primaryTask, instance, folder, true)

        try {
          await sendMessage({ instanceId: snap.instanceId, text: prompt, cwd, sessionId: snap.sessionId, flags: globalFlags, agentPrompt, mcpConfigPath: getMcpConfigPath(role) })
          resumed++
          emitOrcLog({ type: 'session_resumed', instanceId: snap.instanceId, instanceName: instance.name as string, taskId: primaryTask.id as string, taskTitle: primaryTask.title as string, detail: `session=${snap.sessionId.slice(0, 8)}` })
        } catch (err) {
          console.error(`[orchestrator] resumeStaleInstances sendMessage failed for ${snap.instanceId}:`, err)
          failed++
          // Rollback
          this.rollbackReservation(snap.instanceId, snap.lockedTaskIds)
          continue
        }

        broadcastEvent({ type: 'orchestrator:assigned', payload: { folderId: snap.folderId, instanceId: snap.instanceId, taskId: primaryTask.id as string, taskTitle: primaryTask.title as string } })
        broadcastEvent({ type: 'pipeline:updated', payload: { projectId: snap.folderId } })
      } catch (err) {
        console.error('[orchestrator] resumeStaleInstances error for', snap.instanceId, err)
        failed++
      }
    }
    console.log(`[orchestrator] resumeStaleInstances: ${resumed}/${snapshots.length} resumed, ${failed} failed`)
    await this.triggerAll()
  }

  async triggerAll(): Promise<void> {
    try {
      const folders = db.prepare('SELECT id FROM folders WHERE orchestrator_active = 1').all() as { id: string }[]
      for (const folder of folders) {
        await this.assignWork(folder.id)
      }
    } catch (err) {
      console.error('[orchestrator] triggerAll error:', err)
    }
  }

  clearDevLock(): void {
    clearDevLock()
  }
}

export const orchestrator = new OrchestratorService()

// ── Process alive check (imported from process-registry) ──
function isProcessAliveCheck(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ── Dev lockfile management ──
const DEV_LOCK_DIR = path.join(os.homedir(), '.orcstrator')
const DEV_LOCK_PATH = path.join(DEV_LOCK_DIR, 'dev.lock')

export function updateDevLock(): void {
  try {
    const anyActive = (db.prepare('SELECT COUNT(*) as c FROM folders WHERE orchestrator_active = 1').get() as { c: number }).c > 0
    const processesActive = processRegistry.getActiveCount() > 0
    const shouldLock = anyActive || processesActive

    if (shouldLock) {
      if (!fs.existsSync(DEV_LOCK_PATH)) {
        fs.mkdirSync(DEV_LOCK_DIR, { recursive: true })
        fs.writeFileSync(DEV_LOCK_PATH, JSON.stringify({ pid: process.pid, since: Date.now() }))
        console.log('[dev-lock] Created lockfile — restart blocked')
      }
    } else {
      if (fs.existsSync(DEV_LOCK_PATH)) {
        fs.unlinkSync(DEV_LOCK_PATH)
        console.log('[dev-lock] Removed lockfile — restart allowed')
      }
    }
  } catch (err) {
    console.warn('[dev-lock] Error updating lockfile:', err)
  }
}

export function clearDevLock(): void {
  try {
    if (fs.existsSync(DEV_LOCK_PATH)) {
      fs.unlinkSync(DEV_LOCK_PATH)
      console.log('[dev-lock] Cleared lockfile on shutdown')
    }
  } catch { /* ignore */ }
}
