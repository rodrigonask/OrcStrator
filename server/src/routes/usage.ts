import type { FastifyInstance } from 'fastify'
import { getCurrentUsage, generateAuthUrl, exchangeCode, disconnect, fetchUsage } from '../services/usage-monitor.js'
import { db } from '../db.js'
import type { DailySavingsEntry, SavingsSummary } from '@nasklaude/shared'

export default async function usageRoutes(app: FastifyInstance): Promise<void> {
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

  // Force refresh usage data
  app.post('/usage/refresh', async () => {
    return fetchUsage()
  })
}
