// One-off: give the database's empty pages back to the disk.
//
// The live database was 79% free pages: chats that were closed had their messages deleted,
// SQLite keeps the space for reuse, and the `auto_vacuum = INCREMENTAL` the server used to set
// on every open never applied to a database that already existed. This switches the mode on
// for good and compacts the file once. From then on the server's 6-hourly maintenance hands
// free pages back a few at a time.
//
// RUN IT WITH ORCSTRATOR STOPPED. It refuses while the server holds the data dir, and holds
// the data dir itself while it works, so the server cannot start halfway through.
//
//   node scripts/vacuum-db.mjs            show what it would do
//   node scripts/vacuum-db.mjs --apply    back up, verify the backup, then VACUUM
//
// Needs free disk space of about twice the database's size (the backup plus VACUUM's copy).
// Honours ORCSTRATOR_DATA_DIR like the server.

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, dbPath, openForWrite, verifiedBackup, dataDirLockHolder } from './lib/db-safety.mjs'

const APPLY = process.argv.includes('--apply')
const DIR = dataDir()
const FILE = dbPath()
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

if (!fs.existsSync(FILE)) {
  console.error(`No database at ${FILE}.`)
  process.exit(1)
}

const holder = dataDirLockHolder(DIR)
if (holder) {
  console.error(`OrcStrator is running (PID ${holder}) and holds ${DIR}. Close it first, then run this again.`)
  process.exit(2)
}

// Hold the data dir for the duration, exactly as a server would, so one cannot start mid-VACUUM.
// startedAt is this process's real start: a server compares it with the process table, and a
// "now" taken after a slow start would read as a different process and the lock as stale.
const lockPath = path.join(DIR, 'server.lock')
let fd
try {
  fd = fs.openSync(lockPath, 'wx')
} catch (err) {
  if (err.code !== 'EEXIST') throw err
  // A lock whose owner is dead (checked above): a crash left it. Replace it.
  fs.rmSync(lockPath, { force: true })
  fd = fs.openSync(lockPath, 'wx')
}
fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000), at: Date.now(), by: 'vacuum-db' }))
fs.closeSync(fd)
const unlock = () => { try { fs.rmSync(lockPath, { force: true }) } catch { /* already gone */ } }
process.on('exit', unlock)

const db = openForWrite(FILE)
const pageSize = db.pragma('page_size', { simple: true })
const pages = db.pragma('page_count', { simple: true })
const free = db.pragma('freelist_count', { simple: true })
const mode = db.pragma('auto_vacuum', { simple: true })
console.log(`${FILE}`)
console.log(`  size ${mb(pages * pageSize)}, free pages ${free} of ${pages} (${Math.round((free / Math.max(pages, 1)) * 100)}%, ${mb(free * pageSize)} reclaimable)`)
console.log(`  auto_vacuum ${mode} (${['off', 'full', 'incremental'][mode] ?? mode})`)

if (!APPLY) {
  console.log('\nNothing was changed. Re-run with --apply (OrcStrator closed) to back up and compact.')
  db.close()
  process.exit(0)
}

const backup = await verifiedBackup(db, 'pre-vacuum')
console.log(`\nBackup verified: ${backup}`)

db.pragma('wal_checkpoint(TRUNCATE)')
db.pragma('auto_vacuum = INCREMENTAL') // takes effect on the VACUUM below
db.exec('VACUUM')
db.pragma('wal_checkpoint(TRUNCATE)')

const after = db.pragma('page_count', { simple: true })
const integrity = db.pragma('integrity_check', { simple: true })
const saved = new Database(backup, { readonly: true })
const mismatch = []
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
  const a = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n
  const b = saved.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n
  if (a !== b) mismatch.push(`${name}: ${a} vs ${b}`)
}
saved.close()
console.log(`Done: ${mb(pages * pageSize)} -> ${mb(after * pageSize)}, auto_vacuum ${db.pragma('auto_vacuum', { simple: true })}, integrity ${integrity}, row counts ${mismatch.length ? 'DIFFER: ' + mismatch.join('; ') : 'match the backup'}`)
db.close()
if (integrity !== 'ok' || mismatch.length) {
  console.error(`Something is wrong. The verified backup is at ${backup}; restore it before starting OrcStrator.`)
  process.exit(3)
}
