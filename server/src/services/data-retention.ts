// Housekeeping for files the app writes under its data dir.
//
// The tool-output compaction hook stores every full tool output it shortens in <data dir>/ccr,
// so the model can ask for it back. Those copies hold whatever the tools printed, secrets
// included, and nothing ever deleted them (they accumulate indefinitely). The
// per-chat CLI settings files and the compaction log grew the same way. Now:
//   - ccr files older than 7 days are deleted (a chat that needs one is long past it);
//   - the compaction log is rotated past 5 MB, after its new lines are counted;
//   - a chat's settings file is deleted when the chat is closed, and orphans at boot.
// Only plain files directly inside these folders are removed: no recursion, no links followed.

import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../config.js'
import { db } from '../db.js'

export const CCR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const LOG_ROTATE_BYTES = 5 * 1024 * 1024

export function ccrDir(): string { return path.join(DATA_DIR, 'ccr') }
export function cliSettingsDir(): string { return path.join(DATA_DIR, 'cli-settings') }
export function compactionLogPath(): string { return path.join(DATA_DIR, 'compaction-log.jsonl') }

function plainFiles(dir: string): string[] {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return entries.filter(e => e.isFile()).map(e => path.join(dir, e.name))
}

/** Delete stored tool outputs older than maxAgeMs. Returns how many were deleted. */
export function sweepToolOutputs(maxAgeMs = CCR_MAX_AGE_MS, now = Date.now()): number {
  let n = 0
  for (const file of plainFiles(ccrDir())) {
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) { fs.unlinkSync(file); n++ }
    } catch { /* in use or already gone */ }
  }
  return n
}

/** A chat's managed CLI settings file, gone with the chat. */
export function deleteChatSettingsFile(instanceId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(instanceId)) return
  try { fs.unlinkSync(path.join(cliSettingsDir(), `${instanceId}.settings.json`)) } catch { /* none */ }
}

/** Settings files for chats that no longer exist. Returns how many were deleted. */
export function sweepOrphanSettingsFiles(): number {
  let n = 0
  const exists = db.prepare('SELECT 1 FROM instances WHERE id = ?')
  for (const file of plainFiles(cliSettingsDir())) {
    const m = /^(.+)\.settings\.json$/.exec(path.basename(file))
    if (!m || exists.get(m[1])) continue
    try { fs.unlinkSync(file); n++ } catch { /* in use */ }
  }
  return n
}

/** Rotate the compaction log once it passes 5 MB. Call after its lines have been ingested. */
export function rotateCompactionLog(maxBytes = LOG_ROTATE_BYTES): boolean {
  const log = compactionLogPath()
  try {
    if (fs.statSync(log).size <= maxBytes) return false
    fs.renameSync(log, log.replace(/\.jsonl$/, '.1.jsonl'))
    // The new log starts at byte 0. Without this, once it grew past the old offset its first
    // lines would be skipped.
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('compactionLogOffset', '0')").run()
    return true
  } catch {
    return false
  }
}

export function runRetention(ingest: () => void): void {
  try {
    const ccr = sweepToolOutputs()
    const orphans = sweepOrphanSettingsFiles()
    ingest()
    const rotated = rotateCompactionLog()
    if (ccr || orphans || rotated) {
      console.log(`[retention] removed ${ccr} old tool output(s), ${orphans} orphan settings file(s)${rotated ? ', rotated the compaction log' : ''}`)
    }
  } catch (err) {
    console.warn('[retention] sweep failed:', (err as Error).message)
  }
}
