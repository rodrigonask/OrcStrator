import type { FastifyInstance } from 'fastify'
import { ALLOWED_ORIGINS } from '../config.js'
import { getAdminToken } from '../services/api-auth.js'

// The app's own page asks for the admin token here. Only a same-origin browser
// request qualifies: a browser attaches Origin to every POST, and marks a request from our
// own page `Sec-Fetch-Site: same-origin`, so a foreign page is refused (its Origin is not
// ours) and a program that just posts here gets nothing. See services/api-auth.ts for the
// same-user limit this cannot close.
export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/session', async (request, reply) => {
    const origin = request.headers.origin
    const site = request.headers['sec-fetch-site']
    if (!origin || !ALLOWED_ORIGINS.includes(origin) || site !== 'same-origin') {
      reply.code(403)
      return { error: 'browser-only', message: 'Only the OrcStrator app itself can open a session.' }
    }
    reply.header('Cache-Control', 'no-store')
    return { token: getAdminToken() }
  })
}
