import type { FastifyInstance } from 'fastify'

// A malformed request used to come back as a raw 500 carrying SQLite and path
// details ("NOT NULL constraint failed: instances.folder_id"). A 4xx keeps its message, since
// it tells the caller what to fix. A 5xx says only that something failed; the details go to
// the server log, where they belong.

export const SERVER_ERROR_MESSAGE = 'Something went wrong on the server. The details are in the server log.'

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    const e = (error ?? {}) as { statusCode?: unknown; message?: unknown; code?: unknown }
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500
    if (status >= 500) {
      console.error(`[server] ${request.method} ${request.url.split('?')[0]} failed:`, error)
      return reply.code(status).send({ error: SERVER_ERROR_MESSAGE })
    }
    const message = typeof e.message === 'string' && e.message ? e.message : 'Bad request'
    return reply.code(status).send({ error: message })
  })
}
