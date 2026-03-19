# Cloud Sync — Supabase Integration Plan

## Overview

Add optional Supabase cloud sync to OrcStrator so multiple machines can share a unified view of all projects/tasks, and a future phone app can create/edit/move tasks remotely. Local SQLite remains authoritative. The Orc piggybacks sync on its existing 10s tick. Each machine self-reports its name.

---

## Design Decisions (from interview)

- **Backend**: Supabase (Postgres + auth + JS SDK)
- **Auth**: Single API key shared across all machines + phone
- **Schema**: Cloud mirrors SQLite exactly (same tables, same columns)
- **Sync direction**: Bidirectional — push local changes up, pull remote changes down
- **Sync trigger**: Piggyback on Orc tick (10s), with `last_modified_at` timestamp check to skip unchanged projects
- **Safety net**: Hourly global full sync regardless of timestamps
- **Scope**: All tables that matter for remote management (tasks, comments, agents, folders, settings, blueprints, token_usage). Messages stay local (large volume, only relevant to local machine).
- **Conflicts**: No cross-machine task assignment — each Orc owns its own projects. Remote writes (phone) are task CRUD only.
- **Offline**: Local keeps working, sync resumes when connection returns
- **Done tasks**: Push on initial sync, then stop syncing
- **Machine identity**: User-configured name in settings (self-reported)
- **Setup**: Optional, in Settings page (not initial setup). Instructions for creating Supabase project + URL/key fields.

---

## Implementation Steps

### Phase 1: Foundation (Server)

#### 1.1 — New settings keys + migration (migration022)
**File**: `server/src/db.ts`

Add new settings:
- `cloudSyncEnabled` (boolean, default false)
- `cloudSyncUrl` (string, Supabase project URL)
- `cloudSyncKey` (string, Supabase anon key)
- `machineName` (string, default hostname)
- `machineId` (string, auto-generated UUID on first run — stable identity even if name changes)

Add new columns to `folders` table:
- `cloud_sync` (INTEGER, 0/1 — per-project opt-in toggle)
- `last_synced_at` (INTEGER, timestamp of last successful sync)
- `cloud_last_modified_at` (INTEGER, timestamp from cloud)

#### 1.2 — Supabase client service
**New file**: `server/src/services/cloud-sync.ts`

- Initialize `@supabase/supabase-js` client from settings (lazy — only when enabled)
- Expose: `isConfigured()`, `isEnabled()`, `connect()`, `disconnect()`
- Reconnect when settings change (listen for `settings:updated` broadcast)
- Export singleton: `export const cloudSync = new CloudSyncService()`

#### 1.3 — Sync engine (core logic in same file)
**File**: `server/src/services/cloud-sync.ts`

**Push logic** (local → cloud):
- For each synced folder, query local tables where `updated_at > last_synced_at`
- Upsert changed rows to Supabase (batch upsert via `.upsert()`)
- Each row includes `machine_id` + `machine_name` to identify source
- Update local `last_synced_at` on success

**Pull logic** (cloud → local):
- Query Supabase for rows where `updated_at > cloud_last_modified_at` AND `machine_id != local_machine_id`
- These are remote writes (from phone or other machines viewing the same project)
- Apply to local SQLite, skip rows that would conflict with local locks
- Update `cloud_last_modified_at`

**Timestamp optimization**:
- Each folder gets a `project_last_modified` value in cloud (single row check)
- Orc tick checks this FIRST — if unchanged, skip entire sync for that project
- Cost: 1 lightweight query per synced project per tick

**Hourly full sync**:
- Every 360 ticks (~1 hour), ignore timestamps and do a full diff-and-push for all synced projects
- Catches any drift from missed updates

#### 1.4 — Tables to sync
Synced (with `machine_id` + `machine_name` columns added in cloud):
- `pipeline_tasks` — the main board
- `task_comments` — task discussion
- `agents` — agent definitions
- `folders` — project list
- `pipeline_blueprints` — workflow definitions
- `token_usage` — cost tracking
- `settings` — app config (selective — only sync-relevant keys)
- `instances` — agent state (read-only in cloud, for monitoring)

**NOT synced**:
- `messages` — too large, local-only

#### 1.5 — Hook into Orchestrator tick
**File**: `server/src/services/orchestrator.ts`

Add to `tick()`:
- Every tick: call `cloudSync.syncIfNeeded()` for active synced folders
- Every 360th tick: call `cloudSync.fullSync()`
- Sync runs AFTER assignment sweep (don't slow down agent work)
- Sync errors are logged but never block the tick

### Phase 2: Supabase Schema Setup

#### 2.1 — SQL migration script for Supabase
**New file**: `server/supabase/schema.sql`

- Mirror all synced SQLite tables in Postgres
- Add `machine_id TEXT` and `machine_name TEXT` columns to every table
- Add `synced_at TIMESTAMPTZ` for tracking
- Composite primary keys: `(id, machine_id)` where needed (same task ID from different machines won't conflict since they're different projects, but this ensures safety)
- Add `project_sync_status` table: `(folder_id, machine_id, last_modified_at)` for the timestamp optimization
- RLS policies: all rows accessible with valid anon key (single-user model)

#### 2.2 — Setup instructions
**New file**: `server/supabase/SETUP.md`

Step-by-step:
1. Create free Supabase project at supabase.com
2. Go to SQL Editor, paste `schema.sql`, run it
3. Copy project URL + anon key from Settings → API
4. In OrcStrator Settings → Cloud Sync, paste URL + key
5. Set machine name
6. Toggle "Sync to Cloud" on desired projects

### Phase 3: Settings UI

#### 3.1 — Cloud Sync section in Settings page
**File**: `client/src/components/SettingsPage.tsx`

New settings card (in Advanced tab or new "Cloud Sync" tab):
- **Machine Name**: text input (defaults to hostname)
- **Supabase URL**: text input with placeholder `https://xxx.supabase.co`
- **Supabase Key**: password-masked text input
- **Test Connection**: button that pings Supabase and shows success/error
- **Setup Instructions**: collapsible section with the steps from SETUP.md
- **Sync Status**: show last sync time, connected/disconnected state

Follow existing `.settings-card` + `.settings-toggle` patterns.

#### 3.2 — Per-project sync toggle
**File**: `client/src/components/FolderGroup.tsx`

Add cloud sync icon button in `.folder-action-group` (next to orchestrator toggle):
- Cloud icon (☁) — gray when off, accent-colored when synced
- Click toggles `cloud_sync` on the folder
- Only visible when cloud sync is configured (URL + key set)
- Tooltip: "Sync to Cloud" / "Synced to Cloud"

#### 3.3 — Pipeline board sync indicator
**File**: `client/src/components/pipeline/PipelineBoard.tsx`

In pipeline header:
- Small cloud icon with sync status (synced / syncing / error / offline)
- Shows `last_synced_at` on hover
- Only visible for cloud-synced projects

### Phase 4: Types & Shared

#### 4.1 — Update AppSettings type
**File**: `shared/src/types.ts`

Add to `AppSettings`:
```typescript
cloudSyncEnabled?: boolean
cloudSyncUrl?: string
cloudSyncKey?: string
machineName?: string
machineId?: string
```

#### 4.2 — Update Folder type
**File**: `shared/src/types.ts`

Add to folder type:
```typescript
cloud_sync?: boolean
last_synced_at?: number
cloud_last_modified_at?: number
```

### Phase 5: API Routes

#### 5.1 — Sync control endpoints
**File**: `server/src/routes/settings.ts` (or new `sync.ts`)

- `POST /api/sync/test` — test Supabase connection with provided URL + key
- `POST /api/sync/trigger/:folderId` — manually trigger sync for a project
- `GET /api/sync/status` — current sync state for all projects (last sync time, error state)

### Phase 6: Dependencies

#### 6.1 — Install Supabase client
```bash
cd server && npm install @supabase/supabase-js
```

---

## File Change Summary

| File | Change |
|------|--------|
| `server/src/db.ts` | Migration 022: new settings, folder columns |
| `server/src/services/cloud-sync.ts` | **NEW** — sync engine + Supabase client |
| `server/src/services/orchestrator.ts` | Hook sync into tick loop |
| `server/src/routes/settings.ts` | Sync test/trigger/status endpoints (or new route file) |
| `server/supabase/schema.sql` | **NEW** — Postgres schema for Supabase |
| `server/supabase/SETUP.md` | **NEW** — setup instructions |
| `client/src/components/SettingsPage.tsx` | Cloud Sync settings section |
| `client/src/components/FolderGroup.tsx` | Per-project sync toggle |
| `client/src/components/pipeline/PipelineBoard.tsx` | Sync status indicator |
| `shared/src/types.ts` | AppSettings + Folder type updates |
| `server/package.json` | Add `@supabase/supabase-js` dependency |

---

## What this does NOT include (future work)
- Phone app (separate project — connects directly to Supabase)
- Remote agent control (start/stop agents from phone)
- Multi-user auth (multiple people sharing a board)
- Real-time subscriptions (polling is sufficient for now)
