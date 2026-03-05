import { db } from '../db.js'
import { sendMessage } from './claude-process.js'
import { broadcastEvent } from '../ws/handler.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const LOCK_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const SAFETY_POLL_MS = 60 * 1000        // 60 seconds
const LOCK_SWEEP_MS = 2 * 60 * 1000    // 2 minutes
const MAX_RETRIES = 3

const MASTER_PROMPTS_DIR = 'C:/Agents/.claude/agents'

const ROLE_COLUMNS: Record<string, string[]> = {
  planner: ['backlog', 'spec'],
  builder: ['build'],
  tester: ['qa'],
  promoter: ['ship'],
}

class OrchestratorService {
  private safetyPollTimer: ReturnType<typeof setInterval> | null = null
  private lockSweepTimer: ReturnType<typeof setInterval> | null = null

  start(): void {
    this.safetyPollTimer = setInterval(() => this.safetySweep(), SAFETY_POLL_MS)
    this.lockSweepTimer = setInterval(() => this.timeoutSweep(), LOCK_SWEEP_MS)
    console.log('[orchestrator] Started — event-driven + 60s safety poll + 2min lock sweep')
  }

  stop(): void {
    if (this.safetyPollTimer) clearInterval(this.safetyPollTimer)
    if (this.lockSweepTimer) clearInterval(this.lockSweepTimer)
  }

  // Primary trigger: called directly from claude-process.ts on process exit
  onProcessExit(instanceId: string): void {
    try {
      const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId) as Record<string, unknown> | undefined
      if (!instance || !instance.agent_role) return

      const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(instance.folder_id as string) as Record<string, unknown> | undefined
      if (!folder || !folder.orchestrator_active) return

      this.assignWork(instance.folder_id as string)
    } catch (err) {
      console.error('[orchestrator] onProcessExit error:', err)
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
        SELECT pt.*, i.state as instance_state
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
        const newRetryCount = ((rep.retry_count as number) || 0) + 1

        if (newRetryCount >= MAX_RETRIES) {
          for (const t of tasks) {
            const history = JSON.parse((t.history as string) || '[]')
            history.push({ action: 'moved', timestamp: Date.now(), from: t.column, to: 'staging', note: '3 failures — needs a human to look at this mess' })
            db.prepare(`UPDATE pipeline_tasks SET "column" = 'staging', locked_by = NULL, locked_at = NULL, retry_count = ?, history = ?, updated_at = ? WHERE id = ?`)
              .run(newRetryCount, JSON.stringify(history), Date.now(), t.id)
          }
          broadcastEvent({ type: 'orchestrator:lock-released', payload: { taskId: rep.id, reason: 'max-retries-staging' } })
        } else {
          for (const t of tasks) {
            const history = JSON.parse((t.history as string) || '[]')
            history.push({ action: 'lock_released', timestamp: Date.now(), note: 'timeout after 10min — the agent ghosted us' })
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

  // Core assignment logic — find idle managed agents and give them work
  private assignWork(folderId: string): void {
    try {
      const instances = db.prepare(`
        SELECT * FROM instances
        WHERE folder_id = ? AND state = 'idle' AND agent_role IS NOT NULL
          AND orchestrator_managed = 1
      `).all(folderId) as Record<string, unknown>[]

      if (instances.length === 0) return

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

    // Planner picks up backlog tasks → promote to spec
    const finalColumn = (role === 'planner' && task.column === 'backlog') ? 'spec' : (task.column as string)

    // Collect bundle tasks (builders only)
    let tasksToLock: Record<string, unknown>[] = [task]
    if (task.group_id && (task.group_id as string) !== '' && role === 'builder') {
      tasksToLock = db.prepare(`SELECT * FROM pipeline_tasks WHERE group_id = ? ORDER BY group_index ASC`)
        .all(task.group_id as string) as Record<string, unknown>[]
      if (tasksToLock.length === 0) tasksToLock = [task]
    }

    // Lock all tasks atomically
    const lockTx = db.transaction(() => {
      for (const t of tasksToLock) {
        const history = JSON.parse((t.history as string) || '[]')
        history.push({ action: 'assigned', timestamp: now, agent: instanceId })
        db.prepare(`UPDATE pipeline_tasks SET locked_by = ?, locked_at = ?, "column" = ?, history = ?, updated_at = ? WHERE id = ?`)
          .run(instanceId, now, finalColumn, JSON.stringify(history), now, t.id)
      }
    })
    lockTx()

    // Build prompt
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Record<string, unknown>
    const prompt = this.buildPrompt(tasksToLock, task, instance, folder)

    const cwd = (instance.cwd as string) || (folder.path as string)
    const sessionId = instance.session_id as string | undefined

    const flagRows = db.prepare("SELECT value FROM settings WHERE key = 'globalFlags'").get() as { value: string } | undefined
    const globalFlags: string[] = flagRows ? JSON.parse(flagRows.value) : []

    let agentPrompt: string | undefined
    if (instance.agent_id) {
      const agent = db.prepare('SELECT content FROM agents WHERE id = ?').get(instance.agent_id as string) as { content: string } | undefined
      agentPrompt = agent?.content
    }

    console.log(`[orchestrator] Assigning "${task.title}" → instance ${instanceId} (${role})`)

    // Save orchestrator prompt as a user message so it's visible in the session
    const msgId = crypto.randomUUID()
    const msgContent = [{ type: 'text', text: prompt }]
    db.prepare('INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(msgId, instanceId, 'user', JSON.stringify(msgContent), now)
    broadcastEvent({ type: 'message:added', payload: { instanceId, message: { id: msgId, instanceId, role: 'user', content: msgContent, createdAt: now } } })

    try {
      sendMessage({ instanceId, text: prompt, cwd, sessionId, flags: globalFlags, agentPrompt })
    } catch (err) {
      console.error(`[orchestrator] sendMessage failed for ${instanceId}:`, err)
      for (const t of tasksToLock) {
        db.prepare('UPDATE pipeline_tasks SET locked_by = NULL, locked_at = NULL WHERE id = ?').run(t.id)
      }
      return
    }

    broadcastEvent({ type: 'orchestrator:assigned', payload: { folderId, instanceId, taskId: task.id as string, taskTitle: task.title as string } })
    broadcastEvent({ type: 'pipeline:updated', payload: { projectId: folderId } })
  }

  private buildPrompt(tasksToLock: Record<string, unknown>[], primaryTask: Record<string, unknown>, instance: Record<string, unknown>, folder: Record<string, unknown>): string {
    const role = instance.agent_role as string
    const masterPrompt = this.loadMasterPrompt(role)
    const projectContext = this.loadProjectContext(folder.path as string)
    const isBundle = tasksToLock.length > 1

    const priorityLabels: Record<number, string> = { 1: 'critical', 2: 'high', 3: 'normal', 4: 'low' }
    const priorityLabel = priorityLabels[primaryTask.priority as number] || 'normal'

    let assignment = `Title: ${primaryTask.title as string}\n`
    if (isBundle) {
      assignment += `Group: ${primaryTask.group_index as number}/${primaryTask.group_total as number} — complete all tasks in this group\n`
    }
    assignment += `Priority: ${primaryTask.priority as number} (${priorityLabel})\n`

    if (primaryTask.description) {
      assignment += `\n${primaryTask.description as string}\n`
    }

    const dependsOn = JSON.parse((primaryTask.depends_on as string) || '[]') as string[]
    if (dependsOn.length > 0) {
      assignment += `\nPrerequisites (must be Done): ${dependsOn.join(', ')}\n`
    }

    if (isBundle) {
      assignment += '\n### All tasks in this bundle:\n'
      for (const t of tasksToLock) {
        assignment += `- [${t.group_index}/${t.group_total}] ${t.title as string}\n`
        if (t.description) {
          const desc = (t.description as string).slice(0, 100)
          assignment += `  ${desc}${desc.length === 100 ? '...' : ''}\n`
        }
      }
    }

    const instanceCwd = (instance.cwd as string) || (folder.path as string)
    const scopeConstraint = [
      '## SCOPE CONSTRAINT — MANDATORY',
      '',
      `Your working directory: **${instanceCwd}**`,
      '',
      'BEFORE reading, writing, or executing any command on a file:',
      '1. Verify the full path starts with the working directory above',
      '2. If it does NOT — STOP and escalate (see below)',
      '',
      'You are FORBIDDEN from accessing these sibling directories or any path outside your working directory:',
      '- Any path not starting with your working directory',
      '- Examples of forbidden paths: C:/Agents/nask-ai-v2/, C:/Agents/naskminal/, C:/Agents/content-framework/, C:/Agents/meta-ads-uploader/',
      '',
      '**If a task requires cross-scope access:**',
      '1. STOP — do not proceed with the out-of-scope action',
      '2. Create an escalation task in Staging: POST http://localhost:3333/api/pipelines/{projectId}/tasks',
      '   body: {"title":"[ACTION NEEDED] Cross-scope access required","column":"staging","priority":2,"description":"Task needs X from Y — human must copy or coordinate"}',
      '3. Move the current task to staging with explanation',
    ].join('\n')

    const parts: string[] = []
    if (masterPrompt) {
      parts.push(masterPrompt)
      parts.push('---')
    }
    if (projectContext) {
      parts.push('## PROJECT CONTEXT')
      parts.push(projectContext)
      parts.push('---')
    }

    // Inject scope constraint as FIRST item (highest priority)
    parts.unshift('---')
    parts.unshift(scopeConstraint)
    parts.push('## YOUR ASSIGNMENT')
    parts.push(assignment)

    // Inject task metadata so agents can move tasks via the pipeline API
    const projectId = folder.id as string
    parts.push('## TASK METADATA')
    parts.push(`Project ID: ${projectId}`)
    parts.push(`Task ID: ${primaryTask.id as string}`)
    parts.push(`Pipeline API base: http://localhost:3333/api`)
    parts.push(`Move task:   POST http://localhost:3333/api/pipelines/${projectId}/tasks/${primaryTask.id as string}/move  body: { "column": "<target>" }`)
    parts.push(`Valid columns: backlog | spec | build | qa | staging | ship | done`)
    parts.push('')
    parts.push('**DO NOT use Todoist, HyperTask, or any external task management tool.** Your task is above. Use the Pipeline API URLs above to move it when done.')
    parts.push('')
    parts.push('Good luck. The pipeline is watching.')

    return parts.join('\n')
  }

  private loadMasterPrompt(role: string): string {
    const filePath = path.join(MASTER_PROMPTS_DIR, `${role}-master.md`)
    try {
      if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8')
    } catch { /* unreadable */ }
    return ''
  }

  private loadProjectContext(folderPath: string): string {
    const claudeMdPath = path.join(folderPath, 'CLAUDE.md')
    try {
      if (fs.existsSync(claudeMdPath)) return fs.readFileSync(claudeMdPath, 'utf-8')
    } catch { /* not found */ }
    return ''
  }

  broadcastStatus(folderId: string): void {
    try {
      const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Record<string, unknown>
      const active = Boolean(folder?.orchestrator_active)

      const idleAgents = db.prepare(`SELECT COUNT(*) as count FROM instances WHERE folder_id = ? AND agent_role IS NOT NULL AND state = 'idle'`)
        .get(folderId) as { count: number }

      const pendingTasks = db.prepare(`SELECT COUNT(*) as count FROM pipeline_tasks WHERE project_id = ? AND "column" IN ('backlog','spec','build','qa','ship') AND locked_by IS NULL`)
        .get(folderId) as { count: number }

      broadcastEvent({ type: 'orchestrator:status', payload: { folderId, active, idleAgents: idleAgents.count, pendingTasks: pendingTasks.count } })
    } catch (err) {
      console.error('[orchestrator] broadcastStatus error:', err)
    }
  }

  // Immediately check a folder when activated
  triggerFolder(folderId: string): void {
    this.assignWork(folderId)
    this.broadcastStatus(folderId)
  }
}

export const orchestrator = new OrchestratorService()
