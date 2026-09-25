import type { FastifyInstance } from 'fastify'
import { getCurrentUsage, generateAuthUrl, exchangeCode, disconnect, fetchUsage } from '../services/usage-monitor.js'
import { scanUntrackedSessions } from '../services/session-scanner.js'
import { runBackfill } from '../services/backfill.js'
import { ingestCompactionLog, getCompactionSavingsSummary } from '../services/compaction-savings.js'
import { db } from '../db.js'
import { resolvePricing, MODEL_PRICING } from '@orcstrator/shared'
import { promptCacheTtl } from '../services/prompt-cache.js'
import type { DailySavingsEntry, SavingsSummary, UsageTrendDay, UsageByColumn, UsageForecast, UsageAnomaly, UsageEfficiencyDay } from '@orcstrator/shared'

// === Unified cost source ===
//
// Effective per-row cost: the CLI-reported value when present, the locally computed
// API-equivalent (pricing table) otherwise. This is THE cost expression - every
// analytics query goes through it.
const EFFECTIVE_TC_COST = 'COALESCE(NULLIF(tc.cost_usd, 0), tc.computed_cost_usd, 0)'

// Folder attribution with fallback: turn_costs.folder_id when set, else the owning
// instance's folder, else '' (renders as Unknown only when truly unattributable).
const TC_FOLDER = "COALESCE(NULLIF(tc.folder_id, ''), i.folder_id, '')"

// Chat identity for analytics. NOT `instances` - closing a chat deletes that row, and
// history joined against it would lose its name and its project the moment it closed.
// `instances_all` (db.ts migration040) unions the live rows with the close tombstones,
// so a chat keeps its identity for as long as its cost rows exist. Every analytics join
// that only needs id / name / folder_id should read this.
const INSTANCE_SOURCE = 'instances_all'

// All analytics read this CTE: per-turn rows (turn_costs - chat turns, pipeline runs,
// compact runs, JSONL backfill) plus legacy token_usage rows ONLY for sessions that
// turn_costs does not cover (pre-turn_costs history and "Sync Untracked" imports that
// have not been backfilled yet). The exclusion prevents double counting, because
// pipeline runs historically wrote BOTH a token_usage row and turn_costs rows.
const UNIFIED_CTE = `unified AS (
  SELECT
    tc.created_at,
    ${EFFECTIVE_TC_COST} AS cost_usd,
    COALESCE(tc.input_tokens, 0) AS input_tokens,
    COALESCE(tc.output_tokens, 0) AS output_tokens,
    COALESCE(tc.cache_read_tokens, 0) AS cache_read_tokens,
    COALESCE(tc.cache_creation_tokens, 0) AS cache_creation_tokens,
    0 AS prompt_chars,
    tc.session_id,
    tc.instance_id,
    ${TC_FOLDER} AS folder_id,
    'chat' AS role,
    tc.task_id,
    tc.model,
    COALESCE(tc.kind, 'turn') AS kind,
    0 AS is_overdrive_session
  FROM turn_costs tc
  LEFT JOIN ${INSTANCE_SOURCE} i ON tc.instance_id = i.id
  UNION ALL
  SELECT
    tu.created_at,
    COALESCE(tu.cost_usd, 0) AS cost_usd,
    COALESCE(tu.input_tokens, 0) AS input_tokens,
    COALESCE(tu.output_tokens, 0) AS output_tokens,
    COALESCE(tu.cache_read_tokens, 0) AS cache_read_tokens,
    COALESCE(tu.cache_creation_tokens, 0) AS cache_creation_tokens,
    COALESCE(tu.prompt_chars, 0) AS prompt_chars,
    tu.session_id,
    tu.instance_id,
    COALESCE(i.folder_id, '') AS folder_id,
    COALESCE(tu.role, 'direct') AS role,
    tu.task_id,
    NULL AS model,
    'legacy' AS kind,
    COALESCE(tu.is_overdrive_session, 0) AS is_overdrive_session
  FROM token_usage tu
  LEFT JOIN ${INSTANCE_SOURCE} i ON tu.instance_id = i.id
  WHERE (COALESCE(tu.input_tokens, 0) > 0 OR COALESCE(tu.output_tokens, 0) > 0 OR COALESCE(tu.cost_usd, 0) > 0)
    AND (tu.session_id IS NULL OR tu.session_id NOT IN (
      SELECT DISTINCT session_id FROM turn_costs WHERE session_id IS NOT NULL
    ))
)`

// Session identity for COUNT(DISTINCT ...) - rows without a session each count once.
const SESSION_KEY = "COALESCE(session_id, instance_id || '-' || created_at)"

function sinceMs(days: string | undefined, fallback: number): { n: number; since: number } {
  const n = Math.min(Math.max(parseInt(days || '') || fallback, 1), 90)
  return { n, since: Date.now() - n * 86_400_000 }
}

export default async function usageRoutes(app: FastifyInstance): Promise<void> {

  // === ANALYTICS ENDPOINTS ===

  // Daily trend with token type breakdown
  app.get('/usage/trend', async (request) => {
    const { days } = request.query as Record<string, string>
    const { since } = sinceMs(days, 7)

    const rows = db.prepare(`
      WITH ${UNIFIED_CTE}
      SELECT
        date(created_at / 1000, 'unixepoch') AS day,
        COALESCE(SUM(input_tokens) - SUM(cache_read_tokens) - SUM(cache_creation_tokens), 0) AS cold_input,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COUNT(DISTINCT ${SESSION_KEY}) AS sessions
      FROM unified
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(since) as Array<Record<string, number | string>>

    return rows.map(r => ({
      day: r.day as string,
      coldInput: Math.max(0, Number(r.cold_input) || 0),
      cacheCreation: Number(r.cache_creation) || 0,
      cacheRead: Number(r.cache_read) || 0,
      outputTokens: Number(r.output_tokens) || 0,
      costUsd: Number(r.cost_usd) || 0,
      sessions: Number(r.sessions) || 0,
    } satisfies UsageTrendDay))
  })

  // Cost breakdown by pipeline column
  app.get('/usage/by-column', async (request) => {
    const { days } = request.query as Record<string, string>
    const { since } = sinceMs(days, 7)

    const rows = db.prepare(`
      WITH ${UNIFIED_CTE}
      SELECT
        COALESCE(pt."column", 'other') AS col,
        COALESCE(SUM(u.cost_usd), 0) AS cost_usd,
        COUNT(DISTINCT COALESCE(u.session_id, u.instance_id || '-' || u.created_at)) AS sessions
      FROM unified u
      LEFT JOIN pipeline_tasks pt ON u.task_id = pt.id
      WHERE u.created_at >= ?
      GROUP BY col
      ORDER BY cost_usd DESC
    `).all(since) as Array<Record<string, number | string>>

    const dataMap = new Map(rows.map(r => [r.col as string, r]))
    const PIPELINE_COLS = ['ready', 'in_progress', 'in_review']
    for (const col of PIPELINE_COLS) {
      if (!dataMap.has(col)) dataMap.set(col, { col, cost_usd: 0, sessions: 0 })
    }

    return Array.from(dataMap.values()).map(r => ({
      column: r.col as string,
      costUsd: Number(r.cost_usd) || 0,
      sessions: Number(r.sessions) || 0,
    } satisfies UsageByColumn))
  })

  // Linear regression forecast
  app.get('/usage/forecast', async (request) => {
    const { days } = request.query as Record<string, string>
    const { since } = sinceMs(days, 14)

    const rows = db.prepare(`
      WITH ${UNIFIED_CTE}
      SELECT
        date(created_at / 1000, 'unixepoch') AS day,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM unified
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(since) as Array<{ day: string; cost_usd: number }>

    if (rows.length < 2) {
      return { projectedMonthly: 0, dailyRate: 0, r2: 0 } satisfies UsageForecast
    }

    const costs = rows.map(r => Number(r.cost_usd) || 0)
    const nPts = costs.length
    const xs = costs.map((_, i) => i)
    const sumX = xs.reduce((a, b) => a + b, 0)
    const sumY = costs.reduce((a, b) => a + b, 0)
    const sumXY = xs.reduce((a, x, i) => a + x * costs[i], 0)
    const sumX2 = xs.reduce((a, x) => a + x * x, 0)
    const meanY = sumY / nPts

    const denom = nPts * sumX2 - sumX * sumX
    const m = denom !== 0 ? (nPts * sumXY - sumX * sumY) / denom : 0
    const b = (sumY - m * sumX) / nPts

    const ssRes = costs.reduce((a, y, i) => a + (y - (m * i + b)) ** 2, 0)
    const ssTot = costs.reduce((a, y) => a + (y - meanY) ** 2, 0)
    const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0

    const dailyRate = Math.max(0, sumY / nPts)
    const projectedMonthly = +(dailyRate * 30).toFixed(2)

    return { projectedMonthly, dailyRate: +dailyRate.toFixed(4), r2: +r2.toFixed(4) } satisfies UsageForecast
  })

  // Anomaly detection: sessions costing > 2x rolling median
  app.get('/usage/anomalies', async (request) => {
    const { days } = request.query as Record<string, string>
    const { since } = sinceMs(days, 7)

    const rows = db.prepare(`
      WITH ${UNIFIED_CTE}, sessions AS (
        SELECT
          ${SESSION_KEY} AS skey,
          MAX(session_id) AS session_id,
          MIN(role) AS role,
          SUM(cost_usd) AS cost_usd,
          MAX(created_at) AS created_at,
          MAX(task_id) AS task_id
        FROM unified
        WHERE created_at >= ?
        GROUP BY skey
        HAVING SUM(cost_usd) > 0
      )
      SELECT s.session_id, s.role, s.cost_usd, s.created_at, pt.title AS task_title
      FROM sessions s
      LEFT JOIN pipeline_tasks pt ON s.task_id = pt.id
      ORDER BY s.cost_usd DESC
    `).all(since) as Array<Record<string, unknown>>

    const costs = rows.map(r => Number(r.cost_usd) || 0).sort((a, b) => a - b)
    const median = costs.length > 0 ? costs[Math.floor(costs.length / 2)] : 0
    const threshold = median * 2

    return rows.map(r => {
      const cost = Number(r.cost_usd) || 0
      return {
        sessionId: r.session_id as string,
        role: (r.role as string) || 'unknown',
        costUsd: cost,
        medianCost: +median.toFixed(4),
        multiplier: median > 0 ? +(cost / median).toFixed(1) : 0,
        taskTitle: (r.task_title as string) || null,
        createdAt: r.created_at as number,
        isAnomaly: cost > threshold,
      } satisfies UsageAnomaly
    })
  })

  // Daily efficiency metrics
  app.get('/usage/efficiency', async (request) => {
    const { days } = request.query as Record<string, string>
    const { since } = sinceMs(days, 7)

    const rows = db.prepare(`
      WITH ${UNIFIED_CTE}
      SELECT
        date(created_at / 1000, 'unixepoch') AS day,
        CASE WHEN SUM(input_tokens) > 0
          THEN CAST(SUM(output_tokens) AS REAL) / SUM(input_tokens)
          ELSE 0 END AS yield_ratio,
        CASE WHEN COUNT(*) > 0
          THEN SUM(prompt_chars) / COUNT(*)
          ELSE 0 END AS avg_prompt_chars,
        CASE WHEN SUM(input_tokens) > 0
          THEN CAST(SUM(cache_read_tokens) AS REAL) / SUM(input_tokens)
          ELSE 0 END AS cache_hit_ratio
      FROM unified
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(since) as Array<Record<string, number | string>>

    return rows.map(r => {
      const hitRatio = Number(r.cache_hit_ratio) || 0
      let grade: 'A' | 'B' | 'C' | 'D' | 'F'
      if (hitRatio >= 0.8) grade = 'A'
      else if (hitRatio >= 0.6) grade = 'B'
      else if (hitRatio >= 0.4) grade = 'C'
      else if (hitRatio >= 0.2) grade = 'D'
      else grade = 'F'

      return {
        day: r.day as string,
        yieldRatio: +(Number(r.yield_ratio) || 0).toFixed(4),
        avgPromptChars: Math.round(Number(r.avg_prompt_chars) || 0),
        cacheGrade: grade,
      } satisfies UsageEfficiencyDay
    })
  })

  // Token usage history (raw legacy table, kept for debugging)
  app.get('/usage/history', async (request) => {
    const { limit = '50' } = request.query as Record<string, string>
    const rows = db.prepare(`
      SELECT session_id, instance_id, role, task_id, prompt_chars, input_tokens, output_tokens, cost_usd, created_at
      FROM token_usage
      ORDER BY created_at DESC
      LIMIT ?
    `).all(Math.min(parseInt(limit) || 50, 200))
    return rows
  })

  // Token savings aggregation
  app.get('/usage/savings', async (request) => {
    const { days } = request.query as Record<string, string>
    const { since } = sinceMs(days, 7)

    const rows = db.prepare(`
      WITH ${UNIFIED_CTE}
      SELECT
        date(created_at / 1000, 'unixepoch') AS day,
        SUM(input_tokens) AS total_input,
        SUM(cache_read_tokens) AS cache_read,
        SUM(cache_creation_tokens) AS cache_creation,
        SUM(output_tokens) AS total_output,
        SUM(cost_usd) AS total_cost,
        COUNT(DISTINCT ${SESSION_KEY}) AS sessions,
        SUM(is_overdrive_session) AS overdrive_sessions
      FROM unified
      WHERE created_at >= ? AND (input_tokens > 0 OR output_tokens > 0)
      GROUP BY day
      ORDER BY day ASC
    `).all(since) as Array<Record<string, number | string>>

    const dailyEntries: DailySavingsEntry[] = rows.map(r => ({
      day: r.day as string,
      totalInput: Number(r.total_input) || 0,
      cacheRead: Number(r.cache_read) || 0,
      cacheCreation: Number(r.cache_creation) || 0,
      coldInput: Math.max(0, (Number(r.total_input) || 0) - (Number(r.cache_read) || 0) - (Number(r.cache_creation) || 0)),
      totalOutput: Number(r.total_output) || 0,
      totalCost: Number(r.total_cost) || 0,
      sessions: Number(r.sessions) || 0,
      overdriveSessions: Number(r.overdrive_sessions) || 0,
    }))

    const totalCacheRead = dailyEntries.reduce((s, d) => s + d.cacheRead, 0)
    const totalSessions = dailyEntries.reduce((s, d) => s + d.sessions, 0)
    const overdriveSessions = dailyEntries.reduce((s, d) => s + d.overdriveSessions, 0)
    const overdrivePct = totalSessions > 0 ? Math.round(overdriveSessions / totalSessions * 100) : 0

    // Cache-read savings per row's model: cacheRead x (input price - cacheRead price).
    // Replaces the old hardcoded $2.70/M which was wrong for every non-Sonnet model.
    const modelRows = db.prepare(`
      WITH ${UNIFIED_CTE}
      SELECT model, COALESCE(SUM(cache_read_tokens), 0) AS cache_read
      FROM unified
      WHERE created_at >= ?
      GROUP BY model
    `).all(since) as Array<{ model: string | null; cache_read: number }>
    let savedRaw = 0
    for (const r of modelRows) {
      // Legacy rows carry no model - assume the app's default model family (opus-4-7)
      const p = resolvePricing(r.model) ?? MODEL_PRICING['opus-4-7']
      savedRaw += (Number(r.cache_read) || 0) * (p.input - p.cacheRead) / 1_000_000
    }
    const savedUsd = +savedRaw.toFixed(4)

    let recommendation: string | null = null
    if (totalSessions >= 5 && overdrivePct < 50) {
      recommendation = `Only ${overdrivePct}% of sessions reuse cache. Run tasks consecutively within 1h to activate Overdrive and cut input tokens by up to 85%.`
    }

    return {
      days: dailyEntries,
      totalCacheRead,
      totalSessions,
      overdriveSessions,
      overdrivePct,
      savedTokens: totalCacheRead,
      savedUsd,
      recommendation,
    } satisfies SavingsSummary
  })

  // Compaction (tool-output) savings - estimated tokens/$ kept out of context by the hook.
  // Ingest-on-read: catch the telemetry log up to date, then aggregate. Polled while the tab is open.
  app.get('/usage/compaction-savings', async (request) => {
    const { days } = request.query as Record<string, string>
    const { since } = sinceMs(days, 7)
    ingestCompactionLog()
    return getCompactionSavingsSummary(since)
  })

  // Last-hour cache multiplier (lightweight, polled frequently)
  app.get('/usage/multiplier', async () => {
    const since = Date.now() - 3_600_000 // 1 hour
    // Grouped by model: the cache-read rate is model-specific (0.1x input on most
    // models, 0.025x on Fable 5.1), so a flat 0.1x under-reports the multiplier for
    // any hour with Fable 5.1 traffic in it.
    const rows = db.prepare(`
      WITH ${UNIFIED_CTE}
      SELECT
        model,
        COALESCE(SUM(input_tokens), 0) AS total_input,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation
      FROM unified
      WHERE created_at >= ?
      GROUP BY model
    `).all(since) as Array<{ model: string | null; total_input: number; cache_read: number; cache_creation: number }>
    let totalInput = 0
    let cacheRead = 0
    // actualCost is in cold-input-token equivalents, so the ratios are per-model
    // prices divided by that model's own input price.
    let actualCost = 0
    // Last hour only, so every row was written at the TTL the setting gives today.
    const ttl = promptCacheTtl()
    for (const r of rows) {
      const ti = Number(r.total_input) || 0
      const cr = Number(r.cache_read) || 0
      const cc = Number(r.cache_creation) || 0
      const p = resolvePricing(r.model)
      const readRatio = p ? p.cacheRead / p.input : 0.1
      // Rate read off the row rather than through a new shared export: the server loads
      // shared/dist, and a checkout pulled without rebuilding it must not fail at import.
      // A stale dist has no cacheWrite1h, so the ?? falls back to the 5-minute rate.
      const writeRate = p ? (ttl === '1h' ? p.cacheWrite1h ?? p.cacheWrite5m : p.cacheWrite5m) : 0
      const writeRatio = p ? writeRate / p.input : (ttl === '1h' ? 2 : 1.25)
      totalInput += ti
      cacheRead += cr
      actualCost += Math.max(0, ti - cr - cc) + cc * writeRatio + cr * readRatio
    }
    if (totalInput === 0) return { multiplier: 1, cacheRatio: 0, totalInput: 0, cacheRead: 0 }
    const cacheRatio = cacheRead / totalInput
    const multiplier = actualCost > 0 ? Math.min(+(totalInput / actualCost).toFixed(1), 10) : 1
    return { multiplier, cacheRatio: +(cacheRatio * 100).toFixed(1), totalInput, cacheRead }
  })

  // Usage log with task and project names (one row per session)
  // Longest single turn per chat, all time. Reads turn_costs directly rather than the
  // denormalized instances.max_turn_ms so the ranking is correct even for chats that
  // predate that column, and so it cannot drift from the source of truth.
  //
  // Deliberately NOT filtered by `days`: a record that changes when you move the day
  // selector is not a record.
  //
  // kind = 'turn' matters. 171 /compact rows carry a duration and would otherwise
  // compete for the record with time spent compacting rather than working.
  //
  // This used to INNER JOIN `instances`, which dropped every turn whose chat had since
  // been closed - the all-time record vanished the moment its chat did. That was the
  // trade for a table where every row named a chat you could still open. The tombstone
  // removes the trade: a closed chat keeps its name, so it stays in the ranking and is
  // flagged is_closed for the UI to render as unopenable rather than hide.
  app.get('/usage/longest-turns', async (request) => {
    const { limit = '10' } = request.query as Record<string, string>
    const rows = db.prepare(`
      SELECT
        tc.instance_id                              AS instance_id,
        i.name                                      AS instance_name,
        MAX(i.is_closed)                            AS is_closed,
        MAX(i.name_source)                          AS name_source,
        COALESCE(f.display_name, f.name)            AS project_name,
        MAX(tc.duration_ms)                         AS max_ms,
        COUNT(*)                                    AS turns,
        MAX(tc.created_at)                          AS last_turn_at
      FROM turn_costs tc
      JOIN ${INSTANCE_SOURCE} i ON i.id = tc.instance_id
      LEFT JOIN folders f ON f.id = tc.folder_id
      WHERE tc.kind = 'turn' AND tc.duration_ms > 0
      GROUP BY tc.instance_id
      ORDER BY max_ms DESC
      LIMIT ?
    `).all(
      // Clamp low as well as high: SQLite treats a negative LIMIT as unlimited, so a bare
      // Math.min(..., 50) would let ?limit=-1 return every row.
      Math.max(1, Math.min(parseInt(limit) || 10, 50))
    ) as Array<Record<string, unknown>>
    return rows
  })

  app.get('/usage/log', async (request) => {
    ingestCompactionLog() // catch the telemetry log up so per-session compaction is current
    const { limit = '100', days } = request.query as Record<string, string>
    const params: unknown[] = []
    let whereClause = ''
    if (days) {
      const { since } = sinceMs(days, 7)
      whereClause = 'WHERE created_at >= ?'
      params.push(since)
    }
    params.push(Math.min(parseInt(limit) || 100, 500))
    const rows = db.prepare(`
      WITH ${UNIFIED_CTE}, grouped AS (
        SELECT
          ${SESSION_KEY} AS skey,
          MAX(session_id) AS session_id,
          MAX(instance_id) AS instance_id,
          MIN(role) AS role,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cost_usd) AS cost_usd,
          MAX(created_at) AS created_at,
          MAX(task_id) AS task_id,
          MAX(folder_id) AS folder_id
        FROM unified
        ${whereClause}
        GROUP BY skey
      )
      SELECT
        g.session_id, g.instance_id, g.role, g.input_tokens, g.output_tokens, g.cost_usd, g.created_at,
        pt.title AS task_title,
        COALESCE(f.display_name, f.name) AS project_name,
        i.name AS instance_name,
        COALESCE(i.is_closed, 0) AS is_closed,
        COALESCE(i.name_source, 'live') AS name_source
      FROM grouped g
      LEFT JOIN pipeline_tasks pt ON g.task_id = pt.id
      LEFT JOIN ${INSTANCE_SOURCE} i ON g.instance_id = i.id
      LEFT JOIN folders f ON g.folder_id = f.id
      ORDER BY g.created_at DESC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>

    // Per-session compaction savings: tokens kept out of context + their $ value, priced per
    // each row's model input rate (same basis as the savings card). Computed in JS so the dollar
    // figure uses the shared pricing table rather than rates hardcoded into SQL.
    const compRows = db.prepare(`
      SELECT session_id, model, COALESCE(SUM(saved_tokens), 0) AS saved_tokens, COUNT(*) AS compactions
      FROM compaction_savings WHERE session_id IS NOT NULL GROUP BY session_id, model
    `).all() as Array<{ session_id: string; model: string | null; saved_tokens: number; compactions: number }>
    const compBySession = new Map<string, { tokens: number; usd: number; compactions: number }>()
    for (const cr of compRows) {
      const price = resolvePricing(cr.model) ?? MODEL_PRICING['opus-4-7']
      const cur = compBySession.get(cr.session_id) ?? { tokens: 0, usd: 0, compactions: 0 }
      cur.tokens += Number(cr.saved_tokens) || 0
      cur.usd += ((Number(cr.saved_tokens) || 0) * price.input) / 1_000_000
      cur.compactions += Number(cr.compactions) || 0
      compBySession.set(cr.session_id, cur)
    }
    return rows.map((r) => {
      const c = compBySession.get(r.session_id as string)
      return {
        ...r,
        compaction_saved_tokens: c?.tokens ?? 0,
        compaction_saved_usd: c ? +c.usd.toFixed(4) : 0,
        compactions: c?.compactions ?? 0,
      }
    })
  })

  // Usage log grouped by project
  app.get('/usage/log/by-project', async (request) => {
    const { days } = request.query as Record<string, string>
    const params: unknown[] = []
    let whereClause = ''
    if (days) {
      const { since } = sinceMs(days, 7)
      whereClause = 'WHERE u.created_at >= ?'
      params.push(since)
    }
    const rows = db.prepare(`
      WITH ${UNIFIED_CTE}
      SELECT
        COALESCE(f.display_name, f.name, 'Unknown') AS project_name,
        SUM(u.cost_usd) AS total_cost_usd,
        COUNT(DISTINCT COALESCE(u.session_id, u.instance_id || '-' || u.created_at)) AS session_count
      FROM unified u
      LEFT JOIN folders f ON u.folder_id = f.id
      ${whereClause}
      GROUP BY COALESCE(f.display_name, f.name, 'Unknown')
      ORDER BY total_cost_usd DESC
    `).all(...params)
    return rows
  })

  // Usage stats: summary + by role + by weekday + by day
  app.get('/usage/stats', async (request) => {
    const { days } = request.query as Record<string, string>
    const { since } = sinceMs(days, 7)

    const summaryRow = db.prepare(`
      WITH ${UNIFIED_CTE}
      SELECT
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
        COUNT(DISTINCT ${SESSION_KEY}) AS total_sessions,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        CASE WHEN SUM(input_tokens) > 0
          THEN CAST(SUM(cache_read_tokens) AS REAL) / SUM(input_tokens)
          ELSE 0 END AS cache_hit_ratio
      FROM unified
      WHERE created_at >= ?
    `).get(since) as Record<string, number>

    const byRole = db.prepare(`
      WITH ${UNIFIED_CTE}
      SELECT
        role,
        COUNT(DISTINCT ${SESSION_KEY}) AS session_count,
        SUM(cost_usd) AS total_cost_usd,
        CASE WHEN COUNT(DISTINCT ${SESSION_KEY}) > 0
          THEN SUM(cost_usd) / COUNT(DISTINCT ${SESSION_KEY})
          ELSE 0 END AS avg_cost_usd,
        CASE WHEN SUM(input_tokens) > 0
          THEN CAST(SUM(cache_read_tokens) AS REAL) / SUM(input_tokens)
          ELSE 0 END AS cache_hit_ratio
      FROM unified
      WHERE created_at >= ?
      GROUP BY role
      ORDER BY total_cost_usd DESC
    `).all(since) as Array<Record<string, unknown>>

    const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const byWeekday = db.prepare(`
      WITH ${UNIFIED_CTE}
      SELECT
        CAST(strftime('%w', created_at / 1000, 'unixepoch') AS INTEGER) AS weekday,
        COUNT(DISTINCT ${SESSION_KEY}) AS session_count,
        SUM(cost_usd) AS total_cost_usd
      FROM unified
      WHERE created_at >= ?
      GROUP BY weekday
      ORDER BY weekday
    `).all(since) as Array<Record<string, number>>

    const byDay = db.prepare(`
      WITH ${UNIFIED_CTE}
      SELECT
        date(created_at / 1000, 'unixepoch') AS day,
        COUNT(DISTINCT ${SESSION_KEY}) AS session_count,
        SUM(cost_usd) AS total_cost_usd
      FROM unified
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(since) as Array<Record<string, unknown>>

    const totalCost = Number(summaryRow.total_cost_usd) || 0
    const totalSessions = Number(summaryRow.total_sessions) || 0

    return {
      summary: {
        total_cost_usd: totalCost,
        total_sessions: totalSessions,
        avg_cost_per_session: totalSessions > 0 ? totalCost / totalSessions : 0,
        cache_hit_ratio: Number(summaryRow.cache_hit_ratio) || 0,
        total_input_tokens: Number(summaryRow.total_input_tokens) || 0,
        total_output_tokens: Number(summaryRow.total_output_tokens) || 0,
      },
      byRole: byRole.map(r => ({
        role: r.role as string,
        session_count: Number(r.session_count) || 0,
        total_cost_usd: Number(r.total_cost_usd) || 0,
        avg_cost_usd: Number(r.avg_cost_usd) || 0,
        cache_hit_ratio: Number(r.cache_hit_ratio) || 0,
      })),
      byWeekday: byWeekday.map(r => ({
        weekday: Number(r.weekday),
        label: WEEKDAY_LABELS[Number(r.weekday)] || '?',
        session_count: Number(r.session_count) || 0,
        total_cost_usd: Number(r.total_cost_usd) || 0,
      })),
      byDay: byDay.map(r => ({
        day: r.day as string,
        session_count: Number(r.session_count) || 0,
        total_cost_usd: Number(r.total_cost_usd) || 0,
      })),
    }
  })

  // Per-model breakdown (cost + tokens by model, with backfill contribution)
  app.get('/usage/by-model', async (request) => {
    const { days } = request.query as Record<string, string>
    const { since } = sinceMs(days, 14)

    const rows = db.prepare(`
      WITH ${UNIFIED_CTE}
      SELECT
        COALESCE(model, 'unknown') AS model,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(CASE WHEN kind = 'backfill' THEN cost_usd ELSE 0 END), 0) AS backfilled_cost_usd,
        COUNT(DISTINCT ${SESSION_KEY}) AS session_count
      FROM unified
      WHERE created_at >= ?
      GROUP BY COALESCE(model, 'unknown')
      ORDER BY total_cost_usd DESC
    `).all(since) as Array<Record<string, unknown>>

    return rows.map(r => ({
      model: r.model as string,
      totalCostUsd: Number(r.total_cost_usd) || 0,
      inputTokens: Number(r.input_tokens) || 0,
      outputTokens: Number(r.output_tokens) || 0,
      cacheReadTokens: Number(r.cache_read_tokens) || 0,
      cacheCreationTokens: Number(r.cache_creation_tokens) || 0,
      backfilledCostUsd: Number(r.backfilled_cost_usd) || 0,
      sessionCount: Number(r.session_count) || 0,
    }))
  })

  // === PLAN-LIMITS (Claude OAuth usage API) - display only, no enforcement ===

  // Last known plan usage (+connected flag)
  app.get('/plan-usage', async () => {
    return getCurrentUsage()
  })

  // Start OAuth PKCE flow: returns the authorize URL, stores the verifier
  app.get('/plan-usage/connect', async () => {
    return generateAuthUrl()
  })

  // Exchange the pasted callback code ("code" or "code#state") for tokens
  app.post('/plan-usage/code', async (request, reply) => {
    const { code } = (request.body ?? {}) as { code?: string }
    if (!code || !code.trim()) {
      return reply.code(400).send({ error: 'Missing authorization code' })
    }
    try {
      return await exchangeCode(code)
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message || 'Token exchange failed' })
    }
  })

  // Force a poll now (user-initiated - bypasses the burst throttle)
  app.post('/plan-usage/refresh', async () => {
    return fetchUsage(true)
  })

  // Disconnect and clear tokens
  app.post('/plan-usage/disconnect', async () => {
    return disconnect()
  })

  // Sync untracked direct CLI sessions into token_usage
  app.post('/usage/sync-untracked', async () => {
    return scanUntrackedSessions()
  })

  // Backfill turn_costs from local ~/.claude/projects JSONL session files.
  // Idempotent (delta approach) - see services/backfill.ts for the design notes.
  app.post('/usage/backfill', async () => {
    return runBackfill()
  })

  // === PER-TURN COST TRACKING ENDPOINTS ===

  // Per-folder cost aggregation (hierarchical project costs)
  app.get('/usage/by-folder', async (request) => {
    const { days } = request.query as Record<string, string>
    const { since } = sinceMs(days, 14)

    const rows = db.prepare(`
      SELECT
        ${TC_FOLDER} AS folder_id,
        COALESCE(f.display_name, f.name) AS folder_name,
        f.path AS folder_path,
        f.emoji,
        COALESCE(SUM(${EFFECTIVE_TC_COST}), 0) AS total_cost_usd,
        COALESCE(SUM(tc.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(tc.output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(tc.cache_read_tokens), 0) AS total_cache_read,
        COALESCE(SUM(tc.cache_creation_tokens), 0) AS total_cache_creation,
        COALESCE(SUM(CASE WHEN tc.kind = 'backfill' THEN ${EFFECTIVE_TC_COST} ELSE 0 END), 0) AS backfilled_cost_usd,
        COUNT(*) AS turn_count,
        COUNT(DISTINCT tc.session_id) AS session_count
      FROM turn_costs tc
      LEFT JOIN ${INSTANCE_SOURCE} i ON tc.instance_id = i.id
      LEFT JOIN folders f ON f.id = ${TC_FOLDER}
      WHERE tc.created_at >= ?
      GROUP BY ${TC_FOLDER}
      ORDER BY total_cost_usd DESC
    `).all(since) as Array<Record<string, unknown>>

    return rows.map(r => {
      const totalInput = Number(r.total_input_tokens) || 0
      const cacheRead = Number(r.total_cache_read) || 0
      return {
        folderId: r.folder_id as string,
        folderName: (r.folder_name || 'Unknown') as string,
        folderPath: (r.folder_path || '') as string,
        emoji: (r.emoji || null) as string | null,
        totalCostUsd: Number(r.total_cost_usd) || 0,
        totalInputTokens: totalInput,
        totalOutputTokens: Number(r.total_output_tokens) || 0,
        totalCacheRead: cacheRead,
        totalCacheCreation: Number(r.total_cache_creation) || 0,
        backfilledCostUsd: Number(r.backfilled_cost_usd) || 0,
        turnCount: Number(r.turn_count) || 0,
        sessionCount: Number(r.session_count) || 0,
        cacheHitRatio: totalInput > 0 ? +((cacheRead / totalInput) * 100).toFixed(1) : 0,
      }
    })
  })

  // Session cost summary for live display hydration
  app.get('/usage/session-summary/:instanceId', async (request) => {
    const { instanceId } = request.params as { instanceId: string }

    // Get the current session_id for this instance
    const inst = db.prepare('SELECT session_id FROM instances WHERE id = ?').get(instanceId) as { session_id: string | null } | undefined
    if (!inst?.session_id) {
      return { totalCost: 0, totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheCreation: 0, turns: 0 }
    }

    const row = db.prepare(`
      SELECT
        COALESCE(SUM(${EFFECTIVE_TC_COST}), 0) AS total_cost,
        COALESCE(SUM(tc.input_tokens), 0) AS total_input,
        COALESCE(SUM(tc.output_tokens), 0) AS total_output,
        COALESCE(SUM(tc.cache_read_tokens), 0) AS total_cache_read,
        COALESCE(SUM(tc.cache_creation_tokens), 0) AS total_cache_creation,
        COUNT(*) AS turns
      FROM turn_costs tc
      WHERE tc.instance_id = ? AND tc.session_id = ?
    `).get(instanceId, inst.session_id) as Record<string, number>

    // Cache rate for the last 10 turns
    const recent = db.prepare(`
      SELECT COALESCE(SUM(input_tokens), 0) AS inp, COALESCE(SUM(cache_read_tokens), 0) AS cr
      FROM (SELECT input_tokens, cache_read_tokens FROM turn_costs
            WHERE instance_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 10)
    `).get(instanceId, inst.session_id) as { inp: number; cr: number }
    const recentCacheRate = recent.inp > 0 ? recent.cr / recent.inp : 0

    // Timestamp of most recent turn that wrote new cache entries (for TTL countdown)
    const cacheRow = db.prepare(`
      SELECT MAX(created_at) AS last_cache_created_at
      FROM turn_costs
      WHERE instance_id = ? AND session_id = ? AND cache_creation_tokens > 0
    `).get(instanceId, inst.session_id) as { last_cache_created_at: number | null }

    return {
      totalCost: Number(row.total_cost) || 0,
      totalInput: Number(row.total_input) || 0,
      totalOutput: Number(row.total_output) || 0,
      totalCacheRead: Number(row.total_cache_read) || 0,
      totalCacheCreation: Number(row.total_cache_creation) || 0,
      turns: Number(row.turns) || 0,
      recentCacheRate,
      lastCacheCreatedAt: cacheRow.last_cache_created_at ?? undefined,
    }
  })
}
