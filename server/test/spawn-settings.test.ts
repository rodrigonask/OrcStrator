// At the spawn: the managed --settings file a chat actually runs under.
//
//   npx tsx server/test/spawn-settings.test.ts
//
// shared/test/permission-fences.test.ts proves the rule lists. This proves they reach the CLI:
// on a FRESH install (no bundles at all) deploys are gated, this machine's home folder is
// fenced, and a bundle's ask guards ride along with it.

import fs from 'fs'
import os from 'os'
import { scratchApp, check, done } from './helpers/scratch-app.js'

const { db, close } = await scratchApp([])
const { cliSettingsArgs } = await import('../src/services/hook-injector.js')

db.prepare("INSERT INTO folders (id, path, name) VALUES ('f1', ?, 'p')").run(os.tmpdir())
db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, sort_order, created_at) VALUES ('i1', 'f1', 'c', ?, 'idle', 0, ?)").run(os.tmpdir(), Date.now())

function spawnSettings(): { permissions?: { allow?: string[]; deny?: string[]; ask?: string[] } } {
  const args = cliSettingsArgs('i1')
  const i = args.indexOf('--settings')
  return i >= 0 ? JSON.parse(fs.readFileSync(args[i + 1], 'utf8')) : {}
}

// ── fresh install: no bundles ─────────────────────────────────────────────────────
const bundles = db.prepare("SELECT value FROM settings WHERE key = 'permissionBundles'").get() as { value: string } | undefined
check('fresh install has no bundles switched on', !bundles || JSON.parse(bundles.value).length === 0, bundles?.value ?? 'unset')
const fresh = spawnSettings()
const ask = fresh.permissions?.ask ?? []
const deny = fresh.permissions?.deny ?? []
check('fresh install: deploys are gated (ask) with no bundles on', ask.includes('Bash(*wrangler*deploy*)') && ask.includes('PowerShell(*wrangler*deploy*)'), `${ask.length} ask rules`)
check('fresh install: the destructive fence is on', deny.includes('Bash(git push*--force*)'), `${deny.length} deny rules`)
const home = os.homedir()
const winHome = /^([A-Za-z]):[\\/](.*)$/.exec(home)
const homeRule = winHome
  ? `Bash(rm * /${winHome[1].toLowerCase()}/${winHome[2].replace(/\\/g, '/')})`
  : `Bash(rm * ${home})`
check('this machine\'s literal home folder is fenced at spawn', deny.includes(homeRule), homeRule)
// Every rule lands in every chat's settings file (about 45 KB at this size; the CLI documents no
// limit on rule count or settings size). Kept bounded so the list cannot grow without notice.
check('the deny list stays bounded (under 1400 rules)', deny.length < 1400, `${deny.length}`)
check('the PowerShell twin of the force-push fence is there', deny.includes('PowerShell(git push*--force*)'))

// ── The compaction hook never sees Read ───────────────────────────────────────
const hooks = (fresh as { hooks?: { PostToolUse?: Array<{ matcher: string }> } }).hooks?.PostToolUse ?? []
check('the compaction hook is registered', hooks.length === 1, JSON.stringify(hooks.map(h => h.matcher)))
const matcher = hooks[0]?.matcher ?? '*'
const matches = (tool: string) => matcher === '*' || new RegExp(`^(?:${matcher})$`).test(tool)
check('hook matcher is not "*"', matcher !== '*', matcher)
for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'NotebookEdit']) {
  check(`hook does not run on ${tool}`, !matches(tool))
}
for (const tool of ['Bash', 'PowerShell', 'mcp__playwriter__execute']) {
  check(`hook still runs on ${tool}`, matches(tool))
}

// ── deploy granted: the gate lifts ────────────────────────────────────────────────
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('permissionBundles', ?)").run(JSON.stringify(['read', 'git', 'deploy']))
const granted = spawnSettings()
const ask2 = granted.permissions?.ask ?? []
check('with deploy granted, the deploy gate is gone', !ask2.includes('Bash(*wrangler*deploy*)'))
check('the read bundle\'s guard rides along (git diff --output asks)', ask2.includes('Bash(git diff*--output*)'))
check('the git bundle\'s guard rides along (git reset --hard asks)', ask2.includes('Bash(git reset*--hard*)'))
check('no guard is also a deny (a deny would beat the ask)', ask2.every(r => !(granted.permissions?.deny ?? []).includes(r)))

// ── fence off: nothing denied ─────────────────────────────────────────────────────
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('blockDestructive', 'false')").run()
const off = spawnSettings()
check('switching Block destructive off removes the fence', !(off.permissions?.deny ?? []).includes('Bash(git push*--force*)'))

await close()
done()
