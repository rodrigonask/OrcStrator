import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'

// ── Types ──

interface SyncableRow {
  id: string
  [key: string]: unknown
}

interface ProjectSyncMeta {
  folder_id: string
  machine_id: string
  last_modified_at: number
}

type SyncStatus = 'disconnected' | 'connected' | 'syncing' | 'error'

// ── Tables to sync ──

const SYNCED_TABLES = [
  'pipeline_tasks',
  'task_comments',
  'agents',
  'folders',
  'pipeline_blueprints',
  'token_usage',
  'instances',
] as const

// Tables that are project-scoped (filtered by project_id or folder_id)
const PROJECT_SCOPED: Record<string, string> = {
  pipeline_tasks: 'project_id',
  task_comments: 'task_id',   // indirect via pipeline_tasks
  instances: 'folder_id',
  token_usage: 'task_id',     // indirect via pipeline_tasks
}

// Tables that are global (sync all rows)
const GLOBAL_TABLES = ['agents', 'folders', 'pipeline_blueprints'] as const

// ── Cloud Sync Service ──

class CloudSyncService {
  private client: SupabaseClient | null = null
  private _status: SyncStatus = 'disconnected'
  private _error: string | null = null
  private _machineId: string = ''
  private _machineName: string = ''
  private lastFullSyncTick = 0

  get status(): SyncStatus { return this._status }
  get error(): string | null { return this._error }
  get machineId(): string { return this._machineId }

  // ── Init / Connect ──

  /** Initialize from saved settings. Call on server start + when settings change. */
  initialize(): void {
    const url = this.getSetting('cloudSyncUrl')
    const key = this.getSetting('cloudSyncKey')
    this._machineName = this.getSetting('machineName') || 'Unknown'
    this._machineId = this.getSetting('machineId') || ''

    // Auto-generate machineId on first run
    if (!this._machineId) {
      this._machineId = crypto.randomUUID()
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('machineId', ?)").run(JSON.stringify(this._machineId))
    }

    if (!url || !key) {
      this.disconnect()
      return
    }

    try {
      this.client = createClient(url, key)
      this._status = 'connected'
      this._error = null
      console.log(`[cloud-sync] Connected to Supabase (machine: ${this._machineName} / ${this._machineId.slice(0, 8)})`)
      this.broadcast()
    } catch (err) {
      this._status = 'error'
      this._error = err instanceof Error ? err.message : 'Connection failed'
      this.client = null
      console.error(`[cloud-sync] Failed to connect:`, this._error)
      this.broadcast()
    }
  }

  disconnect(): void {
    this.client = null
    this._status = 'disconnected'
    this._error = null
    this.broadcast()
  }

  isConfigured(): boolean {
    return this.client !== null
  }

  /** Test a connection with given credentials (doesn't save them). */
  async testConnection(url: string, key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const testClient = createClient(url, key)
      // Try to read from project_sync_meta — if the table exists, we're good
      const { error } = await testClient.from('project_sync_meta').select('folder_id').limit(1)
      if (error) {
        // Table might not exist yet — try a simpler query
        const { error: error2 } = await testClient.from('folders').select('id').limit(1)
        if (error2 && !error2.message.includes('does not exist')) {
          return { ok: false, error: error2.message }
        }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' }
    }
  }

  // ── Sync Logic (called from Orc tick) ──

  /** Main entry point — called every Orc tick. Only syncs folders with cloud_sync=1. */
  async syncIfNeeded(): Promise<void> {
    if (!this.client) return

    const syncedFolders = db.prepare(
      "SELECT id, last_synced_at, cloud_last_modified_at FROM folders WHERE cloud_sync = 1"
    ).all() as Array<{ id: string; last_synced_at: number | null; cloud_last_modified_at: number | null }>

    if (syncedFolders.length === 0) return

    for (const folder of syncedFolders) {
      try {
        await this.syncFolder(folder.id, folder.last_synced_at, folder.cloud_last_modified_at)
      } catch (err) {
        console.error(`[cloud-sync] Error syncing folder ${folder.id}:`, err)
        this._status = 'error'
        this._error = err instanceof Error ? err.message : 'Sync failed'
        this.broadcast()
      }
    }
  }

  /** Full sync for all synced folders — called hourly as safety net. */
  async fullSync(): Promise<void> {
    if (!this.client) return
    console.log('[cloud-sync] Running hourly full sync...')

    const syncedFolders = db.prepare(
      "SELECT id FROM folders WHERE cloud_sync = 1"
    ).all() as Array<{ id: string }>

    for (const folder of syncedFolders) {
      try {
        await this.pushFolder(folder.id)
        await this.pullFolder(folder.id)
        db.prepare("UPDATE folders SET last_synced_at = ? WHERE id = ?").run(Date.now(), folder.id)
      } catch (err) {
        console.error(`[cloud-sync] Full sync error for folder ${folder.id}:`, err)
      }
    }

    // Also sync global tables
    await this.syncGlobalTables()
  }

  /** Initial sync — push everything for a newly-enabled folder. */
  async initialSync(folderId: string): Promise<void> {
    if (!this.client) return
    console.log(`[cloud-sync] Initial sync for folder ${folderId}`)

    this._status = 'syncing'
    this.broadcast()

    try {
      await this.pushFolder(folderId)
      await this.syncGlobalTables()
      db.prepare("UPDATE folders SET last_synced_at = ?, cloud_last_modified_at = ? WHERE id = ?")
        .run(Date.now(), Date.now(), folderId)

      // Update project_sync_meta in cloud
      await this.updateCloudMeta(folderId)

      this._status = 'connected'
      this.broadcast()
    } catch (err) {
      this._status = 'error'
      this._error = err instanceof Error ? err.message : 'Initial sync failed'
      this.broadcast()
      throw err
    }
  }

  // ── Per-Folder Sync ──

  private async syncFolder(
    folderId: string,
    lastSyncedAt: number | null,
    cloudLastModifiedAt: number | null,
  ): Promise<void> {
    if (!this.client) return

    // Check if cloud has changed since our last pull
    const cloudMeta = await this.getCloudMeta(folderId)
    const cloudModified = cloudMeta?.last_modified_at ?? 0
    const localLastSynced = lastSyncedAt ?? 0

    // Check if local has changes since last sync
    const localModified = this.getLocalLastModified(folderId)

    const needsPush = localModified > localLastSynced
    const needsPull = cloudModified > (cloudLastModifiedAt ?? 0)

    if (!needsPush && !needsPull) return  // Nothing changed — skip

    this._status = 'syncing'
    this.broadcast()

    try {
      if (needsPush) {
        await this.pushFolder(folderId, localLastSynced)
        await this.updateCloudMeta(folderId)
      }

      if (needsPull) {
        await this.pullFolder(folderId, cloudLastModifiedAt ?? 0)
      }

      const now = Date.now()
      db.prepare("UPDATE folders SET last_synced_at = ?, cloud_last_modified_at = ? WHERE id = ?")
        .run(now, cloudModified > 0 ? cloudModified : now, folderId)

      this._status = 'connected'
      this._error = null
      this.broadcast()
    } catch (err) {
      this._status = 'error'
      this._error = err instanceof Error ? err.message : 'Sync failed'
      this.broadcast()
    }
  }

  // ── Push (local → cloud) ──

  private async pushFolder(folderId: string, since?: number | null): Promise<void> {
    if (!this.client) return

    // Push pipeline_tasks for this project
    await this.pushTable('pipeline_tasks', 'project_id', folderId, since)

    // Push task_comments for tasks in this project
    const taskIds = db.prepare(
      "SELECT id FROM pipeline_tasks WHERE project_id = ?"
    ).all(folderId) as Array<{ id: string }>
    if (taskIds.length > 0) {
      await this.pushTaskComments(taskIds.map(t => t.id), since)
    }

    // Push instances for this folder
    await this.pushTable('instances', 'folder_id', folderId, since)

    // Push token_usage for tasks in this project
    if (taskIds.length > 0) {
      await this.pushTokenUsage(taskIds.map(t => t.id), since)
    }
  }

  private async pushTable(
    table: string,
    scopeCol: string,
    scopeVal: string,
    since?: number | null,
  ): Promise<void> {
    if (!this.client) return

    let query = `SELECT * FROM ${table} WHERE "${scopeCol}" = ?`
    const params: unknown[] = [scopeVal]

    if (since) {
      query += ' AND updated_at > ?'
      params.push(since)
    }

    // For 'done' tasks, only push if not already synced (initial sync)
    if (table === 'pipeline_tasks' && since) {
      query += " AND \"column\" != 'done'"
    }

    const rows = db.prepare(query).all(...params) as SyncableRow[]
    if (rows.length === 0) return

    // Add machine identity to each row
    const enriched = rows.map(row => ({
      ...row,
      machine_id: this._machineId,
      machine_name: this._machineName,
    }))

    // Batch upsert (Supabase supports upsert natively)
    const batchSize = 100
    for (let i = 0; i < enriched.length; i += batchSize) {
      const batch = enriched.slice(i, i + batchSize)
      const { error } = await this.client.from(table).upsert(batch, {
        onConflict: 'id,machine_id',
      })
      if (error) {
        console.error(`[cloud-sync] Push error for ${table}:`, error.message)
        throw new Error(`Push ${table}: ${error.message}`)
      }
    }

    console.log(`[cloud-sync] Pushed ${rows.length} rows to ${table}`)
  }

  private async pushTaskComments(taskIds: string[], since?: number | null): Promise<void> {
    if (!this.client || taskIds.length === 0) return

    const placeholders = taskIds.map(() => '?').join(',')
    let query = `SELECT * FROM task_comments WHERE task_id IN (${placeholders})`
    const params: unknown[] = [...taskIds]

    if (since) {
      query += ' AND created_at > ?'
      params.push(since)
    }

    const rows = db.prepare(query).all(...params) as SyncableRow[]
    if (rows.length === 0) return

    const enriched = rows.map(row => ({
      ...row,
      machine_id: this._machineId,
      machine_name: this._machineName,
    }))

    const { error } = await this.client.from('task_comments').upsert(enriched, {
      onConflict: 'id,machine_id',
    })
    if (error) throw new Error(`Push task_comments: ${error.message}`)
    console.log(`[cloud-sync] Pushed ${rows.length} task_comments`)
  }

  private async pushTokenUsage(taskIds: string[], since?: number | null): Promise<void> {
    if (!this.client || taskIds.length === 0) return

    const placeholders = taskIds.map(() => '?').join(',')
    let query = `SELECT * FROM token_usage WHERE task_id IN (${placeholders})`
    const params: unknown[] = [...taskIds]

    if (since) {
      query += ' AND created_at > ?'
      params.push(since)
    }

    const rows = db.prepare(query).all(...params) as SyncableRow[]
    if (rows.length === 0) return

    const enriched = rows.map(row => ({
      ...row,
      machine_id: this._machineId,
      machine_name: this._machineName,
    }))

    const batchSize = 100
    for (let i = 0; i < enriched.length; i += batchSize) {
      const batch = enriched.slice(i, i + batchSize)
      const { error } = await this.client.from('token_usage').upsert(batch, {
        onConflict: 'id,machine_id',
      })
      if (error) throw new Error(`Push token_usage: ${error.message}`)
    }
    console.log(`[cloud-sync] Pushed ${rows.length} token_usage rows`)
  }

  // ── Pull (cloud → local) ──

  private async pullFolder(folderId: string, since?: number): Promise<void> {
    if (!this.client) return

    // Pull pipeline_tasks from other machines for this project
    const { data: tasks, error: taskErr } = await this.client
      .from('pipeline_tasks')
      .select('*')
      .eq('project_id', folderId)
      .neq('machine_id', this._machineId)
      .gt('updated_at', since ?? 0)

    if (taskErr) throw new Error(`Pull pipeline_tasks: ${taskErr.message}`)

    if (tasks && tasks.length > 0) {
      this.applyRemoteTasks(tasks)
      console.log(`[cloud-sync] Pulled ${tasks.length} remote tasks`)
    }

    // Pull task_comments from other machines
    const { data: comments, error: commentErr } = await this.client
      .from('task_comments')
      .select('*')
      .neq('machine_id', this._machineId)
      .gt('created_at', since ?? 0)

    if (commentErr) throw new Error(`Pull task_comments: ${commentErr.message}`)

    if (comments && comments.length > 0) {
      this.applyRemoteComments(comments)
      console.log(`[cloud-sync] Pulled ${comments.length} remote comments`)
    }
  }

  /** Apply remote task changes to local DB. Skip locked tasks to avoid conflicts. */
  private applyRemoteTasks(tasks: SyncableRow[]): void {
    const upsert = db.prepare(`
      INSERT INTO pipeline_tasks (id, project_id, title, description, "column", priority, labels,
        assigned_agent, group_id, group_index, group_total, depends_on, created_by, history,
        completed_at, created_at, updated_at, attachments, schedule, executions, skill,
        total_input_tokens, total_output_tokens, total_cost_usd,
        pipeline_id, current_step, total_steps, current_step_role, step_instructions)
      VALUES (@id, @project_id, @title, @description, @column, @priority, @labels,
        @assigned_agent, @group_id, @group_index, @group_total, @depends_on, @created_by, @history,
        @completed_at, @created_at, @updated_at, @attachments, @schedule, @executions, @skill,
        @total_input_tokens, @total_output_tokens, @total_cost_usd,
        @pipeline_id, @current_step, @total_steps, @current_step_role, @step_instructions)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        "column" = excluded."column",
        priority = excluded.priority,
        labels = excluded.labels,
        depends_on = excluded.depends_on,
        history = excluded.history,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at,
        schedule = excluded.schedule,
        pipeline_id = excluded.pipeline_id,
        current_step = excluded.current_step,
        total_steps = excluded.total_steps,
        current_step_role = excluded.current_step_role,
        step_instructions = excluded.step_instructions
      WHERE pipeline_tasks.locked_by IS NULL
    `)

    const tx = db.transaction(() => {
      for (const task of tasks) {
        // Strip cloud-only fields before inserting locally
        const { machine_id, machine_name, ...localTask } = task
        try {
          upsert.run(localTask)
        } catch (err) {
          console.warn(`[cloud-sync] Failed to apply remote task ${task.id}:`, err)
        }
      }
    })
    tx()
  }

  private applyRemoteComments(comments: SyncableRow[]): void {
    const upsert = db.prepare(`
      INSERT OR IGNORE INTO task_comments (id, task_id, author, body, created_at)
      VALUES (@id, @task_id, @author, @body, @created_at)
    `)

    const tx = db.transaction(() => {
      for (const comment of comments) {
        const { machine_id, machine_name, ...local } = comment
        try {
          upsert.run(local)
        } catch (err) {
          console.warn(`[cloud-sync] Failed to apply remote comment ${comment.id}:`, err)
        }
      }
    })
    tx()
  }

  // ── Global Tables ──

  private async syncGlobalTables(): Promise<void> {
    if (!this.client) return

    for (const table of GLOBAL_TABLES) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as SyncableRow[]
      if (rows.length === 0) continue

      const enriched = rows.map(row => ({
        ...row,
        machine_id: this._machineId,
        machine_name: this._machineName,
      }))

      const { error } = await this.client.from(table).upsert(enriched, {
        onConflict: 'id,machine_id',
      })
      if (error) {
        console.error(`[cloud-sync] Push global ${table}:`, error.message)
      }
    }
  }

  // ── Cloud Metadata ──

  private async getCloudMeta(folderId: string): Promise<ProjectSyncMeta | null> {
    if (!this.client) return null

    // Check if ANY machine has updated this project
    const { data, error } = await this.client
      .from('project_sync_meta')
      .select('*')
      .eq('folder_id', folderId)
      .neq('machine_id', this._machineId)
      .order('last_modified_at', { ascending: false })
      .limit(1)

    if (error || !data || data.length === 0) return null
    return data[0] as ProjectSyncMeta
  }

  private async updateCloudMeta(folderId: string): Promise<void> {
    if (!this.client) return

    const { error } = await this.client.from('project_sync_meta').upsert({
      folder_id: folderId,
      machine_id: this._machineId,
      machine_name: this._machineName,
      last_modified_at: Date.now(),
    }, {
      onConflict: 'folder_id,machine_id',
    })

    if (error) {
      console.error(`[cloud-sync] Failed to update cloud meta:`, error.message)
    }
  }

  // ── Helpers ──

  private getLocalLastModified(folderId: string): number {
    // Check the most recent updated_at across project-scoped tables
    const taskRow = db.prepare(
      "SELECT MAX(updated_at) as max_at FROM pipeline_tasks WHERE project_id = ?"
    ).get(folderId) as { max_at: number | null } | undefined

    return taskRow?.max_at ?? 0
  }

  private getSetting(key: string): string {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return ''
    try {
      return JSON.parse(row.value) as string
    } catch {
      return row.value
    }
  }

  private broadcast(): void {
    broadcastEvent({
      type: 'cloud-sync:status',
      payload: {
        status: this._status,
        error: this._error,
        machineId: this._machineId,
        machineName: this._machineName,
      }
    })
  }

  /** Get sync status for all folders. */
  getSyncStatus(): Array<{ folderId: string; cloudSync: boolean; lastSyncedAt: number | null }> {
    return db.prepare(
      "SELECT id as folderId, cloud_sync as cloudSync, last_synced_at as lastSyncedAt FROM folders WHERE cloud_sync = 1"
    ).all() as Array<{ folderId: string; cloudSync: boolean; lastSyncedAt: number | null }>
  }
}

export const cloudSync = new CloudSyncService()
