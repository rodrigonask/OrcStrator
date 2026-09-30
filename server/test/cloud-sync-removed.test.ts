// Cloud Sync could not work, exported more than it said, and leaked its key: after
// `PUT /settings {"cloudSyncKey": ...}` the key came back from /api/state and went to every
// WebSocket client. It is removed: code, routes, settings and the dependency.
//
//   npx tsx server/test/cloud-sync-removed.test.ts

import fs from 'fs'
import path from 'path'
import { scratchApp, check, done } from './helpers/scratch-app.js'

const { app, db, close } = await scratchApp(['settings', 'state'])
const root = path.resolve('.')

const put = await app.inject({ method: 'PUT', url: '/api/settings', payload: { cloudSyncKey: 'AUDIT-SECRET-TEST' } })
check('PUT /settings cannot store a Cloud Sync key any more (was 200)', put.statusCode === 400, `status ${put.statusCode}`)
const state = await app.inject({ method: 'GET', url: '/api/state' })
check('/api/state carries no Cloud Sync settings (the key was returned in plain text)', state.statusCode === 200 && !/cloudSync/i.test(state.body) && !state.body.includes('AUDIT-SECRET-TEST'), `status ${state.statusCode}`)
const rows = db.prepare("SELECT key FROM settings WHERE key IN ('cloudSyncUrl', 'cloudSyncKey')").all()
check('a fresh database has no Cloud Sync rows', rows.length === 0, JSON.stringify(rows))

// An existing database: the rows are deleted by the migration, and running it again is harmless.
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cloudSyncKey', '\"old-key\"')").run()
let migrated = false
try {
  const dbMod = await import('../src/db.js') as Record<string, unknown>
  const m = dbMod.migration052 as (() => void) | undefined
  // The runner applies each migration once (schema_version); its body must still be safe to repeat.
  if (m) { for (let i = 0; i < 2; i++) { db.prepare("DELETE FROM schema_version WHERE version = 52").run(); m() } migrated = true }
} catch (err) { console.log("NOTE  migration052:", (err as Error).message) }
const left = db.prepare("SELECT key FROM settings WHERE key = 'cloudSyncKey'").all()
check('migration 052 deletes an existing Cloud Sync key, twice safely', migrated && left.length === 0, JSON.stringify(left))

const gone = ['server/src/services/cloud-sync.ts', 'server/src/routes/sync.ts', 'server/supabase/schema.sql']
check('the Cloud Sync code and its schema are deleted', gone.every(p => !fs.existsSync(path.join(root, p))), gone.filter(p => fs.existsSync(path.join(root, p))).join(', '))
const pkg = fs.readFileSync(path.join(root, 'server/package.json'), 'utf8')
check('the Supabase client is no longer a dependency', !pkg.includes('@supabase/supabase-js'))
const settingsPage = fs.readFileSync(path.join(root, 'client/src/components/SettingsPage.tsx'), 'utf8')
check('the Settings page has no Cloud Sync card', !/cloudSync|Cloud Sync/.test(settingsPage))

await close()
done()
