import fs from 'fs'
import path from 'path'
import os from 'os'
import readline from 'readline'
import { db } from '../db.js'
import { computeCostUsd } from '@orcstrator/shared'

/**
 * Historical cost backfill from local Claude CLI session files.
 *
 * Scans ~/.claude/projects/<project>/<session-id>.jsonl and, for every session that
 * this app already knows about (instances.session_id, token_usage.session_id or
 * turn_costs.session_id), reconstructs total token usage from the per-request
 * assistant lines and compares it with what turn_costs already recorded.
 *
 * DESIGN CHOICE - delta rows, not per-request rows:
 * If the JSONL total exceeds the recorded turn_costs total by more than 5%, ONE
 * synthetic turn_costs row is inserted per session carrying the DELTA
 * (kind='backfill', cost computed locally from the pricing table, timestamp = last
 * assistant line, model = dominant model by token volume). The delta approach is
 * naturally idempotent: a second run re-sums turn_costs (now including the backfill
 * row), finds the gap below 5%, and inserts nothing. It also can never double-count,
 * which per-request insertion could if requestIds were missing or reused.
 *
 * Sessions never touched by OrcStrator are SKIPPED by design - the separate
 * "Sync Untracked" action (session-scanner.ts) imports those as token_usage rows,
 * after which a subsequent backfill run picks them up as known sessions.
 */

export interface BackfillSummary {
  sessionsScanned: number
  sessionsMatched: number
  rowsInserted: number
  tokensAdded: number
  costAdded: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GAP_THRESHOLD = 1.05 // insert only when JSONL > recorded by 5%

interface SessionJsonlUsage {
  uncachedInput: number
  cacheWrite: number
  cacheRead: number
  output: number
  dominantModel: string | null
  lastTimestampMs: number
}

export async function runBackfill(): Promise<BackfillSummary> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  const summary: BackfillSummary = { sessionsScanned: 0, sessionsMatched: 0, rowsInserted: 0, tokensAdded: 0, costAdded: 0 }
  if (!fs.existsSync(projectsDir)) return summary

  const knownSessions = collectKnownSessionIds()
  const files = collectJsonlFiles(projectsDir, 0, 3)
  console.log(`[backfill] Scanning ${files.length} session file(s); ${knownSessions.size} session(s) known to OrcStrator`)

  const recordedStmt = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS inp,
      COALESCE(SUM(output_tokens), 0) AS out,
      COALESCE(SUM(cache_creation_tokens), 0) AS cw,
      COALESCE(SUM(cache_read_tokens), 0) AS cr
    FROM turn_costs WHERE session_id = ?
  `)
  const instanceStmt = db.prepare('SELECT id, folder_id FROM instances WHERE session_id = ?')
  const turnInstanceStmt = db.prepare(`
    SELECT tc.instance_id AS id, COALESCE(NULLIF(tc.folder_id, ''), i.folder_id, '') AS folder_id
    FROM turn_costs tc LEFT JOIN instances i ON tc.instance_id = i.id
    WHERE tc.session_id = ? AND tc.instance_id != '' LIMIT 1
  `)
  const insertStmt = db.prepare(`
    INSERT INTO turn_costs (instance_id, folder_id, session_id, message_id, task_id, turn_index,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, computed_cost_usd, kind,
      duration_ms, model, cumulative_input, cumulative_output, cumulative_cost, created_at)
    VALUES (?, ?, ?, NULL, NULL, -1, ?, ?, ?, ?, 0, ?, 'backfill', NULL, ?, ?, ?, ?, ?)
  `)

  let processed = 0
  for (const filePath of files) {
    const sessionId = path.basename(filePath, '.jsonl')
    if (!UUID_RE.test(sessionId)) continue
    summary.sessionsScanned++
    if (!knownSessions.has(sessionId)) continue
    summary.sessionsMatched++

    processed++
    if (processed % 25 === 0) {
      console.log(`[backfill] Progress: ${processed} matched session(s) processed, ${summary.rowsInserted} row(s) inserted so far`)
    }

    let usage: SessionJsonlUsage | null = null
    try {
      usage = await parseSessionJsonl(filePath)
    } catch (err) {
      console.warn(`[backfill] Failed to parse ${sessionId}:`, err)
      continue
    }
    if (!usage) continue

    const jsonlTotalInput = usage.uncachedInput + usage.cacheWrite + usage.cacheRead
    const jsonlTotal = jsonlTotalInput + usage.output
    if (jsonlTotal === 0) continue

    const rec = recordedStmt.get(sessionId) as { inp: number; out: number; cw: number; cr: number }
    const recordedTotal = rec.inp + rec.out
    if (jsonlTotal <= recordedTotal * GAP_THRESHOLD) continue

    // Delta = what the JSONL saw that turn_costs never recorded
    const deltaInput = Math.max(0, jsonlTotalInput - rec.inp) // TOTAL input convention (incl. cache)
    const deltaCacheWrite = Math.max(0, usage.cacheWrite - rec.cw)
    const deltaCacheRead = Math.max(0, usage.cacheRead - rec.cr)
    const deltaOutput = Math.max(0, usage.output - rec.out)
    if (deltaInput === 0 && deltaOutput === 0) continue
    const deltaUncached = Math.max(0, deltaInput - deltaCacheWrite - deltaCacheRead)

    // Deliberately left on the default 5-minute cache-write rate: this reconstructs
    // historical gaps, turn_costs records no TTL per row, and historical rows are not
    // repriced.
    const computed = computeCostUsd(
      { input: deltaUncached, output: deltaOutput, cacheWrite: deltaCacheWrite, cacheRead: deltaCacheRead },
      usage.dominantModel
    )

    // Resolve instance + folder when possible (chat instance owning the session, or a
    // prior turn_costs row); otherwise '' - analytics fall back gracefully.
    let instanceId = ''
    let folderId = ''
    const inst = instanceStmt.get(sessionId) as { id: string; folder_id: string } | undefined
    if (inst) {
      instanceId = inst.id
      folderId = inst.folder_id || ''
    } else {
      const tcInst = turnInstanceStmt.get(sessionId) as { id: string; folder_id: string } | undefined
      if (tcInst) {
        instanceId = tcInst.id
        folderId = tcInst.folder_id || ''
      }
    }

    const createdAt = usage.lastTimestampMs || Math.round(fs.statSync(filePath).mtimeMs)

    try {
      insertStmt.run(
        instanceId, folderId, sessionId,
        deltaInput, deltaOutput, deltaCacheWrite, deltaCacheRead,
        computed, usage.dominantModel,
        deltaInput, deltaOutput, computed ?? 0, createdAt
      )
      summary.rowsInserted++
      summary.tokensAdded += deltaInput + deltaOutput
      summary.costAdded += computed ?? 0
    } catch (err) {
      console.error(`[backfill] Insert failed for session ${sessionId}:`, err)
    }
  }

  summary.costAdded = +summary.costAdded.toFixed(4)
  console.log(`[backfill] Done: scanned=${summary.sessionsScanned} matched=${summary.sessionsMatched} inserted=${summary.rowsInserted} tokensAdded=${summary.tokensAdded} costAdded=$${summary.costAdded}`)
  return summary
}

function collectKnownSessionIds(): Set<string> {
  const known = new Set<string>()
  const sources = [
    'SELECT DISTINCT session_id AS sid FROM instances WHERE session_id IS NOT NULL AND session_id != \'\'',
    'SELECT DISTINCT session_id AS sid FROM token_usage WHERE session_id IS NOT NULL AND session_id != \'\'',
    'SELECT DISTINCT session_id AS sid FROM turn_costs WHERE session_id IS NOT NULL AND session_id != \'\'',
  ]
  for (const sql of sources) {
    try {
      for (const row of db.prepare(sql).all() as Array<{ sid: string }>) known.add(row.sid)
    } catch { /* table may not exist on fresh DBs */ }
  }
  return known
}

function collectJsonlFiles(dir: string, depth: number, maxDepth: number): string[] {
  if (depth > maxDepth) return []
  const files: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectJsonlFiles(fullPath, depth + 1, maxDepth))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath)
    }
  }
  return files
}

/**
 * Stream a session JSONL file (can be tens of MB - never readFileSync) and aggregate
 * usage per requestId. Each unique requestId is one API call; the LAST assistant line
 * for a requestId carries the final usage, so a Map keyed by requestId with
 * last-write-wins gives exact per-call usage.
 */
async function parseSessionJsonl(filePath: string): Promise<SessionJsonlUsage | null> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  interface RequestUsage { uncached: number; cw: number; cr: number; out: number; model: string | null; ts: number }
  const perRequest = new Map<string, RequestUsage>()
  let anonCounter = 0

  for await (const line of rl) {
    // Cheap pre-filter before JSON.parse - most lines are not assistant lines
    if (!line.includes('"type":"assistant"')) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (obj.type !== 'assistant') continue
    const message = obj.message as Record<string, unknown> | undefined
    const usage = message?.usage as Record<string, unknown> | undefined
    if (!usage) continue

    const requestId = (typeof obj.requestId === 'string' && obj.requestId)
      || (typeof obj.request_id === 'string' && obj.request_id)
      || `anon-${anonCounter++}`
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN

    perRequest.set(requestId, {
      uncached: Number(usage.input_tokens) || 0,
      cw: Number(usage.cache_creation_input_tokens) || 0,
      cr: Number(usage.cache_read_input_tokens) || 0,
      out: Number(usage.output_tokens) || 0,
      model: typeof message?.model === 'string' ? (message.model as string) : null,
      ts: Number.isFinite(ts) ? ts : 0,
    })
  }

  if (perRequest.size === 0) return null

  const result: SessionJsonlUsage = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0, dominantModel: null, lastTimestampMs: 0 }
  const modelWeights = new Map<string, number>()
  for (const r of perRequest.values()) {
    result.uncachedInput += r.uncached
    result.cacheWrite += r.cw
    result.cacheRead += r.cr
    result.output += r.out
    if (r.ts > result.lastTimestampMs) result.lastTimestampMs = r.ts
    if (r.model) {
      modelWeights.set(r.model, (modelWeights.get(r.model) ?? 0) + r.uncached + r.cw + r.cr + r.out)
    }
  }
  let best = 0
  for (const [model, weight] of modelWeights) {
    if (weight > best) { best = weight; result.dominantModel = model }
  }
  return result
}
