// Who is calling the local API.
//
// The Host/Origin guard in security.ts stops web pages. It cannot stop a program on this
// PC, which sends no Origin at all, and that includes the agents this app runs: they are
// routinely told to curl the API. So every request that CHANGES something needs a token:
//
//   admin   A random value made at every boot and kept in memory only. The app's own page
//           fetches it from POST /api/auth/session, a route that answers only a same-origin
//           browser request. It is never written to disk and never put in an agent's
//           environment.
//   agent   Every chat the app starts gets ORCSTRATOR_AGENT_TOKEN, a token derived from its
//           own chat id, so the server knows WHICH chat is calling. Scripts outside a chat
//           (and chats that were already running when the server restarted) use the script
//           token in <data dir>/agent-token, a user-only file. Both can do what agents
//           legitimately do today: create and update cards, comment on them, start them, and
//           read. Neither can touch settings, permission modes, projects, files or another
//           chat's input.
//
// Reads (GET) stay open to local callers: they grant nothing a program running as the
// user cannot already read from disk, and read-only tools depend on them. Cross-site
// browser reads are stopped separately (security.ts).
//
// Limit, stated on purpose: a program running as the same user can still pretend to be
// the browser, derive a token from the file, or edit the database directly. That class
// is out of scope by design. The token's job is to stop an agent
// (or a script) from reconfiguring the app through the front door, which is how agents
// actually use it.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { DATA_DIR, PORT } from '../config.js'

export const TOKEN_HEADER = 'x-orcstrator-token'
export const AGENT_TOKEN_FILE = path.join(DATA_DIR, 'agent-token')

const adminToken = crypto.randomBytes(32).toString('base64url')
let scriptToken: string | null = null

export function getAdminToken(): string {
  return adminToken
}

/** Restrict a file to the current user. POSIX: mode 600. Windows: drop inherited ACEs and
 *  grant only the current user. Best effort: the data dir already sits in the user's profile. */
function restrictToUser(file: string): void {
  try { fs.chmodSync(file, 0o600) } catch { /* not supported on this fs */ }
  if (process.platform !== 'win32') return
  const user = process.env.USERNAME
  if (!user) return
  try {
    spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
  } catch { /* icacls missing: leave the profile's own ACL */ }
}

/** The script token, created on first use and then stable across restarts. */
export function getScriptToken(): string {
  if (scriptToken) return scriptToken
  try {
    const existing = fs.readFileSync(AGENT_TOKEN_FILE, 'utf8').trim()
    if (/^[A-Za-z0-9_-]{32,}$/.test(existing)) {
      scriptToken = existing
      return scriptToken
    }
  } catch { /* first boot */ }
  const fresh = crypto.randomBytes(32).toString('base64url')
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(AGENT_TOKEN_FILE, fresh + '\n', { encoding: 'utf8', mode: 0o600 })
  restrictToUser(AGENT_TOKEN_FILE)
  scriptToken = fresh
  return scriptToken
}

function mac(instanceId: string): string {
  return crypto.createHmac('sha256', getScriptToken()).update(`instance:${instanceId}`).digest('base64url')
}

/** The token a chat's process gets in ORCSTRATOR_AGENT_TOKEN. */
export function agentTokenFor(instanceId: string): string {
  return `i.${instanceId}.${mac(instanceId)}`
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export type Caller =
  | { kind: 'admin' }
  | { kind: 'agent'; instanceId: string | null }
  | { kind: 'none' }

/** Read the token from the header (or `Authorization: Bearer`, or the WS query) and say who it is. */
export function identify(headers: Record<string, string | string[] | undefined>, queryToken?: string): Caller {
  let raw = headers[TOKEN_HEADER]
  if (Array.isArray(raw)) raw = raw[0]
  if (!raw) {
    const auth = headers['authorization']
    const value = Array.isArray(auth) ? auth[0] : auth
    if (value && /^Bearer\s+/i.test(value)) raw = value.replace(/^Bearer\s+/i, '')
  }
  if (!raw && queryToken) raw = queryToken
  if (!raw || typeof raw !== 'string') return { kind: 'none' }
  const token = raw.trim()
  if (sameSecret(token, adminToken)) return { kind: 'admin' }
  if (sameSecret(token, getScriptToken())) return { kind: 'agent', instanceId: null }
  const m = /^i\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]+)$/.exec(token)
  if (m && sameSecret(m[2], mac(m[1]))) return { kind: 'agent', instanceId: m[1] }
  return { kind: 'none' }
}

// What an agent token may change. Everything else that changes state is admin only.
// Paths are matched without the query string, under the /api prefix.
const SEG = '[^/]+'
const AGENT_WRITES: Array<{ method: string; re: RegExp }> = [
  { method: 'POST', re: new RegExp(`^/api/pipelines/${SEG}/tasks$`) },
  { method: 'PUT', re: new RegExp(`^/api/pipelines/${SEG}/tasks/${SEG}$`) },
  { method: 'POST', re: new RegExp(`^/api/pipelines/${SEG}/tasks/${SEG}/(move|block|unblock|comments|start|run-now)$`) },
]

export function agentMayWrite(method: string, urlPath: string): boolean {
  return AGENT_WRITES.some(r => r.method === method && r.re.test(urlPath))
}

/** Card fields an agent may not set: they decide what a card's run is allowed to do. */
export const AGENT_FORBIDDEN_CARD_FIELDS = ['permissionMode'] as const

export function authRequiredMessage(): string {
  return 'This OrcStrator API needs a token to change anything. Programs and agents: send the header ' +
    `X-OrcStrator-Token with the value of the ORCSTRATOR_AGENT_TOKEN environment variable, or the contents of ${AGENT_TOKEN_FILE}.`
}

export const AGENT_FORBIDDEN_MESSAGE =
  'Agents cannot change this. Ask the user to do it in the OrcStrator app.'

/** The variables every process the app starts for a chat gets, so its tools and skills can
 *  reach this server as that chat. Never the admin token. */
export function agentEnvFor(instanceId: string): Record<string, string> {
  return {
    ORCSTRATOR_INSTANCE_ID: instanceId,
    ORCSTRATOR_AGENT_TOKEN: agentTokenFor(instanceId),
    ORCSTRATOR_PORT: String(PORT),
    // The compaction hook writes under the data dir; it must be THIS server's, including an
    // installed copy whose data lives in %LOCALAPPDATA%.
    ORCSTRATOR_DATA_DIR: DATA_DIR,
  }
}
