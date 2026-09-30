import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { DATA_DIR, DB_PATH } from './config.js'
import { acquireDataDirLock } from './data-dir-lock.js'
import { canonicalizeCwd } from './services/canonical-path.js'
import { DEFAULT_SETTINGS, computeCostUsd } from '@orcstrator/shared'

let db: Database.Database

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

/**
 * The applied schema version. 0 only for a database that has no schema_version table yet
 * (a new one). Any other error is thrown: reading 0 by mistake would re-run every
 * migration from 001 over a live database.
 */
function getSchemaVersion(): number {
  try {
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined
    return row?.version ?? 0
  } catch (err) {
    if (err instanceof Error && /no such table: schema_version/i.test(err.message)) return 0
    throw err
  }
}

function isNoSuchColumnError(err: unknown): boolean {
  return err instanceof Error && /no such column/i.test(err.message)
}

function setSchemaVersion(version: number): void {
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, Date.now())
}

function isDuplicateColumnError(err: unknown): boolean {
  return err instanceof Error && (
    err.message.includes('duplicate column') ||
    err.message.includes('already exists')
  )
}

function safeAddColumn(table: string, columnDef: string): void {
  try {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`).run()
  } catch (err) {
    if (!isDuplicateColumnError(err)) throw err
  }
}

function migration001(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      path TEXT UNIQUE,
      name TEXT,
      display_name TEXT,
      emoji TEXT,
      client TEXT,
      project_type TEXT DEFAULT 'other',
      color TEXT,
      status TEXT DEFAULT 'active',
      repo_url TEXT,
      notes TEXT,
      expanded INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      name TEXT,
      cwd TEXT,
      session_id TEXT,
      state TEXT DEFAULT 'idle',
      agent_id TEXT,
      idle_restart_minutes INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      role TEXT,
      content TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      created_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_messages_instance_created
      ON messages(instance_id, created_at);

    CREATE TABLE IF NOT EXISTS pipeline_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT,
      description TEXT,
      "column" TEXT DEFAULT 'backlog',
      priority INTEGER DEFAULT 4,
      labels TEXT DEFAULT '[]',
      assigned_agent TEXT,
      group_id TEXT,
      group_index INTEGER,
      group_total INTEGER,
      depends_on TEXT DEFAULT '[]',
      created_by TEXT DEFAULT 'human',
      history TEXT DEFAULT '[]',
      completed_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_project_column
      ON pipeline_tasks(project_id, "column");

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      content TEXT,
      level INTEGER DEFAULT 0,
      skills TEXT DEFAULT '[]',
      mcp_servers TEXT DEFAULT '[]',
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      content TEXT,
      tags TEXT DEFAULT '[]',
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY DEFAULT 1,
      account_level INTEGER DEFAULT 1,
      total_xp INTEGER DEFAULT 0,
      messages_sent INTEGER DEFAULT 0,
      tokens_sent INTEGER DEFAULT 0,
      tokens_received INTEGER DEFAULT 0,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS tour_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      completed_steps TEXT DEFAULT '[]',
      current_level INTEGER DEFAULT 1,
      level_challenges_completed TEXT DEFAULT '[]',
      dismissed_hints TEXT DEFAULT '[]',
      onboarding_complete INTEGER DEFAULT 0,
      guided_mode TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id INTEGER PRIMARY KEY DEFAULT 1,
      access_token TEXT DEFAULT '',
      refresh_token TEXT DEFAULT '',
      expires_at TEXT DEFAULT '',
      verifier TEXT DEFAULT ''
    );
  `)

  setSchemaVersion(1)

  // Insert default settings
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(key, JSON.stringify(value))
  }

  // Insert default profile
  db.prepare('INSERT OR IGNORE INTO profile (id, account_level, total_xp, messages_sent, tokens_sent, tokens_received, created_at) VALUES (1, 1, 0, 0, 0, 0, ?)').run(Date.now())

  // Insert default tour state
  db.prepare("INSERT OR IGNORE INTO tour_state (id, completed_steps, current_level, level_challenges_completed, dismissed_hints, onboarding_complete) VALUES (1, '[]', 1, '[]', '[]', 0)").run()

  // Insert default oauth tokens
  db.prepare("INSERT OR IGNORE INTO oauth_tokens (id, access_token, refresh_token, expires_at, verifier) VALUES (1, '', '', '', '')").run()
}

function migration003(): void {
  // IF NOT EXISTS already makes this idempotent. The try/catch that used to wrap it swallowed
  // every other error too, so a failed CREATE was recorded as applied.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES pipeline_tasks(id) ON DELETE CASCADE,
      author TEXT NOT NULL DEFAULT 'human',
      body TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_comments_task_id ON task_comments(task_id, created_at);
  `)
  setSchemaVersion(3)
}

function migration002(): void {
  // SQLite doesn't support multiple ALTER TABLE in one exec, run each separately
  const columns: Array<[string, string]> = [
    ['folders', 'orchestrator_active INTEGER DEFAULT 0'],
    ['instances', 'agent_role TEXT'],
    ['instances', 'specialization TEXT'],
    ['instances', 'orchestrator_managed INTEGER DEFAULT 0'],
    ['pipeline_tasks', 'locked_by TEXT'],
    ['pipeline_tasks', 'locked_at INTEGER'],
    ['pipeline_tasks', 'retry_count INTEGER DEFAULT 0'],
  ]

  for (const [table, col] of columns) {
    safeAddColumn(table, col)
  }

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  insertSetting.run('orchestratorAgentNames', JSON.stringify({ planner: 'Planner', builder: 'Builder', tester: 'Tester', promoter: 'Promoter' }))
  insertSetting.run('orchestratorAllowSpawn', JSON.stringify(false))

  setSchemaVersion(2)
}

function migration004(): void {
  safeAddColumn('pipeline_tasks', "attachments TEXT DEFAULT '[]'")
  setSchemaVersion(4)
}

function migration005(): void {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('columnLabels', ?)").run(
    JSON.stringify({ backlog: 'Backlog', spec: 'Spec', build: 'Build', qa: 'QA', staging: 'Staging', ship: 'Ship', done: 'Done' })
  )
  setSchemaVersion(5)
}

function migration006(): void {
  // New databases start with no name: the user sets their own in Settings. INSERT OR
  // IGNORE means an existing DB keeps whatever value it already has.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('userName', ?)").run(JSON.stringify(''))
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('userEmoji', ?)").run(JSON.stringify('🧠'))
  setSchemaVersion(6)
}

function migration007(): void {
  safeAddColumn('folders', 'stealth_mode INTEGER DEFAULT 0')
  setSchemaVersion(7)
}

function migration008(): void {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('animationsEnabled', 'true')").run()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('soundsEnabled', 'false')").run()
  setSchemaVersion(8)
}

function migration009(): void {
  db.prepare("UPDATE settings SET value = ? WHERE key = 'columnLabels'").run(
    JSON.stringify({ backlog: 'Inbox', staging: 'Staging / Stuck', spec: 'Planning', build: 'Building', qa: 'Testing', ship: 'Publishing', done: 'Done' })
  )
  setSchemaVersion(9)
}

function migration010(): void {
  // safeAddColumn: a bare ADD COLUMN made this the one migration that could not
  // run twice, so a crash between it and its version row bricked the next boot.
  safeAddColumn('instances', 'xp_total INTEGER DEFAULT 0')
  safeAddColumn('instances', 'level INTEGER DEFAULT 1')
  setSchemaVersion(10)
}

function migration011(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      instance_id TEXT,
      role TEXT,
      task_id TEXT,
      prompt_chars INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_role ON token_usage(role);
  `)
  setSchemaVersion(11)
}

function migration012(): void {
  const columns: Array<[string, string]> = [
    ['instances', 'overdrive_tasks INTEGER DEFAULT 0'],
    ['instances', 'overdrive_started_at INTEGER'],
    ['instances', 'last_task_at INTEGER'],
  ]
  for (const [table, col] of columns) {
    safeAddColumn(table, col)
  }
  setSchemaVersion(12)
}

function migration013(): void {
  const columns: Array<[string, string]> = [
    ['token_usage', 'cache_creation_tokens INTEGER DEFAULT 0'],
    ['token_usage', 'cache_read_tokens INTEGER DEFAULT 0'],
    ['token_usage', 'is_overdrive_session INTEGER DEFAULT 0'],
  ]
  for (const [table, col] of columns) {
    safeAddColumn(table, col)
  }
  setSchemaVersion(13)
}

function migration014(): void {
  // Add schedule/executions/skill columns
  const columns: Array<[string, string]> = [
    ['pipeline_tasks', 'schedule TEXT DEFAULT NULL'],
    ['pipeline_tasks', "executions TEXT DEFAULT '[]'"],
    ['pipeline_tasks', 'skill TEXT DEFAULT NULL'],
  ]
  for (const [table, col] of columns) {
    safeAddColumn(table, col)
  }

  // Migrate staging tasks → backlog with stuck label
  const stagingTasks = db.prepare(
    "SELECT id, labels FROM pipeline_tasks WHERE \"column\" = 'staging'"
  ).all() as Array<{ id: string; labels: string }>
  for (const task of stagingTasks) {
    let labels: string[]
    try { labels = JSON.parse(task.labels || '[]') } catch { labels = [] }
    if (!labels.includes('stuck')) labels.push('stuck')
    db.prepare("UPDATE pipeline_tasks SET \"column\" = 'backlog', labels = ? WHERE id = ?")
      .run(JSON.stringify(labels), task.id)
  }
  if (stagingTasks.length > 0) {
    console.log(`[migration014] Migrated ${stagingTasks.length} staging tasks → backlog with stuck label`)
  }

  // Update columnLabels setting to remove staging, add scheduled
  db.prepare("UPDATE settings SET value = ? WHERE key = 'columnLabels'").run(
    JSON.stringify({ backlog: 'Inbox', scheduled: 'Scheduled', spec: 'Planning', build: 'Building', qa: 'Testing', ship: 'Publishing', done: 'Done' })
  )

  setSchemaVersion(14)
}

function migration015(): void {
  const columns: Array<[string, string]> = [
    ['pipeline_tasks', 'total_input_tokens INTEGER DEFAULT 0'],
    ['pipeline_tasks', 'total_output_tokens INTEGER DEFAULT 0'],
    ['pipeline_tasks', 'total_cost_usd REAL DEFAULT 0'],
  ]
  for (const [table, col] of columns) {
    safeAddColumn(table, col)
  }
  setSchemaVersion(15)
}

function migration016(): void {
  safeAddColumn('instances', 'process_pid INTEGER DEFAULT NULL')
  setSchemaVersion(16)
}

function migration017(): void {
  const columns: Array<[string, string]> = [
    ['agents', 'personality TEXT DEFAULT NULL'],
    ['agents', "source TEXT DEFAULT 'user'"],
  ]
  for (const [table, col] of columns) {
    safeAddColumn(table, col)
  }
  setSchemaVersion(17)
}

function migration018(): void {
  safeAddColumn('pipeline_tasks', 'last_assigned_at INTEGER')
  setSchemaVersion(18)
}

function migration019(): void {
  // a) Create pipeline_blueprints table
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_blueprints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      steps TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  // b) Add role to agents table
  safeAddColumn('agents', 'role TEXT DEFAULT NULL')

  // c) Add pipeline columns to pipeline_tasks
  const columns: Array<[string, string]> = [
    ['pipeline_tasks', 'pipeline_id TEXT DEFAULT NULL'],
    ['pipeline_tasks', 'current_step INTEGER DEFAULT 1'],
    ['pipeline_tasks', 'total_steps INTEGER DEFAULT 1'],
    ['pipeline_tasks', 'current_step_role TEXT DEFAULT NULL'],
    ['pipeline_tasks', 'step_instructions TEXT DEFAULT NULL'],
  ]
  for (const [table, col] of columns) {
    safeAddColumn(table, col)
  }

  // d) Seed default blueprints
  const now = Date.now()
  const defaultBpId = '00000000-0000-0000-0000-000000000001'
  const devBpId = '00000000-0000-0000-0000-000000000002'

  db.prepare(`INSERT OR IGNORE INTO pipeline_blueprints (id, name, steps, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(defaultBpId, 'Default', JSON.stringify([{ role: 'builder' }]), 1, now, now)

  db.prepare(`INSERT OR IGNORE INTO pipeline_blueprints (id, name, steps, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(devBpId, 'Dev Pipeline', JSON.stringify([
      { role: 'planner' },
      { role: 'builder' },
      { role: 'tester' },
      { role: 'promoter' },
    ]), 0, now, now)

  // e) Migrate existing tasks to new column names
  const migrations: Array<{ oldCol: string; newCol: string; pipelineId: string | null; step: number; stepRole: string | null; totalSteps: number }> = [
    { oldCol: 'spec', newCol: 'in_progress', pipelineId: devBpId, step: 1, stepRole: 'planner', totalSteps: 4 },
    { oldCol: 'build', newCol: 'in_progress', pipelineId: devBpId, step: 2, stepRole: 'builder', totalSteps: 4 },
    { oldCol: 'qa', newCol: 'in_progress', pipelineId: devBpId, step: 3, stepRole: 'tester', totalSteps: 4 },
    { oldCol: 'ship', newCol: 'in_progress', pipelineId: devBpId, step: 4, stepRole: 'promoter', totalSteps: 4 },
  ]

  for (const m of migrations) {
    const count = db.prepare(
      `UPDATE pipeline_tasks SET "column" = ?, pipeline_id = ?, current_step = ?, current_step_role = ?, total_steps = ? WHERE "column" = ?`
    ).run(m.newCol, m.pipelineId, m.step, m.stepRole, m.totalSteps, m.oldCol).changes
    if (count > 0) {
      console.log(`[migration019] Migrated ${count} tasks from '${m.oldCol}' → '${m.newCol}' (step ${m.step}/${m.totalSteps})`)
    }
  }

  // Migrate done tasks that have no pipeline_id: assume Dev Pipeline for tasks that went through the old system
  const doneMigrated = db.prepare(
    `UPDATE pipeline_tasks SET pipeline_id = ?, total_steps = 4 WHERE "column" = 'done' AND pipeline_id IS NULL`
  ).run(devBpId).changes
  if (doneMigrated > 0) {
    console.log(`[migration019] Assigned Dev Pipeline to ${doneMigrated} done tasks`)
  }

  // f) Update columnLabels setting
  db.prepare("UPDATE settings SET value = ? WHERE key = 'columnLabels'").run(
    JSON.stringify({ backlog: 'Backlog', ready: 'Ready', in_progress: 'In Progress', in_review: 'In Review', done: 'Done', scheduled: 'Scheduled' })
  )

  setSchemaVersion(19)
}

function migration020(): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pt_locked_by ON pipeline_tasks(locked_by);
    CREATE INDEX IF NOT EXISTS idx_pt_step_role ON pipeline_tasks(current_step_role);
    CREATE INDEX IF NOT EXISTS idx_pt_group_id ON pipeline_tasks(group_id);
    CREATE INDEX IF NOT EXISTS idx_pt_column ON pipeline_tasks("column");
    CREATE INDEX IF NOT EXISTS idx_pt_project_col_prio ON pipeline_tasks(project_id, "column", priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_tu_instance_created ON token_usage(instance_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tu_task_id ON token_usage(task_id);
    CREATE INDEX IF NOT EXISTS idx_inst_state ON instances(state);
    CREATE INDEX IF NOT EXISTS idx_folders_orch ON folders(orchestrator_active);
  `)
  setSchemaVersion(20)
}

function migration021(): void {
  // v3 Architecture: SQLite as single source of truth for process state
  // Replaces 6 in-memory Maps in orchestrator/process-registry
  const columns: Array<[string, string]> = [
    // instances: process lifecycle state machine (idle → reserved → spawning → running → exiting → idle)
    ['instances', "process_state TEXT DEFAULT 'idle'"],
    // Timestamp of last reservation (used for send cooldown)
    ['instances', 'reserved_at INTEGER DEFAULT NULL'],
    // JSON array of assigned task IDs (replaces instanceTaskIds Map)
    ['instances', 'assigned_task_ids TEXT DEFAULT NULL'],
    // Whether this instance is running a scheduler task
    ['instances', 'is_scheduler_run INTEGER DEFAULT 0'],
    // JSON scheduler run context (replaces schedulerRunContexts Map)
    ['instances', 'scheduler_context TEXT DEFAULT NULL'],
    // Optimistic concurrency counter for instances
    ['instances', 'version INTEGER DEFAULT 1'],
    // Optimistic concurrency counter for pipeline_tasks
    ['pipeline_tasks', 'version INTEGER DEFAULT 1'],
    // Lock version: increments on every lock/unlock to prevent stale unlocks
    ['pipeline_tasks', 'lock_version INTEGER DEFAULT 0'],
  ]
  for (const [table, col] of columns) {
    safeAddColumn(table, col)
  }

  // Data migration: map existing state values to process_state
  db.prepare("UPDATE instances SET process_state = state WHERE process_state = 'idle'").run()

  // Indexes for efficient state queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_inst_process_state ON instances(process_state);
    CREATE INDEX IF NOT EXISTS idx_inst_folder_state ON instances(folder_id, process_state);
    CREATE INDEX IF NOT EXISTS idx_tasks_last_assigned ON pipeline_tasks(last_assigned_at);
  `)

  setSchemaVersion(21)
}

function migration022(): void {
  // Cloud Sync: per-folder sync opt-in + tracking columns
  const columns: Array<[string, string]> = [
    ['folders', 'cloud_sync INTEGER DEFAULT 0'],
    ['folders', 'last_synced_at INTEGER DEFAULT NULL'],
    ['folders', 'cloud_last_modified_at INTEGER DEFAULT NULL'],
  ]
  for (const [table, col] of columns) {
    safeAddColumn(table, col)
  }

  // Machine identity. This also seeded the Cloud Sync URL and key, which were removed with
  // the feature (see migration052).
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  insertSetting.run('machineName', JSON.stringify(''))
  insertSetting.run('machineId', JSON.stringify(''))

  setSchemaVersion(22)
}

function migration023(): void {
  // Per-turn cost tracking: one row per assistant response (delta from cumulative CLI totals)
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      folder_id TEXT NOT NULL,
      session_id TEXT,
      message_id TEXT,
      task_id TEXT,
      turn_index INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      duration_ms INTEGER,
      model TEXT,
      cumulative_input INTEGER DEFAULT 0,
      cumulative_output INTEGER DEFAULT 0,
      cumulative_cost REAL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_turn_costs_instance ON turn_costs(instance_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_turn_costs_folder ON turn_costs(folder_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_turn_costs_session ON turn_costs(session_id);
    CREATE INDEX IF NOT EXISTS idx_turn_costs_message ON turn_costs(message_id);
  `)
  setSchemaVersion(23)
}

function migration024(): void {
  // ScheduleWakeup support: agent's tool calls are captured here and fired by wakeup-scheduler.
  // The harness (claude code's interactive runtime) normally drives this, but stream-json mode
  // has no harness - so OrcStrator persists the intent and fires sendMessage when the timer expires.
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_wakeups (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      tool_use_id TEXT,
      fire_at INTEGER NOT NULL,
      delay_seconds INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      fired_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_wakeups_pending_fire_at ON scheduled_wakeups(fire_at) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_wakeups_instance ON scheduled_wakeups(instance_id, status);
  `)
  setSchemaVersion(24)
}

function migration025(): void {
  // Recurring routines: user-defined "run this prompt on this chat instance on a schedule".
  // Distinct from scheduled_wakeups (agent-initiated one-shot self-wakeups) and from
  // pipeline task schedules (orchestrator-driven). routine_runs keeps per-run history + cost.
  db.exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routines_enabled_next ON routines(next_run_at) WHERE enabled = 1;
    CREATE INDEX IF NOT EXISTS idx_routines_instance ON routines(instance_id);

    CREATE TABLE IF NOT EXISTS routine_runs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      cost_usd REAL DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_routine_runs_instance ON routine_runs(instance_id, status);
  `)
  setSchemaVersion(25)
}

function migration026(): void {
  // Cost overhaul:
  // - computed_cost_usd: locally computed API-equivalent cost (pricing table), kept
  //   alongside the CLI-reported cost_usd. Analytics use
  //   COALESCE(NULLIF(cost_usd, 0), computed_cost_usd, 0).
  // - kind: 'turn' (normal result) | 'compact' (pre-turn /compact run) | 'backfill'
  //   (synthetic delta row reconstructed from ~/.claude/projects JSONL files).
  safeAddColumn('turn_costs', 'computed_cost_usd REAL')
  safeAddColumn('turn_costs', "kind TEXT DEFAULT 'turn'")
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_costs_kind ON turn_costs(kind);`)

  // Repair folder attribution: historical rows were written with '' folder_id when the
  // instance lookup missed. Re-resolve through the instances table where possible.
  const repaired = db.prepare(`
    UPDATE turn_costs
    SET folder_id = (SELECT folder_id FROM instances i WHERE i.id = turn_costs.instance_id)
    WHERE (folder_id IS NULL OR folder_id = '')
      AND instance_id IN (SELECT id FROM instances)
  `).run()
  if (repaired.changes > 0) {
    console.log(`[migration026] Repaired folder_id on ${repaired.changes} turn_costs row(s)`)
  }

  // Backfill computed_cost_usd for historical rows where the model is known.
  // Note: turn_costs.input_tokens stores TOTAL input (uncached + cache write + cache read).
  const rows = db.prepare(`
    SELECT id, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, model
    FROM turn_costs WHERE computed_cost_usd IS NULL AND model IS NOT NULL
  `).all() as Array<{ id: number; input_tokens: number; output_tokens: number; cache_creation_tokens: number; cache_read_tokens: number; model: string }>
  const upd = db.prepare('UPDATE turn_costs SET computed_cost_usd = ? WHERE id = ?')
  let computed = 0
  for (const r of rows) {
    const cw = r.cache_creation_tokens || 0
    const cr = r.cache_read_tokens || 0
    const uncached = Math.max(0, (r.input_tokens || 0) - cw - cr)
    // Historical rows: no TTL was recorded, so they stay on the default 5-minute write rate.
    const cost = computeCostUsd({ input: uncached, output: r.output_tokens || 0, cacheWrite: cw, cacheRead: cr }, r.model)
    if (cost != null) { upd.run(cost, r.id); computed++ }
  }
  if (computed > 0) {
    console.log(`[migration026] Computed local cost for ${computed} historical turn_costs row(s)`)
  }

  setSchemaVersion(26)
}

function migration027(): void {
  // Context gauge persistence: ctx_tokens holds the latest turn's total prompt size
  // (input + cache_creation + cache_read = true context occupancy of the last request);
  // ctx_model holds the model that reported it. Written on every `result` event,
  // reset to 0 on compaction, loaded by the /state route so the chat-header gauge
  // survives a server restart / page refresh.
  safeAddColumn('instances', 'ctx_tokens INTEGER DEFAULT 0')
  safeAddColumn('instances', 'ctx_model TEXT DEFAULT NULL')
  setSchemaVersion(27)
}

function migration028(): void {
  // Plan-limits widget visibility (display only, never enforcement). Seed for DBs
  // created before showPlanLimits existed in DEFAULT_SETTINGS.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('showPlanLimits', 'true')").run()
  setSchemaVersion(28)
}

function migration029(): void {
  // Orchestrator removal: OrcStrator no longer auto-assigns tasks to role-based
  // agents. The pipeline survives as a human-driven task board; instances link to
  // at most one task via active_task_id (set by "start instance from task").

  // Indexes referencing soon-to-be-dropped columns must go first (SQLite refuses
  // DROP COLUMN while an index depends on it).
  db.exec(`
    DROP INDEX IF EXISTS idx_folders_orch;
    DROP INDEX IF EXISTS idx_pt_locked_by;
    DROP INDEX IF EXISTS idx_pt_step_role;
    DROP INDEX IF EXISTS idx_tasks_last_assigned;
  `)

  const dropColumns: Array<[string, string]> = [
    ['folders', 'orchestrator_active'],
    ['instances', 'agent_role'],
    ['instances', 'specialization'],
    ['instances', 'orchestrator_managed'],
    ['instances', 'reserved_at'],
    ['instances', 'assigned_task_ids'],
    ['instances', 'is_scheduler_run'],
    ['instances', 'scheduler_context'],
    ['pipeline_tasks', 'assigned_agent'],
    ['pipeline_tasks', 'locked_by'],
    ['pipeline_tasks', 'locked_at'],
    ['pipeline_tasks', 'lock_version'],
    ['pipeline_tasks', 'retry_count'],
    ['pipeline_tasks', 'last_assigned_at'],
    ['pipeline_tasks', 'pipeline_id'],
    ['pipeline_tasks', 'current_step'],
    ['pipeline_tasks', 'total_steps'],
    ['pipeline_tasks', 'current_step_role'],
    ['pipeline_tasks', 'step_instructions'],
    ['pipeline_tasks', 'schedule'],
    ['pipeline_tasks', 'executions'],
  ]
  for (const [table, col] of dropColumns) {
    try {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`)
    } catch (err) {
      // Absent (fresh DB) or already dropped. Anything else is a real failure.
      if (!isNoSuchColumnError(err)) throw err
    }
  }

  db.exec('DROP TABLE IF EXISTS pipeline_blueprints')

  safeAddColumn('instances', 'active_task_id TEXT DEFAULT NULL')

  // The 'scheduled' column no longer exists - routines are the one way to recur.
  db.prepare("UPDATE pipeline_tasks SET \"column\" = 'backlog' WHERE \"column\" = 'scheduled'").run()

  db.prepare(`DELETE FROM settings WHERE key IN (
    'orchestratorAgentNames','orchestratorAllowSpawn','orchestratorMcpServers',
    'orchestratorModels','orchestratorTools','orchestratorEffort',
    'last_restart_at','restart_adopted_count','restart_deactivated_folders'
  )`).run()

  // Strip the dead 'scheduled' key from the columnLabels setting
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'columnLabels'").get() as { value: string } | undefined
    if (row) {
      const labels = JSON.parse(row.value) as Record<string, string>
      delete labels.scheduled
      db.prepare("UPDATE settings SET value = ? WHERE key = 'columnLabels'").run(JSON.stringify(labels))
    }
  } catch { /* non-critical */ }

  setSchemaVersion(29)
}

function migration030(): void {
  // start-from-task: the instance that is working / last worked a task
  safeAddColumn('pipeline_tasks', 'instance_id TEXT DEFAULT NULL')
  setSchemaVersion(30)
}

function migration031(): void {
  // File-lock safety layer: uncommitted-edit locks per absolute path
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_locks (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_locks_cwd ON file_locks(cwd);
    CREATE INDEX IF NOT EXISTS idx_file_locks_instance ON file_locks(instance_id);
  `)
  setSchemaVersion(31)
}

function migration032(): void {
  // Keep-warm: when set, the server fires a minimal keep-alive turn before the prompt
  // cache TTL expires so the session never pays a cold-start re-read. User-toggled
  // via the 🔥 chip in the sidebar. Display/automation only - never enforced.
  safeAddColumn('instances', 'keep_warm INTEGER DEFAULT 0')
  setSchemaVersion(32)
}

function migration033(): void {
  // At-rest secret store, separate from the `settings` table on purpose: `settings`
  // is serialized wholesale to the client (GET /settings, /state, the settings:updated
  // broadcast), so a secret placed there would ship to the browser. `secrets` is never
  // serialized - values are AES-256-GCM encrypted (secret-box) and exposed only as a
  // boolean "is it set?". First use: the user's Anthropic API key for AI session naming.
  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `)
  setSchemaVersion(33)
}

function migration034(): void {
  // Estimated tool-output compaction savings, fed by the PostToolUse hook's telemetry log
  // (ingest-on-read in services/compaction-savings.ts). One row per compacted tool result;
  // saved_tokens is an estimate derived from the byte delta.
  db.exec(`
    CREATE TABLE IF NOT EXISTS compaction_savings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      session_id TEXT,
      instance_id TEXT,
      folder_id TEXT,
      model TEXT,
      tool_name TEXT,
      before_chars INTEGER NOT NULL DEFAULT 0,
      after_chars INTEGER NOT NULL DEFAULT 0,
      saved_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_compaction_savings_created ON compaction_savings(created_at);
  `)
  setSchemaVersion(34)
}

function migration035(): void {
  // Repair cwd casing. Windows is case-insensitive but case-PRESERVING, so a folder added
  // as "C:\Code\foo" when the real directory is "C:\code\foo" opens fine and reads
  // wrong. Claude Code records the spawn cwd into the session's worktree binding at
  // EnterWorktree time and later compares it against the path git reports (always the real
  // casing); a mismatch makes every subsequent --resume abort with "cannot resume into
  // worktree ... a core.worktree redirect", exit 1, before any result event, and the
  // session dies with nothing shown in the chat.
  let fixed = 0
  for (const [table, column] of [['folders', 'path'], ['instances', 'cwd']] as const) {
    const rows = db.prepare(`SELECT id, ${column} AS p FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`).all() as Array<{ id: string; p: string }>
    for (const row of rows) {
      const canonical = canonicalizeCwd(row.p)
      if (canonical === row.p) continue
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(canonical, row.id)
      fixed++
    }
  }
  if (fixed > 0) console.log(`[db] migration035: corrected casing on ${fixed} stored path(s)`)

  // Clear context-gauge values written by the old summed-input bug. ctx_tokens used to be
  // fed the result event's input total, which the CLI sums over every request in the turn -
  // an hour-plus turn could store close to 100M and pin the header gauge at 100%. No real
  // prompt exceeds the largest context window, so anything above it is a corrupt reading,
  // not a big session. Zeroing shows the empty-gauge placeholder until the next turn records a true value.
  const MAX_PLAUSIBLE_CTX = 2_000_000
  const cleared = db.prepare('UPDATE instances SET ctx_tokens = 0 WHERE ctx_tokens > ?').run(MAX_PLAUSIBLE_CTX)
  if (cleared.changes > 0) console.log(`[db] migration035: cleared ${cleared.changes} corrupt ctx_tokens reading(s)`)

  setSchemaVersion(35)
}

function migration036(): void {
  // Turn duration surfacing. The CLI's result event already carries duration_ms and it is
  // already stored per turn in turn_costs; these two columns are a denormalized cache so the
  // client gets both numbers on the instance object it already holds, with no per-message
  // column and no join on every message fetch.
  //
  //   last_turn_ms - duration of the most recent turn, drives the "worked for" footnote
  //   max_turn_ms  - longest single turn this chat has ever run, drives the record
  //
  // max_turn_ms is a MONOTONIC MAXIMUM, never an overwrite (see claude-process.ts). Setting
  // both to the current turn would silently turn the record into "most recent turn".
  // Structural only, and deliberately left that way. A historical backfill from turn_costs
  // was considered and declined: it
  // rewrites every row of the only copy of every chat ever held, and buys nothing but not
  // waiting one turn per chat. Both columns therefore start NULL on existing chats and fill
  // in as each one next runs a turn. The all-time record is unaffected, since
  // /usage/longest-turns reads turn_costs directly.
  safeAddColumn('instances', 'last_turn_ms INTEGER')
  safeAddColumn('instances', 'max_turn_ms INTEGER')
  setSchemaVersion(36)
}

function migration037(): void {
  // Active-tab truth: record WHY a turn ended when it ended on an interactive card.
  //
  // AskUserQuestion / ExitPlanMode deliberately kill the process (hardStopForQuestion in
  // claude-process.ts) so the card is the last thing on screen, and the exit handler then
  // sets state = 'idle'. That made "blocked on the user" indistinguishable from "finished",
  // so the instance dropped straight out of the top-bar active strip. On a FIRST turn there
  // is no warm prompt cache to hold it there either, so it vanished completely.
  //
  //   awaiting_input     - 'question' | 'plan', NULL when nothing is pending
  //   awaiting_input_at  - epoch ms the wait began, so the oldest block can sort first
  //
  // Additive and nullable: every existing row reads NULL, which means "not waiting", which
  // is the behaviour from before this column existed. Deliberately NOT cleared by the
  // startup reconcile - a question that survived a restart is still unanswered.
  safeAddColumn('instances', 'awaiting_input TEXT')
  safeAddColumn('instances', 'awaiting_input_at INTEGER')
  setSchemaVersion(37)
}

function migration038(): void {
  // The last five orchestrator fields. migration029 removed the orchestration layer but
  // left these behind, and a review of the pipeline proved every one of them renders somewhere
  // and reaches nothing: a task carrying a skill, an attachment and an unmet dependency
  // started anyway with none of them honoured, because buildKickoffPrompt interpolates
  // only title, description and comments.
  //
  //   skill        - a badge on the card; the runner never read it
  //   depends_on   - an unmet dependency never blocked a start
  //   group_id     - "2/5" style batch badges from the removed orchestrator
  //   group_index
  //   group_total
  //
  // Attachments were the one member of that group worth keeping, so they were WIRED UP
  // rather than dropped: they now ride inline into the kickoff prompt.
  //
  // Irreversible. Nothing reads these columns as of the commit that adds this migration.

  // SQLite refuses DROP COLUMN while an index depends on the column.
  db.exec('DROP INDEX IF EXISTS idx_pt_group_id;')

  for (const col of ['skill', 'depends_on', 'group_id', 'group_index', 'group_total']) {
    try {
      db.exec(`ALTER TABLE pipeline_tasks DROP COLUMN ${col}`)
    } catch (err) {
      // Absent (fresh DB) or already dropped. Anything else is a real failure.
      if (!isNoSuchColumnError(err)) throw err
    }
  }

  setSchemaVersion(38)
}

function migration039(): void {
  // Per-chat overrides of the Claude CLI settings OrcStrator now manages (Settings ->
  // Claude Behaviour). NULL means "inherit the app-wide setting", which is why neither
  // column has a DEFAULT: an empty string would be indistinguishable from "explicitly
  // set to the CLI default", and the two need different spawn args.
  const columns: Array<[string, string]> = [
    ['instances', 'output_style TEXT DEFAULT NULL'],
    ['instances', 'language TEXT DEFAULT NULL'],
  ]
  for (const [table, col] of columns) {
    safeAddColumn(table, col)
  }

  setSchemaVersion(39)
}

function migration040(): void {
  // Closing a chat hard-deletes its `instances` row, and every analytics query resolved
  // a chat's name and folder by joining that row. So a close silently relabelled all of
  // that chat's history to the literal "chat" (the UI's fallback to `role`) and, in
  // /usage/longest-turns, dropped it from the ranking outright.
  //
  // A tombstone fixes it: the trigger copies the identifying fields on the way out, and
  // `instances_all` is the union every analytics query reads instead of `instances`, so
  // the join keeps resolving after the close without changing the shape of any query.
  //
  // The trigger rather than per-route code, because there are five separate
  // DELETE FROM instances sites (close, secure-close, folder delete, close-all, renew)
  // and a sixth added later would silently reopen the bug. Note the folders -> instances
  // FK cascade does NOT fire triggers without recursive_triggers, which is fine: every
  // folder path deletes its instances explicitly first, so the cascade only ever runs
  // against rows that are already gone.
  db.exec(`
    CREATE TABLE IF NOT EXISTS closed_instances (
      id TEXT PRIMARY KEY,
      name TEXT,
      folder_id TEXT,
      cwd TEXT,
      session_id TEXT,
      -- 'live'    the name the chat actually carried when it was closed.
      -- 'derived' reconstructed after the fact from the transcript's first prompt, for
      --           chats closed before this table existed. A guess, and the UI says so.
      name_source TEXT NOT NULL DEFAULT 'live',
      closed_at INTEGER NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS trg_instances_tombstone
    AFTER DELETE ON instances
    BEGIN
      INSERT OR REPLACE INTO closed_instances (id, name, folder_id, cwd, session_id, name_source, closed_at)
      VALUES (
        OLD.id, OLD.name, OLD.folder_id, OLD.cwd, OLD.session_id, 'live',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      );
    END;

    CREATE VIEW IF NOT EXISTS instances_all AS
      SELECT id, folder_id, name, cwd, session_id, 'live' AS name_source, 0 AS is_closed, NULL AS closed_at
      FROM instances
      UNION ALL
      SELECT id, folder_id, name, cwd, session_id, name_source, 1 AS is_closed, closed_at
      FROM closed_instances
      WHERE id NOT IN (SELECT id FROM instances);
  `)

  setSchemaVersion(40)
}

function migration041(): void {
  // A session-log task carried exactly one date, `created_at`, and that date is the moment
  // the chat was CLOSED, not the moment the work happened. Chats often sit open for weeks,
  // so created_at is not when the work happened: "show me the last two weeks" could return
  // a session whose work ended long before it was closed.
  //
  // These two columns record the span the work actually occupied. Nullable on purpose:
  // a hand-filed task never had a session, and NULL says that honestly where a zero or a
  // copy of created_at would quietly lie.
  const columns: Array<[string, string]> = [
    ['pipeline_tasks', 'work_started_at INTEGER DEFAULT NULL'],
    ['pipeline_tasks', 'work_ended_at INTEGER DEFAULT NULL'],
  ]
  for (const [table, col] of columns) {
    safeAddColumn(table, col)
  }

  setSchemaVersion(41)
}

function migration042(): void {
  // Routine queueing. Before this, a routine that came due while its instance was busy
  // was recorded as 'skipped' and its slot pushed to the next occurrence: for a one-off
  // reminder that is silent loss. Now the slot is kept and the scheduler retries every
  // poll until the instance is idle. queued_since records when that wait began so the
  // wait can be bounded and the UI can show "waiting for instance". NULL = not waiting.
  safeAddColumn('routines', 'queued_since INTEGER DEFAULT NULL')
  setSchemaVersion(42)
}

function migration043(): void {
  // Per-chat permission rules. One JSON column rather than five, because the five lists are
  // always read and written together as a single grant and nothing ever queries one of them
  // on its own. NULL means the chat adds nothing of its own, which is true of almost every
  // chat, so the column stays empty for nearly every row.
  safeAddColumn('instances', 'permission_rules TEXT DEFAULT NULL')
  setSchemaVersion(43)
}

function migration044(): void {
  // A routine must know its folder so it can survive its instance. Until now a routine
  // borrowed its project from the instance it fires on, and deleting that instance took the
  // folder_id and cwd with it: the routine could not be placed on the board, let alone run,
  // so the scheduler switched it off on the next fire. With a folder of its own the
  // scheduler can spawn a fresh instance in that folder when the target is gone.
  // Backfilled from the current target. A routine whose instance was already deleted
  // before this migration has nothing to backfill from and stays NULL, which keeps the
  // disable-on-fire behaviour for it, with the reason said plainly in its run history.
  safeAddColumn('routines', 'folder_id TEXT DEFAULT NULL')
  db.prepare(`
    UPDATE routines
    SET folder_id = (SELECT folder_id FROM instances WHERE instances.id = routines.instance_id)
    WHERE folder_id IS NULL
  `).run()
  setSchemaVersion(44)
}

/**
 * Split a CREATE TABLE body on its top-level commas: parentheses, quotes and brackets are
 * respected, so `CHECK (a IN (1, 2))` or a DEFAULT holding a comma stays one piece.
 */
export function splitTopLevel(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) {
      cur += ch
      if (ch === quote) {
        if (body[i + 1] === quote) { cur += body[++i]; continue } // doubled quote = escaped
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue }
    if (ch === '[') { quote = ']'; cur += ch; continue }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** Remove NOT NULL (and any ON CONFLICT clause attached to it) from ONE column definition, outside parentheses. */
function stripNotNull(def: string): string {
  let depth = 0
  let out = ''
  for (let i = 0; i < def.length; i++) {
    const ch = def[i]
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth === 0) {
      const m = /^NOT\s+NULL(\s+ON\s+CONFLICT\s+\w+)?/i.exec(def.slice(i))
      if (m && /\s/.test(def[i - 1] ?? ' ')) { i += m[0].length - 1; continue }
    }
    out += ch
  }
  return out.replace(/\s{2,}/g, ' ')
}

/**
 * Build the CREATE TABLE statement for `table` with NOT NULL removed from `column` and
 * NOTHING else changed. Works on the table's own stored SQL, so every CHECK,
 * UNIQUE, FOREIGN KEY, COLLATE and table option survives. The old version rebuilt the table
 * from `PRAGMA table_info`, which knows none of those, and silently dropped them.
 */
export function createSqlWithoutNotNull(storedSql: string, column: string, newName: string): string {
  const open = storedSql.indexOf('(')
  const close = storedSql.lastIndexOf(')')
  if (open < 0 || close < open) throw new Error(`cannot parse CREATE TABLE: ${storedSql.slice(0, 80)}`)
  const parts = splitTopLevel(storedSql.slice(open + 1, close))
  const colName = (p: string) => {
    const m = /^\s*(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))/.exec(p)
    return m ? (m[1]?.replace(/""/g, '"') ?? m[2] ?? m[3] ?? m[4]) : null
  }
  let hit = 0
  const rebuilt = parts.map(p => {
    if (colName(p)?.toLowerCase() !== column.toLowerCase()) return p
    hit++
    return stripNotNull(p)
  })
  if (hit !== 1) throw new Error(`column ${column} not found exactly once in the stored CREATE TABLE`)
  return `CREATE TABLE "${newName}" (${rebuilt.join(',')})${storedSql.slice(close + 1)}`
}

/**
 * Drop a NOT NULL constraint from one column. SQLite has no ALTER COLUMN, so the table is
 * rebuilt from its own stored SQL with only that constraint removed (SQLite's documented
 * 12-step procedure, steps that apply here), the data copied, and every index and trigger
 * recreated from its stored SQL (dropping a table drops both). Runs inside the migration's
 * transaction, so a failure halfway leaves the original table untouched.
 *
 * Refuses a table that other tables reference: with foreign keys on, DROP TABLE runs an
 * implicit DELETE that would fire their ON DELETE actions, and foreign keys cannot be turned
 * off inside a transaction. No such rebuild exists today; this makes sure one never runs.
 */
function dropNotNull(table: string, column: string): void {
  interface ColInfo { name: string; notnull: number }
  const info = db.prepare(`PRAGMA table_info("${table}")`).all() as ColInfo[]
  const target = info.find(c => c.name === column)
  if (!target || target.notnull === 0) return

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
  for (const t of tables) {
    const fks = db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as Array<{ table: string }>
    if (t.name !== table && fks.some(fk => fk.table.toLowerCase() === table.toLowerCase())) {
      throw new Error(`dropNotNull: refusing to rebuild ${table}, table ${t.name} references it`)
    }
  }

  const stored = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }
  const dependents = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = ? AND sql IS NOT NULL"
  ).all(table) as Array<{ sql: string }>
  const names = info.map(c => `"${c.name}"`).join(', ')

  db.transaction(() => {
    db.exec(createSqlWithoutNotNull(stored.sql, column, `${table}__rebuild`))
    db.exec(`INSERT INTO "${table}__rebuild" (${names}) SELECT ${names} FROM "${table}"`)
    db.exec(`DROP TABLE "${table}"`)
    db.exec(`ALTER TABLE "${table}__rebuild" RENAME TO "${table}"`)
    for (const d of dependents) db.exec(d.sql)
  })()
}

/** Test hook: the rebuild helper, against whatever `db` is open. */
export const _dropNotNull = dropNotNull

function migration045(): void {
  // A routine may now be aimed at a PROJECT instead of a chat: leave the chat unpicked and
  // every fire opens a fresh one in the folder. That is not a new mechanism, it is the
  // orphan fallback (see spawnReplacementInstance) reached on purpose rather than by a chat
  // being closed, so the only thing standing in the way was instance_id being NOT NULL on
  // both routines and its run history.
  dropNotNull('routines', 'instance_id')
  dropNotNull('routine_runs', 'instance_id')
  setSchemaVersion(45)
}

function migration046(): void {
  // A scheduled fire (routine or wake-up) SURFACES its chat: it becomes a grid tile, glows
  // once, and holds a bright "scheduled, waiting on you" status until the chat is read.
  // surfaced_at is the server-side truth for that status, so it survives the app being
  // closed; the client clears it through /surface-ack when the chat is actually looked at.
  // surface_silent is stamped on the chat at spawn from the routine's own silent flag, so a
  // wake-up scheduled from inside a silent run inherits the silence with no lookup at fire.
  safeAddColumn('instances', 'surfaced_at INTEGER DEFAULT NULL')
  safeAddColumn('instances', 'surfaced_source TEXT DEFAULT NULL')
  safeAddColumn('instances', 'surface_silent INTEGER NOT NULL DEFAULT 0')
  // Per-routine silent mode. Off by default so every existing routine keeps surfacing.
  safeAddColumn('routines', 'silent INTEGER NOT NULL DEFAULT 0')
  setSchemaVersion(46)
}

/**
 * Manual placements for routines that had no folder of their own AND whose target chat was
 * already deleted, so migration044's backfill had nothing to read. A card with no project
 * cannot be drawn on the board. Keyed routine id -> folder id, by UUID only. Empty: the
 * one-off placements it once held applied to a single database that has long since run this
 * migration, and a numbered migration never runs twice.
 *
 * A routine that is still unplaceable after this lookup is never guessed at. The whole
 * migration is skipped with a warning and the routines tables are left intact for manual
 * recovery, rather than throwing and stopping the app from booting.
 */
const ORPHAN_ROUTINE_PROJECTS: Record<string, string> = {}

function migration047(): void {
  // ── The routines/pipeline_tasks merge ─────────────────────────────────────────────
  // A routine becomes a pipeline task that carries a schedule. One entity, one board, one
  // lifecycle, one run history. `routines` and `routine_runs` are dropped at the end of
  // this function, and ONLY after the row-for-row reconciliation below passes.
  //
  // Two identity columns, never one. target_instance_id is CONFIG (the chat to fire at,
  // null = a fresh chat per run); instance_id is RUNTIME (the chat that is working or last
  // worked this card). On a routine the single instance_id meant the first; on a task it
  // means the second. Same name, opposite direction. Collapsing them makes a scheduled card
  // silently re-point itself at whatever chat last ran it.
  const scheduleCols: Array<[string, string]> = [
    ['schedule_kind', 'TEXT DEFAULT NULL'],
    ['schedule_value', 'TEXT DEFAULT NULL'],
    ['schedule_enabled', 'INTEGER NOT NULL DEFAULT 0'],
    ['next_run_at', 'INTEGER DEFAULT NULL'],
    ['last_run_at', 'INTEGER DEFAULT NULL'],
    ['queued_since', 'INTEGER DEFAULT NULL'],
    ['target_instance_id', 'TEXT DEFAULT NULL'],
    ['silent', 'INTEGER NOT NULL DEFAULT 0'],
    ['raw_prompt', 'INTEGER NOT NULL DEFAULT 0'],
    // Run settings. NULL means INHERIT the global default, never "off": change the default
    // in Settings and every unset card follows it. Freezing today's default into every existing row
    // would quietly make the Settings page a lie.
    ['model', 'TEXT DEFAULT NULL'],
    ['effort', 'TEXT DEFAULT NULL'],
    ['permission_mode', 'TEXT DEFAULT NULL'],
    ['max_budget_usd', 'REAL DEFAULT NULL'],
    ['fallback_model', 'TEXT DEFAULT NULL'],
    ['output_style', 'TEXT DEFAULT NULL'],
    ['language', 'TEXT DEFAULT NULL'],
  ]
  for (const [name, def] of scheduleCols) safeAddColumn('pipeline_tasks', `${name} ${def}`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      instance_id TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      cost_usd REAL DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_runs_instance ON task_runs(instance_id, status);
  `)

  // Nothing to migrate on a fresh DB that never had the routines table.
  const hasRoutines = db.prepare(
    "SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = 'routines'"
  ).get() as { c: number }
  if (hasRoutines.c === 0) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_next_run ON pipeline_tasks(next_run_at) WHERE schedule_enabled = 1')
    setSchemaVersion(47)
    return
  }

  interface OldRoutine {
    id: string; name: string; instance_id: string | null; folder_id: string | null
    prompt: string; schedule_kind: string; schedule_value: string
    enabled: number; silent: number
    last_run_at: number | null; next_run_at: number | null; queued_since: number | null
    created_at: number
  }
  const routines = db.prepare('SELECT * FROM routines').all() as OldRoutine[]
  const tasksBefore = (db.prepare('SELECT COUNT(*) c FROM pipeline_tasks').get() as { c: number }).c
  const runsBefore = (db.prepare('SELECT COUNT(*) c FROM routine_runs').get() as { c: number }).c

  // Resolve every project BEFORE writing anything, so a routine we cannot place stops the
  // migration instead of landing on the board as an unreachable card.
  const placements = new Map<string, string>()
  const unplaceable: string[] = []
  for (const r of routines) {
    // Same rule the board used: the folder of the target chat while it exists, else the
    // routine's own folder, else the evidence-based table above.
    const viaInstance = r.instance_id
      ? (db.prepare('SELECT folder_id FROM instances WHERE id = ?').get(r.instance_id) as { folder_id: string } | undefined)?.folder_id
      : undefined
    const projectId = viaInstance ?? r.folder_id ?? ORPHAN_ROUTINE_PROJECTS[r.id]
    const folderExists = projectId
      ? (db.prepare('SELECT 1 FROM folders WHERE id = ?').get(projectId) as unknown) != null
      : false
    if (!projectId || !folderExists) unplaceable.push(`${r.id} "${r.name}" (folder_id=${r.folder_id}, instance_id=${r.instance_id})`)
    else placements.set(r.id, projectId)
  }
  // Nothing is written, nothing is dropped, and the app still boots: the old tables stay
  // behind untouched so the routines can be recovered by hand.
  const skipMerge = (reason: string): void => {
    console.warn(`[db] migration047 skipped the routines merge, routines/routine_runs left intact: ${reason}`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_next_run ON pipeline_tasks(next_run_at) WHERE schedule_enabled = 1')
    setSchemaVersion(47)
  }
  if (unplaceable.length > 0) {
    skipMerge(`${unplaceable.length} routine(s) have no project to live under: ${unplaceable.join('; ')}`)
    return
  }

  // The last run of each routine, needed to reproduce the board's own bucketing exactly.
  const lastRunOf = new Map<string, { status: string; error: string | null; started_at: number }>()
  for (const r of db.prepare(
    `SELECT routine_id, status, error, started_at FROM routine_runs
     WHERE (routine_id, started_at) IN (SELECT routine_id, MAX(started_at) FROM routine_runs GROUP BY routine_id)`
  ).all() as Array<{ routine_id: string; status: string; error: string | null; started_at: number }>) {
    lastRunOf.set(r.routine_id, r)
  }

  // routineBoard.ts's rules, reproduced so the board looks unchanged the morning after:
  // a run in flight is In Progress; a fired one-off and a routine the scheduler stopped for
  // having nowhere to fire are Done; everything else, armed or merely paused, is Backlog.
  function columnFor(r: OldRoutine): string {
    const lastRun = lastRunOf.get(r.id)
    if (lastRun?.status === 'running') return 'in_progress'
    const firedOnce = r.schedule_kind === 'once' && !r.enabled && r.last_run_at != null
    const disarmed = !r.enabled && lastRun?.status === 'skipped' && /no folder/i.test(lastRun.error ?? '')
    return firedOnce || disarmed ? 'done' : 'backlog'
  }

  const insertTask = db.prepare(`
    INSERT INTO pipeline_tasks (
      id, project_id, title, description, "column", priority, labels, created_by, history,
      completed_at, created_at, updated_at, attachments,
      total_input_tokens, total_output_tokens, total_cost_usd, version, instance_id,
      schedule_kind, schedule_value, schedule_enabled, next_run_at, last_run_at, queued_since,
      target_instance_id, silent, raw_prompt
    ) VALUES (
      @id, @project_id, @title, @description, @column, 3, '["routine"]', 'routine-migration', '[]',
      @completed_at, @created_at, @updated_at, '[]',
      0, 0, 0, 1, NULL,
      @schedule_kind, @schedule_value, @schedule_enabled, @next_run_at, @last_run_at, @queued_since,
      @target_instance_id, @silent, 1
    )
  `)

  const migrate = db.transaction(() => {
    const now = Date.now()
    for (const r of routines) {
      const column = columnFor(r)
      insertTask.run({
        id: r.id, // keep the UUID, so routine_runs.routine_id becomes task_runs.task_id with no remap
        project_id: placements.get(r.id)!,
        title: r.name,
        description: r.prompt,
        column,
        completed_at: column === 'done' ? (r.last_run_at ?? now) : null,
        created_at: r.created_at,
        updated_at: now,
        schedule_kind: r.schedule_kind,
        schedule_value: r.schedule_value,
        schedule_enabled: r.enabled,
        next_run_at: r.next_run_at,
        last_run_at: r.last_run_at,
        queued_since: r.queued_since,
        // The routine's instance_id was always "the chat to FIRE AT", which is config.
        // It becomes target_instance_id. pipeline_tasks.instance_id (runtime) stays NULL:
        // no run has happened under the new model yet.
        target_instance_id: r.instance_id,
        silent: r.silent,
      })
    }

    // Runs whose routine is already gone. Deleting a routine has never cascaded to its runs
    // (routes/routines.ts issues a bare DELETE FROM routines), so these have been dangling
    // since the day each routine was deleted, and their instances are gone too. They are
    // carried over ONLY if a card exists to hang them on; the count is reported either way
    // rather than being swept up silently.
    db.prepare(`
      INSERT INTO task_runs (id, task_id, instance_id, started_at, finished_at, status, error, cost_usd, input_tokens, output_tokens)
      SELECT id, routine_id, instance_id, started_at, finished_at, status, error, cost_usd, input_tokens, output_tokens
      FROM routine_runs
      WHERE routine_id IN (SELECT id FROM pipeline_tasks)
    `).run()

    // ── Reconcile BEFORE dropping, inside the same transaction. One row that does not add
    // up throws here, which rolls back every insert above, and the merge is skipped.
    const tasksAfter = (db.prepare('SELECT COUNT(*) c FROM pipeline_tasks').get() as { c: number }).c
    const runsCopied = (db.prepare('SELECT COUNT(*) c FROM task_runs').get() as { c: number }).c
    const orphanRuns = (db.prepare(
      'SELECT COUNT(*) c FROM task_runs WHERE task_id NOT IN (SELECT id FROM pipeline_tasks)'
    ).get() as { c: number }).c
    const unreachable = (db.prepare(
      'SELECT COUNT(*) c FROM routine_runs WHERE routine_id NOT IN (SELECT id FROM pipeline_tasks)'
    ).get() as { c: number }).c
    const armedKept = (db.prepare(
      'SELECT COUNT(*) c FROM pipeline_tasks WHERE schedule_enabled = 1 AND next_run_at IS NOT NULL'
    ).get() as { c: number }).c
    const armedBefore = (db.prepare(
      'SELECT COUNT(*) c FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL'
    ).get() as { c: number }).c

    const problems: string[] = []
    if (tasksAfter !== tasksBefore + routines.length) problems.push(`expected ${tasksBefore + routines.length} tasks, found ${tasksAfter}`)
    if (runsCopied + unreachable !== runsBefore) problems.push(`${runsCopied} copied + ${unreachable} unreachable != ${runsBefore} routine_runs`)
    if (orphanRuns !== 0) problems.push(`${orphanRuns} task_runs row(s) point at no task`)
    if (armedKept !== armedBefore) problems.push(`${armedBefore} armed routine(s) went in, ${armedKept} armed card(s) came out`)
    if (problems.length > 0) throw new Error(`reconciliation failed: ${problems.join('; ')}`)
    return { tasksAfter, runsCopied, unreachable, armedKept }
  })

  // Any failure inside the transaction (reconciliation or SQL) has already been rolled
  // back, so the old tables are exactly as they were: skip rather than stop the boot.
  let result: { tasksAfter: number; runsCopied: number; unreachable: number; armedKept: number }
  try {
    result = migrate()
  } catch (e) {
    skipMerge(`rolled back, ${(e as Error).message}`)
    return
  }
  const { tasksAfter, runsCopied, unreachable, armedKept } = result

  console.log(
    `[db] migration047: merged ${routines.length} routine(s) into pipeline_tasks ` +
    `(${tasksBefore} -> ${tasksAfter}), copied ${runsCopied} run(s), kept ${armedKept} armed schedule(s).`
  )
  if (unreachable > 0) {
    const ids = (db.prepare(
      'SELECT DISTINCT routine_id FROM routine_runs WHERE routine_id NOT IN (SELECT id FROM pipeline_tasks)'
    ).all() as Array<{ routine_id: string }>).map(r => r.routine_id.slice(0, 8)).join(', ')
    console.warn(
      `[db] migration047: ${unreachable} run(s) belonged to routine(s) deleted before this migration ` +
      `(${ids}) and had nothing to attach to. They were left behind with the dropped table.`
    )
  }

  db.exec('DROP TABLE routine_runs')
  db.exec('DROP TABLE routines')
  db.exec('CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_next_run ON pipeline_tasks(next_run_at) WHERE schedule_enabled = 1')
  setSchemaVersion(47)
}

function migration048(): void {
  // ── Scheduler v2: a schedule anybody can describe in a sentence ─────────────────
  //
  // Three kinds that did not compose (`interval` had no days and no window, `weekly`
  // had days but exactly one time) collapse into two that do:
  //
  //   'every'  N minutes, anchored on the ACTIVE WINDOW OPEN, filtered by days
  //   'times'  a list of clock times, filtered by days
  //   'once'   untouched
  //
  // "Every 5 hours, 11:00 to 19:00, on Tue Wed Thu Fri and Sun" was unexpressible
  // before this. It is one row now.
  //
  // Every column here is ADDITIVE. Nothing is dropped and nothing is rewritten: the
  // live server keeps running the old code against this schema until it is restarted,
  // and a column it has never heard of costs it nothing.
  const cols: Array<[string, string]> = [
    // ── The schedule itself ──
    // Date.getDay() numbers as 'D,D,D', ascending and unique. NULL = every day.
    ['schedule_days', 'TEXT DEFAULT NULL'],
    // 'HH:MM-HH:MM' on 'every' only. NULL = the whole day. end <= start means overnight.
    ['schedule_window', 'TEXT DEFAULT NULL'],
    // IANA zone name. NULL = computer time, read fresh at every computation, so a laptop
    // that flies abroad takes its routines with it. Deliberately NOT stamped by this
    // migration: stamping would freeze every existing routine to the zone it was sitting
    // in on the day it ran, which is the opposite of what "computer time" means.
    ['schedule_tz', 'TEXT DEFAULT NULL'],
    // ── The end condition ──
    ['schedule_until', 'TEXT DEFAULT NULL'],       // 'YYYY-MM-DD', inclusive, in the card zone
    ['schedule_max_runs', 'INTEGER DEFAULT NULL'], // stop after this many
    ['run_count', 'INTEGER NOT NULL DEFAULT 0'],
    // ── What happens when a slot is missed, fails, or costs too much ──
    ['catchup_policy', "TEXT NOT NULL DEFAULT 'late'"], // 'late' | 'skip'
    ['consecutive_failures', 'INTEGER NOT NULL DEFAULT 0'],
    // 3 rather than 0: a card that has failed three times running is broken, and the
    // default has to be the safe one. 0 means never disarm, for somebody who wants that.
    ['disarm_after_failures', 'INTEGER NOT NULL DEFAULT 3'],
    ['max_run_minutes', 'INTEGER DEFAULT NULL'],
    // NULL = no limit, which is the default: the cost ceiling is a seatbelt, not a budget.
    ['budget_cap_usd', 'REAL DEFAULT NULL'],
    // ── Hygiene ──
    ['auto_compact', 'INTEGER NOT NULL DEFAULT 0'],
    ['auto_close', 'INTEGER NOT NULL DEFAULT 0'],
    // The session an auto-close left behind, so the next fire can carry on from it.
    // A THIRD identity column, and it is not target_instance_id: the card is still aimed
    // at its project, this is only the history the fresh chat resumes.
    ['resume_session_id', 'TEXT DEFAULT NULL'],
    // NULL normally. 'finished' | 'failed' | 'over_budget' when the card is in a state
    // the board has to explain rather than just showing a next-run time.
    ['schedule_state', 'TEXT DEFAULT NULL'],
  ]
  for (const [name, def] of cols) safeAddColumn('pipeline_tasks', `${name} ${def}`)
  // 'scheduled' | 'manual'. A manual Run now is not a missed slot and not a failure, and
  // the budget sum has to be able to tell the two apart.
  safeAddColumn('task_runs', "kind TEXT NOT NULL DEFAULT 'scheduled'")

  // ── Convert the old kinds. No dual-read period: the validator rejects them after this. ──
  //   interval N <= 1439 -> every N,     no days, no window
  //   interval N >  1439 -> times 00:00, no days   (see LONG INTERVALS below)
  //   daily HH:MM        -> times HH:MM, no days
  //   weekly D,D@HH:MM   -> times HH:MM, days D,D
  //
  // LONG INTERVALS, and why they do not become `every N`.
  //   The new grid is anchored on the active window open and restarts at every opening.
  //   With no window that window is 00:00 to 23:59, so the longest cadence that can fire
  //   twice in a day is 1439 minutes. `every 2880` would therefore fire at midnight EVERY
  //   day while the card went on claiming it ran every two days: seven times the fires for
  //   a weekly card, seven times the Claude processes, and a pill that lies about it.
  //   The fire times are identical either way, so the honest row is the one that SAYS
  //   00:00 daily. Each affected card is named in the log below rather than changed
  //   quietly, because its cadence really has changed and somebody has to know.
  const LONGEST_CADENCE_INSIDE_A_DAY = 1439
  const rows = db.prepare(
    "SELECT id, title, schedule_kind, schedule_value FROM pipeline_tasks WHERE schedule_kind IN ('interval', 'daily', 'weekly')"
  ).all() as Array<{ id: string; title: string; schedule_kind: string; schedule_value: string }>

  const setKind = db.prepare(
    'UPDATE pipeline_tasks SET schedule_kind = ?, schedule_value = ?, schedule_days = ?, updated_at = ? WHERE id = ?'
  )
  let converted = 0
  const flattened: string[] = []
  const now = Date.now()
  for (const r of rows) {
    const value = r.schedule_value ?? ''
    if (r.schedule_kind === 'interval') {
      const minutes = Number(value)
      if (Number.isFinite(minutes) && minutes > LONGEST_CADENCE_INSIDE_A_DAY) {
        setKind.run('times', '00:00', null, now, r.id)
        flattened.push(`"${r.title}" (was every ${minutes} minutes, now 00:00 daily)`)
      } else {
        setKind.run('every', value, null, now, r.id)
      }
    } else if (r.schedule_kind === 'daily') {
      // 'H:MM' was accepted by the old daily validator; the new one wants 'HH:MM'.
      const m = /^(\d{1,2}):(\d{2})$/.exec(value)
      const clock = m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}` : value
      setKind.run('times', clock, null, now, r.id)
    } else {
      const m = /^([0-6](?:,[0-6])*)@(\d{2}:\d{2})$/.exec(value)
      if (m) {
        setKind.run('times', m[2], m[1], now, r.id)
      } else {
        // A weekly value that does not parse is not guessed at, and it is not left armed
        // either. Left as 'weekly' with its old slot intact, the poll loop would fire it
        // once on a time computed by an engine that no longer exists, and only THEN find
        // it cannot compute a next one. Switched off instead, so the fire never happens
        // and the card is visibly waiting for a human rather than silently broken.
        db.prepare(
          "UPDATE pipeline_tasks SET schedule_enabled = 0, next_run_at = NULL, queued_since = NULL, updated_at = ? WHERE id = ?"
        ).run(now, r.id)
        console.warn(`[db] migration048: "${r.title}" has a weekly value that does not parse ("${value}"); switched off rather than converted`)
        continue
      }
    }
    converted++
  }

  // ── Re-anchor. One pending late fire may be lost, and that is the accepted cost. ──
  // Every 'every' and 'times' slot on the old grid was computed as "now + N" or from a
  // rule that no longer exists. Keeping those slots would fire the new schedule at the
  // old schedule's times for one cycle. NULL means "not armed yet"; the scheduler's boot
  // re-arm computes each one afresh on the new grid, which is the only honest answer.
  const reanchored = db.prepare(
    "UPDATE pipeline_tasks SET next_run_at = NULL, queued_since = NULL WHERE schedule_enabled = 1 AND schedule_kind IN ('every', 'times')"
  ).run()

  console.log(
    `[db] migration048: ${converted} schedule(s) converted to the every/times model, ` +
    `${reanchored.changes} armed card(s) re-anchored on the new grid`
  )
  if (flattened.length > 0) {
    console.log(
      `[db] migration048: ${flattened.length} card(s) repeated less often than once a day, which the ` +
      'new window-anchored grid cannot express. They fire at 00:00 daily now, which is what they ' +
      'would have done either way, and they say so: ' + flattened.join('; ')
    )
  }
  setSchemaVersion(48)
}

function migration049(): void {
  // Project-scope permission rules: the third option behind "Allow always".
  //
  // Until now the button saved app-wide and only app-wide, so "let this run" for one repo became a
  // grant every chat on the machine carried, and the operator had no way to say otherwise at the
  // moment of clicking. Same JSON shape as instances.permission_rules, read by the same normaliser,
  // unioned at spawn by cliSettingsArgs.
  //
  // Additive and nullable on purpose. A server still running the old code against
  // this column until it is restarted is fine because nothing old reads it, and a folder
  // with no rules is NULL rather than '{}' so "no rules" has one representation, not three.
  //
  // No parent_id: folders nest by PATH in this schema (see buildFolderTree in Sidebar.tsx), and the
  // inheritance chain in services/folder-rules.ts is computed the same way, so what the spawn grants
  // is exactly what the sidebar draws.
  safeAddColumn('folders', 'permission_rules TEXT')
  setSchemaVersion(49)
}

function migration050(): void {
  // The CLI's raw total_cost_usd, kept so the next turn can subtract it.
  //
  // cost_usd used to hold that raw figure, which is a running total, and every reader summed
  // it as if it were per-turn: ~3x on the Usage page once CLI 2.1.278 began carrying earlier
  // spend across --resume. cost_usd now holds the turn's own cost (services/turn-cost.ts),
  // so every existing reader is right without a change, and the raw total lives here.
  //
  // Nullable and not backfilled here: NULL means "written before this column", and for
  // those rows cost_usd still holds the raw figure. A one-off repair can fill it
  // for history, behind a verified backup, and the live code reads
  // COALESCE(cli_total_usd, cost_usd) for the previous row so a row the old server wrote
  // between the repair and the restart is still subtracted correctly.
  safeAddColumn('turn_costs', 'cli_total_usd REAL')
  setSchemaVersion(50)
}

function migration051(): void {
  // A real "hidden" flag for projects.
  //
  // "Hide Project" used to call the delete route, so one click wiped every card, routine,
  // comment and chat in the project. Hiding is now this flag and nothing else: the sidebar
  // leaves a hidden project out, a list at the bottom brings it back, and every row stays
  // where it is. Delete is a separate action with its own confirmation.
  //
  // Additive with a default, so an old server running against this column is unaffected
  // and every existing project reads as visible.
  safeAddColumn('folders', 'hidden INTEGER NOT NULL DEFAULT 0')
  setSchemaVersion(51)
}

export function migration052(): void {
  // Cloud Sync was removed. Its URL and service key sat in the settings table,
  // where the key was returned by /api/state and broadcast to every WebSocket client on
  // each settings change. Delete both rows so the key is gone from existing databases too.
  // Idempotent: deleting rows that are not there is a no-op. The folders.cloud_sync column
  // is left in place (nothing reads it any more, and dropping a column is not done here).
  db.prepare("DELETE FROM settings WHERE key IN ('cloudSyncUrl', 'cloudSyncKey')").run()
  setSchemaVersion(52)
}

export function migration053(): void {
  // All additive and idempotent.
  //
  // turn_costs(task_id): every task turn re-sums its card's tokens and cost with subqueries
  // filtered on task_id, each a full scan of a table that is never pruned.
  // turn_costs(created_at): the usage page's date-range filters, a full scan per query.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_turn_costs_task ON turn_costs(task_id);
    CREATE INDEX IF NOT EXISTS idx_turn_costs_created ON turn_costs(created_at);
  `)
  // When the chat's process started, recorded with its PID. After a restart the PID alone
  // cannot tell the agent apart from an unrelated program that was later given the same number.
  safeAddColumn('instances', 'process_started_at INTEGER DEFAULT NULL')
  setSchemaVersion(53)
}

export function migration054(): void {
  // Per-card "send comments as context". NULL is AUTO, not off: a plain task sends its
  // comments, a card with a schedule does not. Stored as NULL so every existing routine
  // turns off without a data rewrite, and a card that gains a schedule later follows too.
  // An explicit 1 or 0 is the user's own choice and always wins.
  safeAddColumn('pipeline_tasks', 'send_comments INTEGER DEFAULT NULL')
  // Where a routine's close summary lands. It used to become a comment, and a daily card
  // collected one a day until the comments a human wrote were buried under them.
  safeAddColumn('task_runs', 'summary TEXT DEFAULT NULL')
  setSchemaVersion(54)
}

export function migration055(): void {
  // Close itself when it succeeds: the run must end with `RESULT: OK` (verdict.ts). Any card,
  // manual or scheduled. 0 keeps today's behaviour exactly.
  // It first shipped inside an already-applied migration's column list, so every database
  // that was past it never got the column and the server crashed at boot on the scheduler's
  // first SELECT. A migration that has shipped is never edited: a new column is a new number.
  safeAddColumn('pipeline_tasks', 'self_close INTEGER NOT NULL DEFAULT 0')
  setSchemaVersion(55)
}

const migrations = [
  migration001, migration002, migration003, migration004, migration005,
  migration006, migration007, migration008, migration009, migration010,
  migration011, migration012, migration013, migration014, migration015,
  migration016, migration017, migration018, migration019, migration020,
  migration021, migration022, migration023, migration024, migration025,
  migration026, migration027, migration028, migration029, migration030,
  migration031, migration032, migration033, migration034, migration035,
  migration036, migration037, migration038, migration039, migration040,
  migration041, migration042, migration043, migration044, migration045,
  migration046, migration047, migration048, migration049, migration050,
  migration051, migration052, migration053, migration054, migration055,
]

export const LATEST_SCHEMA_VERSION = migrations.length

/** Test hook: run migration number `n` (1-based) against the open database, as the runner would. */
export function _runMigrationForTest(n: number): void {
  db.transaction(() => { migrations[n - 1]() }).immediate()
}

/** Where automatic pre-migration backups go, and how many are kept. */
export const BACKUP_DIR = path.join(DATA_DIR, 'backups')
const BACKUPS_KEPT = 3

export class MigrationBackupError extends Error {}

/**
 * Before ANY pending migration runs, take a WAL-safe copy of the database with
 * SQLite's online backup API, then open that copy and prove it: integrity_check must say ok
 * and every table must hold the same number of rows as the live one. A copy that fails either
 * test is deleted and a MigrationBackupError thrown, and the caller then refuses to migrate.
 *
 * Returns the verified backup's path.
 */
async function backupBeforeMigrating(fromVersion: number, toVersion: number): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(BACKUP_DIR, `pre-migration-v${fromVersion}-to-v${toVersion}-${stamp}.db`)
  try {
    if (process.env.ORCSTRATOR_FORCE_BACKUP_FAILURE === '1') throw new Error('forced by ORCSTRATOR_FORCE_BACKUP_FAILURE')
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    await db.backup(dest)
    // The copy inherits WAL mode; make it one self-contained file (no -wal/-shm beside it).
    const single = new Database(dest, { fileMustExist: true })
    try { single.pragma('journal_mode = DELETE') } finally { single.close() }
    const copy = new Database(dest, { readonly: true, fileMustExist: true })
    try {
      const integrity = copy.pragma('integrity_check', { simple: true })
      if (integrity !== 'ok') throw new Error(`integrity_check on the backup said: ${String(integrity)}`)
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
      for (const { name } of tables) {
        const live = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n
        const saved = (copy.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n
        if (live !== saved) throw new Error(`table ${name}: ${live} rows live, ${saved} in the backup`)
      }
    } finally {
      copy.close()
    }
  } catch (err) {
    try { fs.rmSync(dest, { force: true }) } catch { /* nothing written */ }
    throw new MigrationBackupError(`Could not make a verified backup before updating the database: ${(err as Error).message}`)
  }
  // Keep the newest few.
  try {
    const old = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('pre-migration-') && f.endsWith('.db'))
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(BACKUPS_KEPT)
    for (const o of old) fs.rmSync(path.join(BACKUP_DIR, o.f), { force: true })
  } catch { /* pruning is housekeeping, never a reason to fail */ }
  console.log(`[db] Backup before migrating v${fromVersion} -> v${toVersion}: ${dest} (integrity ok, row counts match)`)
  return dest
}

/**
 * Apply every pending migration, each in its own IMMEDIATE transaction: a crash or
 * a power cut mid-migration now rolls that migration back whole, instead of leaving a
 * half-applied data rewrite with no version row. Nothing runs unless the verified backup
 * above succeeded first.
 */
async function runMigrations(): Promise<{ from: number; to: number; backup: string | null }> {
  const currentVersion = getSchemaVersion()
  if (currentVersion >= migrations.length) return { from: currentVersion, to: currentVersion, backup: null }
  const backup = await backupBeforeMigrating(currentVersion, migrations.length)
  for (let i = currentVersion; i < migrations.length; i++) {
    db.transaction(() => { migrations[i]() }).immediate()
  }
  return { from: currentVersion, to: migrations.length, backup }
}

// One-time import: on first boot (no v2 DB yet), adopt the OrcStrator v1 database
// so chats, pipeline tasks, and cost history carry over.
//
// V1 may still be running, and its database is in WAL mode, so copying the .db,
// -wal and -shm files one after another can capture an inconsistent snapshot. SQLite's
// online backup API reads a consistent one from a read-only connection; the result is then
// quick_check'ed, and a copy that fails is discarded rather than migrated.
async function importV1Database(): Promise<boolean> {
  if (fs.existsSync(DB_PATH)) return false
  const v1Db = process.env.ORCSTRATOR_V1_DB || path.join(os.homedir(), '.orcstrator', 'orcstrator.db')
  if (!fs.existsSync(v1Db)) return false
  const tmp = `${DB_PATH}.import-${process.pid}`
  try {
    const src = new Database(v1Db, { readonly: true, fileMustExist: true })
    try { await src.backup(tmp) } finally { src.close() }
    const check = new Database(tmp, { readonly: true })
    let verdict: unknown
    try { verdict = check.pragma('quick_check', { simple: true }) } finally { check.close() }
    if (verdict !== 'ok') throw new Error(`quick_check said: ${String(verdict)}`)
    fs.renameSync(tmp, DB_PATH)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* nothing to clean */ }
    console.error(`[db] First boot: could NOT import the OrcStrator v1 database from ${v1Db} (${(err as Error).message}); starting empty instead`)
    return false
  }
  console.log(`[db] First boot: imported OrcStrator v1 database from ${v1Db}`)
  return true
}

// The v1 server may still be running its own Claude processes. Imported rows must not
// carry live runtime state, or this server would adopt (and later reap) v1's processes.
function sanitizeImportedRuntimeState(): void {
  const inst = db.prepare("UPDATE instances SET state = 'idle', process_pid = NULL WHERE state != 'idle' OR process_pid IS NOT NULL").run()
  console.log(`[db] Import sanitized: ${inst.changes} instance(s) reset to idle`)
}

/**
 * Set when the pre-migration backup failed: the database is open READ-ONLY and no migration
 * ran. index.ts reads it to refuse writes with this message instead of half-working.
 */
let dbReadOnlyReason: string | null = null

function openDb(readonly: boolean): void {
  db = new Database(DB_PATH, readonly ? { readonly: true } : {})
  // `auto_vacuum = INCREMENTAL` only takes effect on a database that has no tables
  // yet. It used to be set on every open, which read as if existing databases reclaimed their
  // free pages; they never did (the live one was 79% empty pages). It is now set only where it
  // works, a brand-new file. An existing database is switched over once, with the app stopped,
  // by scripts/vacuum-db.mjs; maintenance then runs incremental_vacuum.
  if (!readonly) {
    const tables = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n
    if (tables === 0) db.pragma('auto_vacuum = INCREMENTAL')
    db.pragma('journal_mode = WAL')
  }
  db.pragma('foreign_keys = ON')
  // Contention default is busy_timeout=0: a second writer throws SQLITE_BUSY
  // instantly, and the hot-path writes wrapped in bare `catch` (turn_costs,
  // token updates) silently DROP the row. 5s of retrying absorbs any realistic
  // writer overlap instead of losing usage data.
  db.pragma('busy_timeout = 5000')
  // WAL + NORMAL is the recommended pairing: fsync at checkpoint instead of per
  // autocommit. Worst case on OS crash is losing the last few transactions, never
  // corruption - the right trade for per-turn streaming writes.
  db.pragma('synchronous = NORMAL')
  // Keep the -wal file from growing without bound between checkpoints.
  if (!readonly) db.pragma('journal_size_limit = 67108864')
}

/**
 * Open the database: take the data dir's single-owner lock, import v1 on a first
 * boot, back up and migrate. Throws DataDirLockedError when another server owns the folder.
 * A failed pre-migration backup does NOT throw: the database opens read-only and
 * dbReadOnlyReason says why.
 */
async function initDb(opts: { port?: number } = {}): Promise<void> {
  ensureDataDir()
  await acquireDataDirLock(DATA_DIR, { port: opts.port })
  // A second call in one process (tests, a script) must not leave the first connection open.
  if (db?.open) db.close()
  dbReadOnlyReason = null
  const imported = await importV1Database()
  openDb(false)
  try {
    await runMigrations()
  } catch (err) {
    if (!(err instanceof MigrationBackupError)) throw err
    dbReadOnlyReason = err.message
    console.error('')
    console.error('================================================================')
    console.error(`[db] ${err.message}`)
    console.error('[db] The database was NOT updated. OrcStrator is starting READ-ONLY so nothing')
    console.error('[db] can be written to a database that has no restore point. Free some disk')
    console.error(`[db] space or check ${BACKUP_DIR}, then restart.`)
    console.error('================================================================')
    console.error('')
    db.close()
    openDb(true)
    return
  }
  if (imported) sanitizeImportedRuntimeState()
}

export function closeDb(): void { db.close() }

export { db, initDb, dbReadOnlyReason }
