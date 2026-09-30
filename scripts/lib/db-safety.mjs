// Shared safety rails for any script that WRITES to the OrcStrator database.
//
// The pattern repair-turn-costs.ts already used, made reusable:
//   1. the data dir comes from ORCSTRATOR_DATA_DIR like the server's, never a hardcoded path;
//   2. a busy timeout, so a write waits for the server instead of failing or tearing;
//   3. a verified backup first: SQLite's online backup API (WAL-safe, never `cp`), then the
//      copy is opened and checked (integrity_check ok, every table readable);
//   4. the writes happen inside one transaction, so a crash leaves all or nothing.
//
// dataDirLockHolder() reads the server's single-owner lock (server/src/data-dir-lock.ts) for
// scripts that must not run while the app is up (VACUUM).

import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function dataDir() {
  return process.env.ORCSTRATOR_DATA_DIR || path.join(os.homedir(), '.orcstrator-v2')
}

export function dbPath() {
  return process.env.ORCSTRATOR_DB || path.join(dataDir(), 'orcstrator.db')
}

/** Open for writing, with the same busy timeout the server uses. */
export function openForWrite(file = dbPath()) {
  const db = new Database(file, { fileMustExist: true })
  db.pragma('busy_timeout = 5000')
  return db
}

/**
 * Back up `db` to <data dir>/backups/<label>-<timestamp>.db and prove the copy. Throws if the
 * copy fails either check (and deletes it). Returns the backup's path.
 */
export async function verifiedBackup(db, label) {
  const dir = path.join(path.dirname(db.name), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
  await db.backup(dest)
  // The copy inherits WAL mode; make it one self-contained file (no -wal/-shm beside it).
  const single = new Database(dest, { fileMustExist: true })
  try { single.pragma('journal_mode = DELETE') } finally { single.close() }
  const copy = new Database(dest, { readonly: true, fileMustExist: true })
  try {
    const integrity = copy.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') throw new Error(`integrity_check on the backup said: ${integrity}`)
    // Every table is there and readable. Row counts are NOT compared with the live file: a
    // script may run while the app is writing, so the live counts move on after the copy.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    for (const { name } of tables) {
      copy.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get()
    }
  } catch (err) {
    copy.close()
    fs.rmSync(dest, { force: true })
    throw err
  }
  copy.close()
  return dest
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** PID of the live server holding this data dir, or null. */
export function dataDirLockHolder(dir = dataDir()) {
  try {
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'server.lock'), 'utf8'))
    if (typeof body.pid === 'number' && body.pid !== process.pid && pidAlive(body.pid)) return body.pid
  } catch { /* no lock, or unreadable: nobody holds it */ }
  return null
}
