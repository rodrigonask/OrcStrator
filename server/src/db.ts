import Database from 'better-sqlite3'
import fs from 'fs'
import { DATA_DIR, DB_PATH } from './config.js'
import { DEFAULT_SETTINGS } from '@nasklaude/shared'

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
      onboarding_complete INTEGER DEFAULT 0
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
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col}`).run()
    } catch {
      // column already exists — ignore
    }
  }

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  insertSetting.run('orchestratorAgentNames', JSON.stringify({ planner: 'Planner', builder: 'Builder', tester: 'Tester', promoter: 'Promoter' }))
  insertSetting.run('orchestratorAllowSpawn', JSON.stringify(false))

  setSchemaVersion(2)
}

function migration004(): void {
  try {
    db.prepare("ALTER TABLE pipeline_tasks ADD COLUMN attachments TEXT DEFAULT '[]'").run()
  } catch {
    // column already exists
  }
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
  try {
    db.prepare('ALTER TABLE folders ADD COLUMN stealth_mode INTEGER DEFAULT 0').run()
  } catch {
    // column already exists
  }
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
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col}`).run()
    } catch {
      // column already exists
    }
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
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col}`).run()
    } catch {
      // column already exists
    }
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
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col}`).run()
    } catch {
      // column already exists
    }
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

function runMigrations(): void {
  const currentVersion = getSchemaVersion()

  if (currentVersion < 1) {
    migration001()
  }

  if (currentVersion < 2) {
    migration002()
  }

  if (currentVersion < 3) {
    migration003()
  }

  if (currentVersion < 4) {
    migration004()
  }

  if (currentVersion < 5) {
    migration005()
  }

  if (currentVersion < 6) {
    migration006()
  }

  if (currentVersion < 7) {
    migration007()
  }

  if (currentVersion < 8) {
    migration008()
  }

  if (currentVersion < 9) {
    migration009()
  }

  if (currentVersion < 10) {
    migration010()
  }

  if (currentVersion < 11) {
    migration011()
  }

  if (currentVersion < 12) {
    migration012()
  }

  if (currentVersion < 13) {
    migration013()
  }

  if (currentVersion < 14) {
    migration014()
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
