import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import type { AccountProfile } from '@orcstrator/shared'

export default async function profileRoutes(app: FastifyInstance): Promise<void> {
  // Get profile — live usage stats computed from real tables
  app.get('/profile', async (): Promise<AccountProfile> => {
    const msgCount = (db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE role = 'user'`).get() as { cnt: number }).cnt
    // turn_costs is where every turn's tokens are recorded (token_usage, read here
    // before, has been empty for months, so both totals always read 0).
    const tokenStats = db.prepare(`SELECT COALESCE(SUM(input_tokens), 0) AS tin, COALESCE(SUM(output_tokens), 0) AS tout FROM turn_costs`).get() as { tin: number; tout: number }
    const tasksDone = (db.prepare(`SELECT COUNT(*) AS cnt FROM pipeline_tasks WHERE "column" = 'done'`).get() as { cnt: number }).cnt

    return { messagesSent: msgCount, tokensSent: tokenStats.tin, tokensReceived: tokenStats.tout, tasksDone }
  })
}
