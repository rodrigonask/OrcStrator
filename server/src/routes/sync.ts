import type { FastifyInstance } from 'fastify'
import { cloudSync } from '../services/cloud-sync.js'

export default async function syncRoutes(app: FastifyInstance): Promise<void> {
  // Test connection with provided credentials
  app.post('/sync/test', async (request) => {
    const { url, key } = request.body as { url: string; key: string }
    if (!url || !key) return { ok: false, error: 'URL and key are required' }
    return cloudSync.testConnection(url, key)
  })

  // Get current sync status
  app.get('/sync/status', async () => {
    return {
      status: cloudSync.status,
      error: cloudSync.error,
      machineId: cloudSync.machineId,
      folders: cloudSync.getSyncStatus(),
    }
  })

  // Trigger sync for a specific folder
  app.post('/sync/trigger/:folderId', async (request) => {
    const { folderId } = request.params as { folderId: string }
    try {
      await cloudSync.initialSync(folderId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Sync failed' }
    }
  })
}
