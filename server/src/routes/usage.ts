import type { FastifyInstance } from 'fastify'
import { getCurrentUsage, generateAuthUrl, exchangeCode, disconnect, fetchUsage } from '../services/usage-monitor.js'
import { db } from '../db.js'

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
