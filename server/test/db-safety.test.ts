// The database's upgrade path, its single
// owner, and the scripts that write to it.
//
// Every server here is a child process booting server/src/db.ts against its own temp data dir,
// with HOME and USERPROFILE pointed at a temp folder too, so neither version of the code can
// reach a real ~/.orcstrator or ~/.orcstrator-v2.
//
//   npx tsx server/test/db-safety.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import Database from 'better-sqlite3'

const made: string[] = []
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d }
const fakeHome = tmp('orc-dbs-home-')
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
const inProcDir = tmp('orc-dbs-inproc-')
fs.writeFileSync(path.join(inProcDir, 'orcstrator.db'), '')
process.env.ORCSTRATOR_DATA_DIR = inProcDir

const { check, done } = await import('./helpers/scratch-app.js')
const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')
const dbSrc = pathToFileURL(path.resolve('server/src/db.ts')).href

// A child "server": boots the database layer only. OPENED/REFUSED on stdout; HOLD keeps it up.
const childFile = path.join(tmp('orc-dbs-child-'), 'child.mts')
fs.writeFileSync(childFile, `
const m = await import(${JSON.stringify(dbSrc)})
try {
  await m.initDb()
} catch (e) {
  console.log('REFUSED ' + (e && e.message))
  process.exit(3)
}
let write = 'ok'
try { m.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('probe', '1')").run() } catch (e) { write = e.message }
console.log('OPENED ' + JSON.stringify({ readOnly: m.dbReadOnlyReason ?? null, write }))
if (process.env.HOLD) { console.log('READY'); setInterval(() => {}, 1000) } else process.exit(0)
`)

const childEnv = (dataDir: string, extra: Record<string, string> = {}) => ({
  ...process.env, ORCSTRATOR_DATA_DIR: dataDir, HOME: fakeHome, USERPROFILE: fakeHome, ORCSTRATOR_LOCK_WAIT_MS: '1500', ...extra,
})
function boot(dataDir: string, extra: Record<string, string> = {}): { out: string; code: number | null } {
  const r = spawnSync(process.execPath, [tsxCli, childFile], { env: childEnv(dataDir, extra), encoding: 'utf8', timeout: 60_000 })
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status }
}
async function hold(dataDir: string): Promise<ChildProcess> {
  const c = spawn(process.execPath, [tsxCli, childFile], { env: childEnv(dataDir, { HOLD: '1' }), stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error(`holder never became ready: ${buf}`)), 60_000)
    c.stdout!.on('data', d => { buf += String(d); if (buf.includes('READY')) { clearTimeout(t); resolve() } })
    c.once('exit', () => { clearTimeout(t); resolve() })
  })
  return c
}
// Kill a holder the way a crash would: the lock's own PID (tsx runs the script in a child
// process, which on Linux outlives its killed wrapper), then the wrapper.
async function crash(c: ChildProcess, dataDir: string): Promise<void> {
  let pid = 0
  try { pid = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.lock'), 'utf8')).pid } catch { /* no lock */ }
  if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  c.kill('SIGKILL')
  for (let i = 0; i < 50 && pid; i++) { try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 100)) } catch { break } }
}
const version = (file: string) => { const d = new Database(file, { readonly: true }); try { return (d.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v } finally { d.close() } }
const withDb = <T>(file: string, fn: (d: Database.Database) => T): T => { const d = new Database(file); try { return fn(d) } finally { d.close() } }
const pend = (file: string, below: number) => withDb(file, d => d.prepare('DELETE FROM schema_version WHERE version >= ?').run(below))

// ── A database at the latest version, with some data in it ──────────────────────────────────
const A = tmp('orc-dbs-a-')
fs.writeFileSync(path.join(A, 'orcstrator.db'), '')
const first = boot(A)
check('setup: a fresh data dir boots', first.out.includes('OPENED'), first.out.slice(-200))
const fileA = path.join(A, 'orcstrator.db')
const latest = version(fileA)
withDb(fileA, d => {
  d.prepare("INSERT INTO folders (id, path, name) VALUES ('f1', 'C:/x', 'x')").run()
  for (let i = 0; i < 25; i++) d.prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(`k${i}`)
})

// ── A pending migration is preceded by a VERIFIED backup ─────────────────────────────────
{
  pend(fileA, 52)
  const r = boot(A)
  const dir = path.join(A, 'backups')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.startsWith('pre-migration-v51-') && f.endsWith('.db')) : []
  const extra = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => !f.endsWith('.db')) : []
  check('a pending migration writes a backup file first (one self-contained file)', files.length === 1 && extra.length === 0, `${files.join(',') || 'no backups dir'} | ${r.out.slice(-160)}`)
  if (files.length === 1) {
    const b = new Database(path.join(dir, files[0]), { readonly: true })
    const integrity = b.pragma('integrity_check', { simple: true })
    const bVersion = (b.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v
    const bFolders = (b.prepare('SELECT COUNT(*) AS n FROM folders').get() as { n: number }).n
    b.close()
    check('... the backup opens and passes integrity_check', integrity === 'ok', String(integrity))
    check('... it is the database as it was BEFORE the migration (v51, same rows)', bVersion === 51 && bFolders === 1, `v${bVersion}, ${bFolders} folder(s)`)
  }
  check('... and then the migration ran', version(fileA) === latest, `v${version(fileA)}`)

  // A backup that cannot be made means NO migration, and a read-only database that says why.
  pend(fileA, 52)
  const forced = boot(A, { ORCSTRATOR_FORCE_BACKUP_FAILURE: '1' })
  check('a failed backup refuses to migrate (version unchanged)', version(fileA) === 51, `v${version(fileA)} | ${forced.out.slice(-200)}`)
  check('... the app still opens, read-only, with the reason', /OPENED .*"readOnly":"Could not make a verified backup/.test(forced.out), forced.out.split('\n').filter(l => l.startsWith('OPENED')).join(''))
  check('... and a write is refused', /OPENED .*"write":"attempt to write a readonly database"/.test(forced.out))
  boot(A) // restore to latest for what follows

  // Only the newest few are kept: four more pending boots leave at most three backups.
  for (let i = 0; i < 4; i++) { pend(fileA, 52); boot(A) }
  const kept = fs.existsSync(path.join(A, 'backups')) ? fs.readdirSync(path.join(A, 'backups')).filter(f => f.startsWith('pre-migration-') && f.endsWith('.db')) : []
  check('old pre-migration backups are pruned (the newest 3 are kept)', kept.length === 3, `${kept.length} kept`)
}

// ── Each migration is ONE transaction ─────────────────────────────────────────────────
{
  pend(fileA, 52)
  withDb(fileA, d => {
    d.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cloudSyncUrl', '\"https://x\"')").run()
    // Migration 052 deletes that row, then records its version. Make the second step fail.
    d.exec("CREATE TRIGGER boom BEFORE INSERT ON schema_version WHEN NEW.version = 52 BEGIN SELECT RAISE(ABORT, 'boom'); END;")
  })
  const r = boot(A)
  const kept = withDb(fileA, d => d.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'cloudSyncUrl'").get() as { n: number }).n
  check('a migration that fails halfway is rolled back whole (its first write undone)', r.code !== 0 && kept === 1, `exit ${r.code}, cloudSyncUrl rows ${kept}`)
  withDb(fileA, d => d.exec('DROP TRIGGER boom'))
  boot(A)

  // 010 used to be the one migration that could not run twice.
  const db = await import('../src/db.js') as Record<string, unknown>
  await (db.initDb as () => Promise<void>)()
  const run = db._runMigrationForTest as ((n: number) => void) | undefined
  let ok = false, err = ''
  try {
    const live = db.db as Database.Database
    live.prepare('DELETE FROM schema_version WHERE version = 10').run()
    run!(10)
    ok = true
  } catch (e) { err = (e as Error).message }
  check('migration 010 runs again cleanly on a database that already has its columns', ok, err)
}

// ── The two missing indexes exist and are used ──────────────────────────────────────
{
  const plans = withDb(fileA, d => ({
    task: (d.prepare('EXPLAIN QUERY PLAN SELECT SUM(input_tokens) FROM turn_costs WHERE task_id = ?').all('t') as Array<{ detail: string }>).map(r => r.detail).join(' | '),
    created: (d.prepare('EXPLAIN QUERY PLAN SELECT * FROM turn_costs WHERE created_at >= ?').all(0) as Array<{ detail: string }>).map(r => r.detail).join(' | '),
  }))
  check('a task-cost lookup uses an index on turn_costs(task_id), not a full scan', /USING INDEX idx_turn_costs_task/.test(plans.task), plans.task)
  check('a date-range usage query uses an index on turn_costs(created_at)', /USING INDEX idx_turn_costs_created/.test(plans.created), plans.created)
}

// ── One server per data dir ──────────────────────────────────────────────────────────────
// A database that was already past the routine migration when self_close shipped. The column
// used to sit in that migration's list, so an upgraded database never got it and the server
// crashed at boot on "no such column: self_close". A fresh database hid it.
{
  const cols = () => withDb(fileA, d => (d.pragma('table_info(pipeline_tasks)') as Array<{ name: string }>).map(c => c.name).sort().join(','))
  const freshCols = cols()
  withDb(fileA, d => d.exec('ALTER TABLE pipeline_tasks DROP COLUMN self_close'))
  pend(fileA, 55)
  const r = boot(A)
  check('055 a v54 database without self_close boots and gains the column', r.out.includes('OPENED') && cols().includes('self_close') && version(fileA) === latest, `v${version(fileA)} | ${r.out.slice(-200)}`)
  check('055 ... and its pipeline_tasks columns now match a fresh database exactly', cols() === freshCols)
  pend(fileA, 55)
  const again = boot(A)
  check('055 ... and it runs again cleanly on a database that already has the column', again.out.includes('OPENED') && version(fileA) === latest, again.out.slice(-200))
}

{
  const holder = await hold(A)
  const second = boot(A)
  check('a second server on the same data dir refuses to start, with a clear message', second.code !== 0 && /Another OrcStrator server \(PID \d+\) is already using this data folder/.test(second.out), second.out.split('\n').filter(l => /OPENED|REFUSED/.test(l)).join(' '))
  // A crash leaves the lock file behind; the next start must not be blocked by it.
  await crash(holder, A)
  const afterCrash = boot(A)
  check('a lock left by a crashed server is taken over (no stuck restarts)', afterCrash.out.includes('OPENED'), afterCrash.out.slice(-160))
  // Dev-watch restart: the old server is killed and the new one starts at once.
  const h2 = await hold(A)
  await crash(h2, A)
  const restart = boot(A)
  check('a kill-then-restart (dev-watch) starts cleanly', restart.out.includes('OPENED'), restart.out.slice(-160))
  // A lock whose PID now belongs to another program (same number, different start time).
  const stranger = spawn(process.execPath, ['-e', 'setInterval(function(){},1000)'], { stdio: 'ignore' })
  await new Promise(r => stranger.once('spawn', r))
  fs.writeFileSync(path.join(A, 'server.lock'), JSON.stringify({ pid: stranger.pid, startedAt: Date.now() - 10 * 86_400_000, at: Date.now() }))
  const reused = boot(A)
  check('a lock naming a PID that now belongs to another program is stale', reused.out.includes('OPENED'), reused.out.slice(-160))
  stranger.kill('SIGKILL')
  // A crashed server's lock that happens to carry the NEW server's PID (PID reuse). It must be
  // rewritten with the new start time, or the next server reads the live lock as stale.
  {
    const lockSrc0 = pathToFileURL(path.resolve('server/src/data-dir-lock.ts')).href
    const O = tmp('orc-dbs-ownpid-')
    const w = path.join(O, 'w.mts')
    fs.writeFileSync(w, `
const m = await import(${JSON.stringify(lockSrc0)})
const nfs = await import('node:fs'); const np = await import('node:path')
const dir = process.argv[2]
nfs.writeFileSync(np.join(dir, 'server.lock'), JSON.stringify({ pid: process.pid, startedAt: 1, at: 1 }))
await m.acquireDataDirLock(dir, { waitMs: 500 })
const b = JSON.parse(nfs.readFileSync(np.join(dir, 'server.lock'), 'utf8'))
console.log('STARTED_AT_FRESH', Math.abs(b.startedAt - (Date.now() - process.uptime() * 1000)) < 5000)
`)
    const r = spawnSync(process.execPath, [tsxCli, w, O], { env: childEnv(O), encoding: 'utf8', timeout: 60_000 })
    check('a leftover lock that carries our own PID but an old start time is replaced, not adopted', /STARTED_AT_FRESH true/.test(r.stdout), (r.stdout + r.stderr).slice(-200))
  }

  // Several servers starting together after a crash left a stale lock: exactly one may win.
  const lockSrc = pathToFileURL(path.resolve('server/src/data-dir-lock.ts')).href
  const worker = path.join(tmp('orc-dbs-race-'), 'w.mts')
  fs.writeFileSync(worker, `
const m = await import(${JSON.stringify(lockSrc)})
const [dir, startAt, out] = process.argv.slice(2)
while (Date.now() < Number(startAt)) await new Promise(r => setTimeout(r, 5))
try {
  await m.acquireDataDirLock(dir, { waitMs: 1500 })
  const nfs = await import('node:fs')
  nfs.appendFileSync(out, process.pid + '\\n')
  // Held well past every loser's wait (1.5 s) and its slowest process-table read (about 5 s under
  // load), so a second line can only mean two owners at once, never one after the other.
  await new Promise(r => setTimeout(r, 15000))
} catch { /* refused: someone else owns it */ }
process.exit(0)
`)
  const counts: number[] = []
  for (let round = 0; round < 3; round++) {
    const R = tmp('orc-dbs-racedir-')
    fs.writeFileSync(path.join(R, 'server.lock'), JSON.stringify({ pid: 4000001, startedAt: 1, at: 1 }))
    const out = path.join(R, 'winners.txt')
    const startAt = Date.now() + 2500
    const kids = Array.from({ length: 6 }, () => spawn(process.execPath, [tsxCli, worker, R, String(startAt), out], { env: childEnv(R), stdio: 'ignore' }))
    await Promise.all(kids.map(k => new Promise(r => k.once('exit', r))))
    counts.push(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).length : 0)
  }
  check('six servers starting together on a stale lock: exactly one owns the folder, every round', counts.every(n => n === 1), `owners per round: ${counts.join(', ')}`)
}

// ── The version read and the table-rebuild helper ───────────────────────────────────────
{
  const B = tmp('orc-dbs-b-')
  fs.writeFileSync(path.join(B, 'orcstrator.db'), '')
  boot(B)
  withDb(path.join(B, 'orcstrator.db'), d => d.exec('ALTER TABLE schema_version RENAME COLUMN version TO v'))
  const r = boot(B)
  check('an unreadable schema version stops the boot with the real error (never "version 0")', r.code !== 0 && /no such column: version/.test(r.out), r.out.split('\n').filter(l => l.startsWith('REFUSED')).join(''))

  const db = await import('../src/db.js') as Record<string, unknown>
  const live = db.db as Database.Database
  const rebuild = db._dropNotNull as ((t: string, c: string) => void) | undefined
  live.exec(`
    CREATE TABLE p (id TEXT PRIMARY KEY);
    CREATE TABLE t (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) > 0),
      parent TEXT REFERENCES p(id) ON DELETE CASCADE,
      note TEXT DEFAULT 'a, b',
      UNIQUE (name, parent)
    );
    CREATE INDEX idx_t_parent ON t(parent);
    CREATE TRIGGER trg_t AFTER INSERT ON t BEGIN UPDATE t SET note = 'seen' WHERE id = NEW.id; END;
    INSERT INTO p VALUES ('p1');
    INSERT INTO t (id, name, parent) VALUES ('1', 'Alpha', 'p1');
  `)
  const before = (live.prepare("SELECT sql FROM sqlite_master WHERE name = 't'").get() as { sql: string }).sql
  let err = ''
  try { rebuild!('t', 'name') } catch (e) { err = (e as Error).message }
  const after = (live.prepare("SELECT sql FROM sqlite_master WHERE name = 't'").get() as { sql: string } | undefined)?.sql ?? ''
  const strip = (s: string) => s.replace(/\s+/g, ' ').replace(/CREATE TABLE "?t(__rebuild)?"?/, 'CREATE TABLE T').trim()
  check('the rebuild helper removes NOT NULL and nothing else (CHECK, COLLATE, FK, UNIQUE, defaults kept)',
    !err && strip(after) === strip(before.replace(' NOT NULL', '')), err || `${strip(after)}`)
  const info = live.prepare('PRAGMA table_info(t)').all() as Array<{ name: string; notnull: number }>
  check('... the column is now nullable', info.find(c => c.name === 'name')?.notnull === 0)
  const trig = live.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_t'").get() as { n: number }
  const idx = live.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_t_parent'").get() as { n: number }
  check('... its trigger and index survive', trig.n === 1 && idx.n === 1, `trigger ${trig.n}, index ${idx.n}`)
  const rows = live.prepare('SELECT id, name, parent, note FROM t').all()
  check('... and its data', JSON.stringify(rows) === JSON.stringify([{ id: '1', name: 'Alpha', parent: 'p1', note: 'seen' }]), JSON.stringify(rows))
  let refused = ''
  live.exec('CREATE TABLE q (id TEXT PRIMARY KEY, v TEXT NOT NULL); CREATE TABLE r (qid TEXT REFERENCES q(id) ON DELETE CASCADE);')
  try { rebuild?.('q', 'v') } catch (e) { refused = (e as Error).message }
  check('... and it refuses a table other tables reference (DROP would fire their ON DELETE)', /refusing to rebuild q/.test(refused), refused)
}

// ── The v1 import ───────────────────────────────────────────────────────────────────────
{
  const v1Dir = path.join(fakeHome, '.orcstrator')
  fs.mkdirSync(v1Dir, { recursive: true })
  fs.writeFileSync(path.join(v1Dir, 'orcstrator.db'), Buffer.alloc(8192, 0x41)) // not a database
  const C = tmp('orc-dbs-c-')
  const r = boot(C)
  check('a v1 database that is not a valid copy is NOT imported, and the app starts empty', r.out.includes('OPENED') && /could NOT import/.test(r.out), r.out.slice(-240))
  // A live v1 whose newest rows sit only in its -wal: the import must carry them.
  fs.rmSync(path.join(v1Dir, 'orcstrator.db'))
  const v1 = new Database(path.join(v1Dir, 'orcstrator.db'))
  v1.pragma('journal_mode = WAL')
  v1.pragma('wal_autocheckpoint = 0')
  v1.exec('CREATE TABLE marker (x TEXT)')
  v1.prepare("INSERT INTO marker VALUES ('from-wal')").run()
  const D = tmp('orc-dbs-d-')
  const r2 = boot(D)
  v1.close()
  const got = withDb(path.join(D, 'orcstrator.db'), d => d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'marker'").get() as { n: number }).n
  check('a v1 database still being written (rows only in its WAL) is imported consistently', r2.out.includes('OPENED') && got === 1, r2.out.slice(-160))
}

// ── The one-off VACUUM, and scripts back up before they write ──────────────────────────
{
  const E = tmp('orc-dbs-e-')
  fs.writeFileSync(path.join(E, 'orcstrator.db'), '')
  boot(E)
  const fileE = path.join(E, 'orcstrator.db')
  withDb(fileE, d => {
    d.exec("UPDATE settings SET value = value") // touch
    d.exec('CREATE TABLE junk (b BLOB)')
    const ins = d.prepare('INSERT INTO junk VALUES (?)')
    d.transaction(() => { for (let i = 0; i < 400; i++) ins.run(Buffer.alloc(16384, i % 250)) })()
    d.exec('DROP TABLE junk')
    d.pragma('auto_vacuum = NONE')
    d.pragma('wal_checkpoint(TRUNCATE)')
  })
  const sizeBefore = fs.statSync(fileE).size
  const env = { ...process.env, ORCSTRATOR_DATA_DIR: E, HOME: fakeHome, USERPROFILE: fakeHome }
  const holder = await hold(E)
  const refused = spawnSync(process.execPath, ['scripts/vacuum-db.mjs', '--apply'], { env, encoding: 'utf8' })
  check('the vacuum script refuses while the app holds the data dir', refused.status === 2 && /is running/.test(refused.stdout + refused.stderr), `exit ${refused.status} ${(refused.stdout + refused.stderr).slice(0, 160)}`)
  await crash(holder, E)
  const ran = spawnSync(process.execPath, ['scripts/vacuum-db.mjs', '--apply'], { env, encoding: 'utf8' })
  const sizeAfter = fs.statSync(fileE).size
  const mode = withDb(fileE, d => d.pragma('auto_vacuum', { simple: true }))
  const backups = fs.existsSync(path.join(E, 'backups')) ? fs.readdirSync(path.join(E, 'backups')).filter(f => f.startsWith('pre-vacuum') && f.endsWith('.db')) : []
  check('with the app closed it backs up, then shrinks the file and switches on incremental vacuum',
    ran.status === 0 && sizeAfter < sizeBefore / 2 && mode === 2 && backups.length === 1, `exit ${ran.status}, ${sizeBefore} -> ${sizeAfter} bytes, auto_vacuum ${mode}, backups ${backups.length} ${(ran.stdout + ran.stderr).slice(-200)}`)
  check('... and it leaves no lock behind', !fs.existsSync(path.join(E, 'server.lock')))
  // The maintainer-only scripts have their own tests, next to those scripts.
}

done()
const { closeDb } = await import('../src/db.js')
try { closeDb() } catch { /* already closed */ }
for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* a handle still open */ } }
process.exit(process.exitCode ?? 0)
