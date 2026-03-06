import { db } from '../db.js'
import { sendMessage } from './claude-process.js'
import { broadcastEvent } from '../ws/handler.js'
import { updateOverdriveOnComplete, resetOverdriveIfExpired } from './overdrive.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const LOCK_TIMEOUT_MS = 20 * 60 * 1000 // 20 minutes (was 10)

export const serverStartTime = Date.now()
const SAFETY_POLL_MS = 60 * 1000        // 60 seconds
const LOCK_SWEEP_MS = 2 * 60 * 1000    // 2 minutes
const MAX_RETRIES = 3

// Master prompts live in nasklaude's source, not in Claude Code's config directory
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MASTER_PROMPTS_DIR = path.resolve(__dirname, '../../agents')

// Model tiering: Opus for complex implementation, Sonnet for everything else
const ROLE_MODELS: Record<string, string> = {
  planner: 'sonnet',
  builder: 'opus',
  tester: 'sonnet',
  promoter: 'sonnet',
}

// MCP scoping: tester gets playwriter, everyone else gets --strict-mcp-config only (zero servers)
const AGENTS_DIR = path.resolve(__dirname, '../../agents')
const ROLE_MCP_CONFIG: Record<string, string> = {
  planner: 'none',
  builder: 'none',
  tester: path.join(AGENTS_DIR, 'mcp-tester.json'),
  promoter: 'none',
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
}

class OrchestratorService {
  private safetyPollTimer: ReturnType<typeof setInterval> | null = null
  private lockSweepTimer: ReturnType<typeof setInterval> | null = null
  private folderTriggerTimers = new Map<string, ReturnType<typeof setTimeout>>()

  start(): void {
    if (this.safetyPollTimer) return
    this.safetyPollTimer = setInterval(() => this.safetySweep(), SAFETY_POLL_MS)
    this.lockSweepTimer = setInterval(() => this.timeoutSweep(), LOCK_SWEEP_MS)
    setInterval(() => {
      try { db.prepare('VACUUM').run() } catch {}
    }, 6 * 60 * 60 * 1000)
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
    this.pruneMessages(instanceId)
    updateOverdriveOnComplete(instanceId)
    // Keep session_id so next task resumes the session (cache hits on pinned context)
  }

  private pruneOldMessages(instanceId: string): void {
    const KEEP_LAST = 500
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
      const KEEP = 300
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
            history.push({ action: 'moved', timestamp: Date.now(), from: t.column, to: 'staging', note: '3 failures — needs a human to look at this mess' })
            db.prepare(`UPDATE pipeline_tasks SET "column" = 'staging', locked_by = NULL, locked_at = NULL, retry_count = ?, history = ?, updated_at = ? WHERE id = ?`)
              .run(newRetryCount, JSON.stringify(history), Date.now(), t.id)
          }
          broadcastEvent({ type: 'orchestrator:lock-released', payload: { taskId: rep.id, reason: 'max-retries-staging' } })
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
    // Use --model=value format so filterFlags() doesn't strip the value
    const hasModelFlag = globalFlags.some(f => f.startsWith('--model'))
    if (!hasModelFlag && ROLE_MODELS[role]) {
      globalFlags.push(`--model=${ROLE_MODELS[role]}`)
    }

    let agentPrompt: string | undefined
    if (instance.agent_id) {
      const agent = db.prepare('SELECT content FROM agents WHERE id = ?').get(instance.agent_id as string) as { content: string } | undefined
      agentPrompt = agent?.content
    }

    resetOverdriveIfExpired(instanceId)

    console.log(`[orchestrator] Assigning "${task.title}" → instance ${instanceId} (${role}, model: ${ROLE_MODELS[role] || 'default'})`)

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
      sendMessage({ instanceId, text: prompt, images: taskImages, cwd, sessionId, flags: globalFlags, agentPrompt, mcpConfigPath: ROLE_MCP_CONFIG[role] })
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

  private buildPrompt(tasksToLock: Record<string, unknown>[], primaryTask: Record<string, unknown>, instance: Record<string, unknown>, folder: Record<string, unknown>): string {
    const role = instance.agent_role as string
    const masterPrompt = this.loadMasterPrompt(role)
    const skills = this.loadInstanceSkills(instance)
    const isBundle = tasksToLock.length > 1
    const projectId = folder.id as string
    const taskId = primaryTask.id as string
    const instanceCwd = (instance.cwd as string) || (folder.path as string)

    const priorityLabels: Record<number, string> = { 1: 'critical', 2: 'high', 3: 'normal', 4: 'low' }
    const priorityLabel = priorityLabels[primaryTask.priority as number] || 'normal'

    const parts: string[] = []

    // Scope constraint — condensed (was ~18 lines, now ~3)
    parts.push(`## Scope: ${instanceCwd}`)
    parts.push(`Only access files under this directory. If cross-scope access needed, create "[ACTION NEEDED]" task in staging and stop.`)
    parts.push('')

    // Master prompt (already slimmed in Phase 1C)
    if (masterPrompt) {
      parts.push(masterPrompt)
      parts.push('')
    }

    // Agent skills (from DB — only if assigned)
    if (skills.length > 0) {
      for (const skill of skills) {
        parts.push(`### Skill: ${skill.name}`)
        parts.push(skill.content)
      }
      parts.push('')
    }

    // Tester: playwriter rules (condensed from ~40 lines to ~10)
    if (role === 'tester') {
      parts.push('## Browser Testing: use `playwriter` CLI via Bash only')
      parts.push('NEVER use `mcp__playwright__*` tools. Use `playwriter session new` then `playwriter -e "..."` with the `page` global.')
      parts.push('NEVER call `context.newPage()`. Screenshots use relative paths.')
      parts.push('After QA passes, read the `## Proof of Completion Screenshot` section of the spec and take the proof screenshot.')
      parts.push('Post proof comment before moving to ship.')
      parts.push('')
    }

    // Task assignment
    parts.push('## YOUR ASSIGNMENT')
    parts.push(`Title: ${primaryTask.title as string}`)
    if (isBundle) {
      parts.push(`Group: ${primaryTask.group_index as number}/${primaryTask.group_total as number} — complete all tasks in this group`)
    }
    parts.push(`Priority: ${primaryTask.priority as number} (${priorityLabel})`)

    if (primaryTask.description) {
      parts.push('')
      parts.push(primaryTask.description as string)
    }

    const rawAttachmentsForNote = JSON.parse((primaryTask.attachments as string) || '[]') as Array<{ name: string }>
    if (rawAttachmentsForNote.length > 0) {
      parts.push(`\nAttachments: ${rawAttachmentsForNote.length} screenshot(s) included with this message.`)
    }

    const dependsOn = JSON.parse((primaryTask.depends_on as string) || '[]') as string[]
    if (dependsOn.length > 0) {
      parts.push(`\nPrerequisites (must be Done): ${dependsOn.join(', ')}`)
    }

    const priorComments = this.loadTaskComments(taskId)
    if (priorComments) {
      parts.push('\n### Prior Comments')
      parts.push(priorComments)
    }

    if (isBundle) {
      parts.push('\n### All tasks in this bundle:')
      for (const t of tasksToLock) {
        parts.push(`- [${t.group_index}/${t.group_total}] ${t.title as string}`)
        if (t.description) {
          const desc = (t.description as string).slice(0, 100)
          parts.push(`  ${desc}${desc.length === 100 ? '...' : ''}`)
        }
      }
    }

    // Pipeline API (condensed — was ~15 lines, now ~5)
    parts.push('')
    parts.push('## Pipeline API')
    parts.push(`Task ID: ${taskId} | Project ID: ${projectId}`)
    parts.push(`Move: POST http://localhost:3333/api/pipelines/${projectId}/tasks/${taskId}/move  body: {"column":"<target>"}`)
    parts.push(`Comment: POST http://localhost:3333/api/pipelines/${projectId}/tasks/${taskId}/comments  body: {"author":"${role}","body":"..."}`)
    parts.push(`Columns: backlog | spec | build | qa | staging | ship | done`)
    parts.push(`Post a comment before moving. Do NOT use Todoist/HyperTask.`)

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
      // Cap to last 3 comments, max ~500 tokens (~2000 chars)
      const rows = db.prepare(
        'SELECT author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 3'
      ).all(taskId) as Array<{ author: string; body: string; created_at: number }>
      if (rows.length === 0) return ''
      const MAX_CHARS = 2000
      let result = ''
      for (const r of rows.reverse()) {
        const line = `  [@${r.author} ${new Date(r.created_at).toISOString()}]: ${r.body}\n`
        if (result.length + line.length > MAX_CHARS) break
        result += line
      }
      return result.trimEnd()
    } catch {
      return ''
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

        const prompt = this.buildPrompt(tasks, primaryTask, instance, folder)
        const cwd = (instance.cwd as string) || (folder.path as string)

        const flagRows = db.prepare("SELECT value FROM settings WHERE key = 'globalFlags'").get() as { value: string } | undefined
        const globalFlags: string[] = flagRows ? JSON.parse(flagRows.value) : []

        // Model tiering for resumed sessions
        const role = instance.agent_role as string
        const hasModelFlag = globalFlags.some(f => f.startsWith('--model'))
        if (!hasModelFlag && role && ROLE_MODELS[role]) {
          globalFlags.push(`--model=${ROLE_MODELS[role]}`)
        }

        let agentPrompt: string | undefined
        if (instance.agent_id) {
          const agent = db.prepare('SELECT content FROM agents WHERE id = ?').get(instance.agent_id as string) as { content: string } | undefined
          agentPrompt = agent?.content
        }

        console.log(`[orchestrator] Resuming "${primaryTask.title as string}" → instance ${snap.instanceId} (--resume ${snap.sessionId}, model: ${ROLE_MODELS[role] || 'default'})`)

        try {
          sendMessage({ instanceId: snap.instanceId, text: prompt, cwd, sessionId: snap.sessionId, flags: globalFlags, agentPrompt, mcpConfigPath: ROLE_MCP_CONFIG[role] })
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
