import type { FastifyServerOptions } from 'fastify'
import { DEFAULT_BODY_LIMIT } from './services/limits.js'

/**
 * The server's Fastify options, in one place so a test builds the same server.
 *
 * Bodies are capped at 1 MB; the routes that carry pasted images opt in to 20 MB on their own.
 * Fastify's per-request lines ("incoming request" plus "request completed", two for every
 * poll) buried real errors and would print a token-bearing /ws URL, so they are off; the app
 * logs what matters itself.
 */
export function serverOptions(logStream?: NodeJS.WritableStream): FastifyServerOptions {
  const level = process.env.NODE_ENV === 'production' ? 'warn' : 'info'
  return {
    logger: logStream ? { level, stream: logStream } : { level },
    disableRequestLogging: true,
    bodyLimit: DEFAULT_BODY_LIMIT,
  }
}
