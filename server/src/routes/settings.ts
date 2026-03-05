import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { startPolling } from '../services/usage-monitor.js'

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // Get all settings
  app.get('/settings', async () => {
    const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
    const settings: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value)
      } catch {
        settings[row.key] = row.value
      }
    }
    return settings
  })

  // Partial merge update settings
  app.put('/settings', async (request) => {
    const body = request.body as Record<string, unknown>
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')

    const transaction = db.transaction(() => {
      for (const [key, value] of Object.entries(body)) {
        upsert.run(key, JSON.stringify(value))
      }
    })
    transaction()

    // Read back all settings
    const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
    const settings: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value)
      } catch {
        settings[row.key] = row.value
      }
    }

    broadcastEvent({ type: 'settings:updated', payload: settings })

    // If poll interval changed, restart polling with the new interval
    if ('usagePollMinutes' in body && typeof body.usagePollMinutes === 'number') {
      startPolling(body.usagePollMinutes)
    }

    return settings
  })
}
