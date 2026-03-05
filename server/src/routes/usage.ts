import type { FastifyInstance } from 'fastify'
import { getCurrentUsage, generateAuthUrl, exchangeCode, disconnect, fetchUsage } from '../services/usage-monitor.js'

export default async function usageRoutes(app: FastifyInstance): Promise<void> {
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
