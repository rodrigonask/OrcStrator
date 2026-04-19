import type { FastifyInstance } from 'fastify'
import { getCurrentUsage, generateAuthUrl, exchangeCode, disconnect, fetchUsage } from '../services/usage-monitor.js'
import { scanUntrackedSessions } from '../services/session-scanner.js'
import { db } from '../db.js'
import type { DailySavingsEntry, SavingsSummary, UsageTrendDay, UsageByColumn, UsageForecast, UsageAnomaly, UsageEfficiencyDay } from '@orcstrator/shared'

export default async function usageRoutes(app: FastifyInstance): Promise<void> {

  // === ANALYTICS ENDPOINTS ===

  // Daily trend with token type breakdown
  app.get('/usage/trend', async (request) => {
    const { days = '7' } = request.query as Record<string, string>
    const n = Math.min(Math.max(parseInt(days) || 7, 1), 90)
    const since = Date.now() - n * 86_400_000

    const rows = db.prepare(`
      SELECT
        date(created_at / 1000, 'unixepoch') AS day,
        COALESCE(SUM(input_tokens) - SUM(COALESCE(cache_read_tokens, 0)) - SUM(COALESCE(cache_creation_tokens, 0)), 0) AS cold_input,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COUNT(*) AS sessions
      FROM token_usage
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
    const { days = '7' } = request.query as Record<string, string>
    const n = Math.min(Math.max(parseInt(days) || 7, 1), 90)
    const since = Date.now() - n * 86_400_000

    const rows = db.prepare(`
      SELECT
        COALESCE(pt."column", 'other') AS col,
        COALESCE(SUM(tu.cost_usd), 0) AS cost_usd,
        COUNT(*) AS sessions
      FROM token_usage tu
      LEFT JOIN pipeline_tasks pt ON tu.task_id = pt.id
      WHERE tu.created_at >= ?
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
    const { days = '14' } = request.query as Record<string, string>
    const n = Math.min(Math.max(parseInt(days) || 14, 3), 90)
    const since = Date.now() - n * 86_400_000

    const rows = db.prepare(`
      SELECT
        date(created_at / 1000, 'unixepoch') AS day,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM token_usage
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
    const { days = '7' } = request.query as Record<string, string>
    const n = Math.min(Math.max(parseInt(days) || 7, 1), 90)
    const since = Date.now() - n * 86_400_000

    const rows = db.prepare(`
      SELECT
        tu.session_id,
        tu.role,
        tu.cost_usd,
        tu.created_at,
        pt.title AS task_title
      FROM token_usage tu
      LEFT JOIN pipeline_tasks pt ON tu.task_id = pt.id
      WHERE tu.created_at >= ? AND tu.cost_usd > 0
      ORDER BY tu.cost_usd DESC
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
    const { days = '7' } = request.query as Record<string, string>
    const n = Math.min(Math.max(parseInt(days) || 7, 1), 90)
    const since = Date.now() - n * 86_400_000

    const rows = db.prepare(`
      SELECT
        date(created_at / 1000, 'unixepoch') AS day,
        CASE WHEN SUM(input_tokens) > 0
          THEN CAST(SUM(output_tokens) AS REAL) / SUM(input_tokens)
          ELSE 0 END AS yield_ratio,
        CASE WHEN COUNT(*) > 0
          THEN SUM(prompt_chars) / COUNT(*)
          ELSE 0 END AS avg_prompt_chars,
        CASE WHEN SUM(input_tokens) > 0
          THEN CAST(SUM(COALESCE(cache_read_tokens, 0)) AS REAL) / SUM(input_tokens)
          ELSE 0 END AS cache_hit_ratio
      FROM token_usage
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

  // Token usage history (from pipeline monitoring)
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
    const { days = '7' } = request.query as Record<string, string>
    const n = Math.min(Math.max(parseInt(days) || 7, 1), 90)
    const since = Date.now() - n * 86_400_000

    const rows = db.prepare(`
      SELECT
        date(created_at / 1000, 'unixepoch') AS day,
        SUM(input_tokens) AS total_input,
        SUM(cache_read_tokens) AS cache_read,
        SUM(cache_creation_tokens) AS cache_creation,
        SUM(output_tokens) AS total_output,
        SUM(cost_usd) AS total_cost,
        COUNT(*) AS sessions,
        SUM(is_overdrive_session) AS overdrive_sessions
      FROM token_usage
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
    const savedUsd = +(totalCacheRead * 2.70 / 1_000_000).toFixed(4)

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

  // Last-hour cache multiplier (lightweight, polled frequently)
  app.get('/usage/multiplier', async () => {
    const since = Date.now() - 3_600_000 // 1 hour
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS total_input,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation
      FROM token_usage
      WHERE created_at >= ?
    `).get(since) as { total_input: number; cache_read: number; cache_creation: number }
    const totalInput = Number(row.total_input) || 0
    const cacheRead = Number(row.cache_read) || 0
    const cacheCreation = Number(row.cache_creation) || 0
    if (totalInput === 0) return { multiplier: 1, cacheRatio: 0, totalInput: 0, cacheRead: 0 }
    const coldInput = Math.max(0, totalInput - cacheRead - cacheCreation)
    const actualCost = coldInput + cacheCreation * 1.25 + cacheRead * 0.1
    const cacheRatio = cacheRead / totalInput
    const multiplier = actualCost > 0 ? Math.min(+(totalInput / actualCost).toFixed(1), 10) : 1
    return { multiplier, cacheRatio: +(cacheRatio * 100).toFixed(1), totalInput, cacheRead }
  })

  // Usage log with task and project names
  app.get('/usage/log', async (request) => {
    const { limit = '100', days } = request.query as Record<string, string>
    const params: unknown[] = []
    let whereClause = ''
    if (days) {
      const n = Math.min(Math.max(parseInt(days) || 7, 1), 90)
      whereClause = 'WHERE tu.created_at >= ?'
      params.push(Date.now() - n * 86_400_000)
    }
    params.push(Math.min(parseInt(limit) || 100, 500))
    const rows = db.prepare(`
      SELECT
        tu.session_id,
        tu.instance_id,
        tu.role,
        tu.input_tokens,
        tu.output_tokens,
        tu.cost_usd,
        tu.created_at,
        pt.title AS task_title,
        COALESCE(f.display_name, f.name) AS project_name,
        i.name AS instance_name
      FROM token_usage tu
      LEFT JOIN pipeline_tasks pt ON tu.task_id = pt.id
      LEFT JOIN instances i ON tu.instance_id = i.id
      LEFT JOIN folders f ON i.folder_id = f.id
      ${whereClause}
      ORDER BY tu.created_at DESC
      LIMIT ?
    `).all(...params)
    return rows
  })

  // Usage log grouped by project
  app.get('/usage/log/by-project', async (request) => {
    const { days } = request.query as Record<string, string>
    const params: unknown[] = []
    let whereClause = ''
    if (days) {
      const n = Math.min(Math.max(parseInt(days) || 7, 1), 90)
      whereClause = 'WHERE tu.created_at >= ?'
      params.push(Date.now() - n * 86_400_000)
    }
    const rows = db.prepare(`
      SELECT
        COALESCE(f.display_name, f.name, 'Unknown') AS project_name,
        SUM(tu.cost_usd) AS total_cost_usd,
        COUNT(*) AS session_count
      FROM token_usage tu
      LEFT JOIN instances i ON tu.instance_id = i.id
      LEFT JOIN folders f ON i.folder_id = f.id
      ${whereClause}
      GROUP BY COALESCE(f.display_name, f.name, 'Unknown')
      ORDER BY total_cost_usd DESC
    `).all(...params)
    return rows
  })

  // Usage stats: summary + by role + by weekday + by day
  app.get('/usage/stats', async (request) => {
    const { days = '7' } = request.query as Record<string, string>
    const n = Math.min(Math.max(parseInt(days) || 7, 1), 90)
    const since = Date.now() - n * 86_400_000

    const summaryRow = db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
        COUNT(*) AS total_sessions,
        CASE WHEN COUNT(*) > 0 THEN SUM(cost_usd) / COUNT(*) ELSE 0 END AS avg_cost_per_session,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        CASE WHEN SUM(input_tokens) > 0
          THEN CAST(SUM(cache_read_tokens) AS REAL) / SUM(input_tokens)
          ELSE 0 END AS cache_hit_ratio
      FROM token_usage
      WHERE created_at >= ?
    `).get(since) as Record<string, number>

    const byRole = db.prepare(`
      SELECT
        role,
        COUNT(*) AS session_count,
        SUM(cost_usd) AS total_cost_usd,
        CASE WHEN COUNT(*) > 0 THEN SUM(cost_usd) / COUNT(*) ELSE 0 END AS avg_cost_usd,
        CASE WHEN SUM(input_tokens) > 0
          THEN CAST(SUM(cache_read_tokens) AS REAL) / SUM(input_tokens)
          ELSE 0 END AS cache_hit_ratio
      FROM token_usage
      WHERE created_at >= ?
      GROUP BY role
      ORDER BY total_cost_usd DESC
    `).all(since) as Array<Record<string, unknown>>

    const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const byWeekday = db.prepare(`
      SELECT
        CAST(strftime('%w', created_at / 1000, 'unixepoch') AS INTEGER) AS weekday,
        COUNT(*) AS session_count,
        SUM(cost_usd) AS total_cost_usd
      FROM token_usage
      WHERE created_at >= ?
      GROUP BY weekday
      ORDER BY weekday
    `).all(since) as Array<Record<string, number>>

    const byDay = db.prepare(`
      SELECT
        date(created_at / 1000, 'unixepoch') AS day,
        COUNT(*) AS session_count,
        SUM(cost_usd) AS total_cost_usd
      FROM token_usage
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(since) as Array<Record<string, unknown>>

    return {
      summary: {
        total_cost_usd: Number(summaryRow.total_cost_usd) || 0,
        total_sessions: Number(summaryRow.total_sessions) || 0,
        avg_cost_per_session: Number(summaryRow.avg_cost_per_session) || 0,
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

  // Get current usage data
  app.get('/usage', async () => {
    return getCurrentUsage()
  })

  // Generate OAuth PKCE auth URL
  app.get('/usage/auth-url', async () => {
    return generateAuthUrl()
  })

  // Exchange authorization code for tokens
  app.post('/usage/exchange', async (request) => {
    const { code } = request.body as { code: string }
    if (!code) throw { statusCode: 400, message: 'Missing authorization code' }
    await exchangeCode(code)
    return { ok: true }
  })

  // Disconnect and clear tokens
  app.post('/usage/disconnect', async () => {
    disconnect()
    return { ok: true }
  })

  // Sync untracked direct CLI sessions into token_usage
  app.post('/usage/sync-untracked', async () => {
    return scanUntrackedSessions()
  })

  // Force refresh usage data
  app.post('/usage/refresh', async () => {
    return fetchUsage()
  })

  // === PER-TURN COST TRACKING ENDPOINTS ===

  // Per-folder cost aggregation (hierarchical project costs)
  app.get('/usage/by-folder', async (request) => {
    const { days = '14' } = request.query as Record<string, string>
    const n = Math.min(Math.max(parseInt(days) || 14, 1), 90)
    const since = Date.now() - n * 86_400_000

    const rows = db.prepare(`
      SELECT
        tc.folder_id,
        COALESCE(f.display_name, f.name) AS folder_name,
        f.path AS folder_path,
        f.emoji,
        COALESCE(SUM(tc.cost_usd), 0) AS total_cost_usd,
        COALESCE(SUM(tc.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(tc.output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(tc.cache_read_tokens), 0) AS total_cache_read,
        COALESCE(SUM(tc.cache_creation_tokens), 0) AS total_cache_creation,
        COUNT(*) AS turn_count,
        COUNT(DISTINCT tc.session_id) AS session_count
      FROM turn_costs tc
      LEFT JOIN folders f ON tc.folder_id = f.id
      WHERE tc.created_at >= ?
      GROUP BY tc.folder_id
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
        COALESCE(SUM(cost_usd), 0) AS total_cost,
        COALESCE(SUM(input_tokens), 0) AS total_input,
        COALESCE(SUM(output_tokens), 0) AS total_output,
        COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
        COUNT(*) AS turns
      FROM turn_costs
      WHERE instance_id = ? AND session_id = ?
    `).get(instanceId, inst.session_id) as Record<string, number>

    // Cache rate for the last 10 turns
    const recent = db.prepare(`
      SELECT COALESCE(SUM(input_tokens), 0) AS inp, COALESCE(SUM(cache_read_tokens), 0) AS cr
      FROM (SELECT input_tokens, cache_read_tokens FROM turn_costs
            WHERE instance_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 10)
    `).get(instanceId, inst.session_id) as { inp: number; cr: number }
    const recentCacheRate = recent.inp > 0 ? recent.cr / recent.inp : 0

    return {
      totalCost: Number(row.total_cost) || 0,
      totalInput: Number(row.total_input) || 0,
      totalOutput: Number(row.total_output) || 0,
      totalCacheRead: Number(row.total_cache_read) || 0,
      totalCacheCreation: Number(row.total_cache_creation) || 0,
      turns: Number(row.turns) || 0,
      recentCacheRate,
    }
  })
}
