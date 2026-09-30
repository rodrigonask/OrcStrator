// A new install runs chats in Auto, not with every permission bypassed; a card
// or routine can carry its own mode (so an unattended routine can be set to bypass on
// purpose); and an existing install's saved bypass is left exactly as it is.
//
//   npx tsx server/test/permission-defaults.test.ts

import { scratchApp, check, done } from './helpers/scratch-app.js'

const { app, db, close } = await scratchApp(['folders', 'pipeline', 'settings'])
const { buildTurnFlags } = await import('../src/services/turn-flags.js')
const shared = await import('@orcstrator/shared') as Record<string, unknown>
const effectivePermissionMode = shared.effectivePermissionMode as
  ((s: { permissionMode?: string | null; globalFlags?: string[] | null }) => string) | undefined

const setting = (key: string): unknown => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row ? JSON.parse(row.value) : undefined
}

// ── a fresh database ────────────────────────────────────────────────────────────
const flags = setting('globalFlags') as string[]
check('fresh install: globalFlags is Auto, not bypass', Array.isArray(flags) && flags.includes('--permission-mode=auto') && !flags.includes('--dangerously-skip-permissions'), JSON.stringify(flags))
check('fresh install: permissionMode is auto', setting('permissionMode') === 'auto', JSON.stringify(setting('permissionMode')))

const inherit = buildTurnFlags({})
check('a card with no mode of its own runs in Auto', inherit.includes('--permission-mode=auto') && !inherit.includes('--dangerously-skip-permissions'), JSON.stringify(inherit))

// ── a routine that must never stop can be set to bypass on its own ────────────────────
const res = await app.inject({ method: 'POST', url: '/api/folders', payload: { path: process.cwd(), name: 'b4' } })
const pid = (res.json() as { id: string }).id
const routine = await app.inject({
  method: 'POST', url: `/api/pipelines/${pid}/tasks`,
  payload: { title: 'nightly', description: 'report', scheduleKind: 'every', scheduleValue: '60', scheduleEnabled: false, permissionMode: 'bypassPermissions' },
})
const routineId = (routine.json() as { id: string }).id
const row = db.prepare('SELECT model, effort, permission_mode, max_budget_usd, fallback_model FROM pipeline_tasks WHERE id = ?').get(routineId) as Parameters<typeof buildTurnFlags>[0]
check('a routine stores its own permission mode', row.permission_mode === 'bypassPermissions', JSON.stringify(row.permission_mode))
const routineFlags = buildTurnFlags(row)
check('that routine spawns with bypass, and the app default is stripped', routineFlags.includes('--dangerously-skip-permissions') && !routineFlags.some(f => f.startsWith('--permission-mode')), JSON.stringify(routineFlags))
const autoCard = buildTurnFlags({ permission_mode: 'default' })
check('a card set to "ask every time" spawns with that mode', autoCard.includes('--permission-mode=default') && !autoCard.includes('--dangerously-skip-permissions'), JSON.stringify(autoCard))

// ── a chat message that picks its own mode is the only mode the CLI sees ────────────
// Found live on the scratch server: with the Auto default, a message sending Bypass spawned with
// BOTH `--permission-mode=auto` and `--dangerously-skip-permissions`.
const tf = await import('../src/services/turn-flags.js') as Record<string, unknown>
const messageModeWins = tf.messageModeWins as ((g: string[], m: string[]) => string[]) | undefined
check('messageModeWins is exported', typeof messageModeWins === 'function')
if (messageModeWins) {
  const g = ['--permission-mode=auto', '--effort=high']
  const bypassMsg = [...messageModeWins(g, ['--dangerously-skip-permissions']), '--dangerously-skip-permissions']
  check('a message set to Bypass drops the Auto default', !bypassMsg.includes('--permission-mode=auto') && bypassMsg.includes('--effort=high'), JSON.stringify(bypassMsg))
  const planMsg = messageModeWins(['--dangerously-skip-permissions'], ['--permission-mode=plan'])
  check('a message set to Plan drops a saved Bypass', !planMsg.includes('--dangerously-skip-permissions'), JSON.stringify(planMsg))
  check('a message with no mode keeps the app default', JSON.stringify(messageModeWins(g, ['--model=x'])) === JSON.stringify(g))
}

// ── an existing install keeps its saved bypass ─────────────────────────────────────
db.prepare("UPDATE settings SET value = ? WHERE key = 'globalFlags'").run(JSON.stringify(['--dangerously-skip-permissions']))
db.prepare("DELETE FROM settings WHERE key = 'permissionMode'").run()
const dbModule = await import('../src/db.js')
dbModule.closeDb()
await dbModule.initDb() // a restart: migrations run again and must not touch the setting
const reopened = dbModule.db
const kept = JSON.parse((reopened.prepare("SELECT value FROM settings WHERE key = 'globalFlags'").get() as { value: string }).value) as string[]
check('existing install: a saved bypass survives a restart', kept.includes('--dangerously-skip-permissions'), JSON.stringify(kept))
const legacy = buildTurnFlags({})
check('existing install: its cards still run with bypass', legacy.includes('--dangerously-skip-permissions'), JSON.stringify(legacy))

// ── the UI reads the same answer as the spawn path ────────────────────────────────
check('effectivePermissionMode is exported from shared', typeof effectivePermissionMode === 'function')
if (effectivePermissionMode) {
  check('UI default for an old install with only a bypass flag is bypass', effectivePermissionMode({ globalFlags: ['--dangerously-skip-permissions'] }) === 'bypassPermissions')
  check('UI default for an install with nothing saved is auto', effectivePermissionMode({}) === 'auto')
  check('UI default follows a saved --permission-mode flag', effectivePermissionMode({ globalFlags: ['--permission-mode=acceptEdits'] }) === 'acceptEdits')
  check('a saved permissionMode wins over the flags', effectivePermissionMode({ permissionMode: 'plan', globalFlags: ['--dangerously-skip-permissions'] }) === 'plan')
}

await close()
done()
