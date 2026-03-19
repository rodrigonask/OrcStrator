-- OrcStrator Cloud Sync — Supabase Schema
-- Run this in your Supabase SQL Editor to set up the cloud tables.
-- These tables mirror the local SQLite schema with added machine_id/machine_name columns.

-- ══════════════════════════════════════════
-- Sync metadata (timestamp optimization)
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS project_sync_meta (
  folder_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  machine_name TEXT DEFAULT '',
  last_modified_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (folder_id, machine_id)
);

-- ══════════════════════════════════════════
-- Folders (projects)
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS folders (
  id TEXT NOT NULL,
  machine_id TEXT NOT NULL DEFAULT '',
  machine_name TEXT DEFAULT '',
  path TEXT,
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
  created_at BIGINT,
  orchestrator_active INTEGER DEFAULT 0,
  stealth_mode INTEGER DEFAULT 0,
  cloud_sync INTEGER DEFAULT 0,
  last_synced_at BIGINT,
  cloud_last_modified_at BIGINT,
  PRIMARY KEY (id, machine_id)
);

-- ══════════════════════════════════════════
-- Instances (agents)
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS instances (
  id TEXT NOT NULL,
  machine_id TEXT NOT NULL DEFAULT '',
  machine_name TEXT DEFAULT '',
  folder_id TEXT NOT NULL,
  name TEXT,
  cwd TEXT,
  session_id TEXT,
  state TEXT DEFAULT 'idle',
  agent_id TEXT,
  idle_restart_minutes INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at BIGINT,
  agent_role TEXT,
  specialization TEXT,
  orchestrator_managed INTEGER DEFAULT 0,
  xp_total INTEGER DEFAULT 0,
  level INTEGER DEFAULT 1,
  overdrive_tasks INTEGER DEFAULT 0,
  overdrive_started_at BIGINT,
  last_task_at BIGINT,
  process_pid INTEGER,
  process_state TEXT DEFAULT 'idle',
  reserved_at BIGINT,
  assigned_task_ids TEXT,
  is_scheduler_run INTEGER DEFAULT 0,
  scheduler_context TEXT,
  version INTEGER DEFAULT 1,
  PRIMARY KEY (id, machine_id)
);

-- ══════════════════════════════════════════
-- Pipeline tasks
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pipeline_tasks (
  id TEXT NOT NULL,
  machine_id TEXT NOT NULL DEFAULT '',
  machine_name TEXT DEFAULT '',
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
  completed_at BIGINT,
  created_at BIGINT,
  updated_at BIGINT,
  locked_by TEXT,
  locked_at BIGINT,
  retry_count INTEGER DEFAULT 0,
  attachments TEXT DEFAULT '[]',
  schedule TEXT,
  executions TEXT DEFAULT '[]',
  skill TEXT,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0,
  last_assigned_at BIGINT,
  pipeline_id TEXT,
  current_step INTEGER DEFAULT 1,
  total_steps INTEGER DEFAULT 1,
  current_step_role TEXT,
  step_instructions TEXT,
  version INTEGER DEFAULT 1,
  lock_version INTEGER DEFAULT 0,
  PRIMARY KEY (id, machine_id)
);

CREATE INDEX IF NOT EXISTS idx_pt_project ON pipeline_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_pt_machine ON pipeline_tasks(machine_id);
CREATE INDEX IF NOT EXISTS idx_pt_updated ON pipeline_tasks(updated_at);

-- ══════════════════════════════════════════
-- Task comments
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT NOT NULL,
  machine_id TEXT NOT NULL DEFAULT '',
  machine_name TEXT DEFAULT '',
  task_id TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'human',
  body TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id, machine_id)
);

CREATE INDEX IF NOT EXISTS idx_tc_task ON task_comments(task_id);

-- ══════════════════════════════════════════
-- Agents
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agents (
  id TEXT NOT NULL,
  machine_id TEXT NOT NULL DEFAULT '',
  machine_name TEXT DEFAULT '',
  name TEXT,
  content TEXT,
  level INTEGER DEFAULT 0,
  skills TEXT DEFAULT '[]',
  mcp_servers TEXT DEFAULT '[]',
  created_at BIGINT,
  personality TEXT,
  source TEXT DEFAULT 'user',
  role TEXT,
  PRIMARY KEY (id, machine_id)
);

-- ══════════════════════════════════════════
-- Pipeline blueprints
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pipeline_blueprints (
  id TEXT NOT NULL,
  machine_id TEXT NOT NULL DEFAULT '',
  machine_name TEXT DEFAULT '',
  name TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id, machine_id)
);

-- ══════════════════════════════════════════
-- Token usage
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS token_usage (
  id BIGINT NOT NULL,
  machine_id TEXT NOT NULL DEFAULT '',
  machine_name TEXT DEFAULT '',
  session_id TEXT,
  instance_id TEXT,
  role TEXT,
  task_id TEXT,
  prompt_chars INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  created_at BIGINT NOT NULL,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  is_overdrive_session INTEGER DEFAULT 0,
  PRIMARY KEY (id, machine_id)
);

CREATE INDEX IF NOT EXISTS idx_tu_task ON token_usage(task_id);
CREATE INDEX IF NOT EXISTS idx_tu_machine ON token_usage(machine_id);

-- ══════════════════════════════════════════
-- Row Level Security (single-key model)
-- All rows accessible with valid anon key.
-- ══════════════════════════════════════════

ALTER TABLE project_sync_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_blueprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_usage ENABLE ROW LEVEL SECURITY;

-- Allow full access with the anon key
CREATE POLICY "Allow all with anon key" ON project_sync_meta FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all with anon key" ON folders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all with anon key" ON instances FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all with anon key" ON pipeline_tasks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all with anon key" ON task_comments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all with anon key" ON agents FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all with anon key" ON pipeline_blueprints FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all with anon key" ON token_usage FOR ALL USING (true) WITH CHECK (true);
