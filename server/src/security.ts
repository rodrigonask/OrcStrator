// The request guard every route sits behind. One function, so the server and the route
// tests install exactly the same checks.
//
//   1. Host   defeats DNS rebinding (config.ts has the full reasoning).
//   2. Origin a browser always sends a truthful Origin on cross-origin writes and on the
//             WebSocket upgrade, so a foreign page is refused.
//   3. Fetch metadata: a cross-site <img> or <script> GET carries no Origin, so
//             it passed check 2. Browsers mark it `Sec-Fetch-Site: cross-site` (or
//             `same-site` from another localhost port), and that is refused unless the
//             Origin is one of ours. Program callers send no such header and are unaffected.
//   4. Token : anything that changes state needs the admin or an agent token,
//             and an agent token only reaches the card routes (services/api-auth.ts).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isAllowedHost, isAllowedOrigin, ALLOWED_ORIGINS } from './config.js'
import {
  identify, agentMayWrite, authRequiredMessage, AGENT_FORBIDDEN_MESSAGE, type Caller,
} from './services/api-auth.js'

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Paths a caller with no token may still POST to: the page's own token handshake. */
const OPEN_WRITES = new Set(['/api/auth/session'])

function pathOf(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

function queryParam(url: string, name: string): string | undefined {
  const q = url.indexOf('?')
  if (q === -1) return undefined
  return new URLSearchParams(url.slice(q + 1)).get(name) ?? undefined
}

function header(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/**
 * The path the ROUTER matched, which is what the guard must decide on. The raw URL is not:
 * find-my-way decodes it, so "/%61pi/settings" reached PUT /api/settings while the raw string
 * did not start with "/api/" and skipped the token check.
 * Fastify has matched the route before onRequest runs, so the route pattern is available; a
 * request that matched nothing falls back to the decoded path (it can only 404).
 */
export function guardPath(request: FastifyRequest): string {
  const route = request.routeOptions?.url
  if (typeof route === 'string' && route) return route
  const raw = pathOf(request.url)
  try { return decodeURIComponent(raw) } catch { return raw }
}

/** Who sent this request. Recomputed on demand (cheap), so no request decoration is needed. */
export function callerOf(request: FastifyRequest): Caller {
  return identify(request.headers, guardPath(request) === '/ws' ? queryParam(request.url, 'token') : undefined)
}

/** True for a browser request made from a page that is not ours. */
export function isForeignBrowserRequest(request: FastifyRequest): boolean {
  const site = header(request, 'sec-fetch-site')
  if (site !== 'cross-site' && site !== 'same-site') return false
  const origin = header(request, 'origin')
  return !(origin && ALLOWED_ORIGINS.includes(origin))
}

/** Swallows a reset on an upgrade socket; the request itself is answered or refused as usual. */
const ignoreSocketError = (): void => {}

export async function guardRequest(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  // An upgrade socket has no 'error' listener of its own (Node hands it over to the upgrade
  // handler), so a client that resets it after a refusal crashed the whole server with an
  // unhandled ECONNRESET.
  if (request.headers.upgrade) {
    const socket = request.raw.socket
    if (socket && !socket.listeners('error').includes(ignoreSocketError)) socket.on('error', ignoreSocketError)
  }
  if (!isAllowedHost(request.headers.host)) {
    console.warn(`[security] rejected request with Host: ${request.headers.host} (${request.method} ${pathOf(request.url)})`)
    return reply.code(403).send({ error: 'Forbidden: invalid Host header' })
  }
  if (!isAllowedOrigin(request.headers.origin)) {
    console.warn(`[security] rejected request from Origin: ${request.headers.origin} (${request.method} ${pathOf(request.url)})`)
    return reply.code(403).send({ error: 'Forbidden: origin not allowed' })
  }
  if (isForeignBrowserRequest(request)) {
    console.warn(`[security] rejected ${header(request, 'sec-fetch-site')} browser request (${request.method} ${pathOf(request.url)})`)
    return reply.code(403).send({ error: 'Forbidden: request from another site' })
  }

  const p = guardPath(request)
  if (p === '/ws') {
    // The live feed carries every chat's output, so only the app's own page may open it.
    if (callerOf(request).kind !== 'admin') {
      return reply.code(401).send({ error: 'auth-required', message: 'The live feed is for the OrcStrator app only.' })
    }
    return
  }
  if (!p.startsWith('/api/') || READ_METHODS.has(request.method) || OPEN_WRITES.has(p)) return

  const caller = callerOf(request)
  if (caller.kind === 'admin') return
  if (caller.kind === 'none') {
    return reply.code(401).send({ error: 'auth-required', message: authRequiredMessage() })
  }
  if (!agentMayWrite(request.method, p)) {
    console.warn(`[security] agent token refused for ${request.method} ${p}`)
    return reply.code(403).send({ error: 'agent-forbidden', message: AGENT_FORBIDDEN_MESSAGE })
  }
}

export function installSecurityHooks(app: FastifyInstance): void {
  app.addHook('onRequest', guardRequest)
}
