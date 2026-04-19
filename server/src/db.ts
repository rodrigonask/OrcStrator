import Database from 'better-sqlite3'
import fs from 'fs'
import { DATA_DIR, DB_PATH } from './config.js'
import { DEFAULT_SETTINGS } from '@orcstrator/shared'

let db: Database.Database

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

function getSchemaVersion(): number {
  try {
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined
    return row?.version ?? 0
  } catch {
    return 0
  }
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
  try {
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
  } catch {
    // already exists
  }
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
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('userName', ?)").run(JSON.stringify('Rodrigo Nask'))
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
  db.prepare('ALTER TABLE instances ADD COLUMN xp_total INTEGER DEFAULT 0').run()
  db.prepare('ALTER TABLE instances ADD COLUMN level INTEGER DEFAULT 1').run()
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

  // Cloud Sync settings (URL, key, machine identity)
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  insertSetting.run('cloudSyncUrl', JSON.stringify(''))
  insertSetting.run('cloudSyncKey', JSON.stringify(''))
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

const migrations = [
  migration001, migration002, migration003, migration004, migration005,
  migration006, migration007, migration008, migration009, migration010,
  migration011, migration012, migration013, migration014, migration015,
  migration016, migration017, migration018, migration019, migration020,
  migration021, migration022, migration023,
]

function runMigrations(): void {
  const currentVersion = getSchemaVersion()
  for (let i = currentVersion; i < migrations.length; i++) {
    migrations[i]()
  }
}

function initDb(): void {
  ensureDataDir()
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('auto_vacuum = INCREMENTAL')
  runMigrations()
}

export function closeDb(): void { db.close() }

export { db, initDb }
