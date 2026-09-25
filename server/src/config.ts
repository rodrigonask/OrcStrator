import path from 'path'
import os from 'os'

// DATA_DIR is env-overridable so a throwaway/isolated server (tests, a second
// instance) can point at its own DB + dev-lock without colliding with the real one.
export const DATA_DIR = process.env.ORCSTRATOR_DATA_DIR || path.join(os.homedir(), '.orcstrator-v2')
export const DB_PATH = path.join(DATA_DIR, 'orcstrator.db')
export const DEFAULT_PORT = 3334

/** Text the cache advisor sends to hold a session's prompt cache warm. Lives here, with no
 *  imports, so both the sender (services/cache-advisor.ts) and the places that must NOT
 *  count it as real work (services/claude-process.ts turn-duration write) share one
 *  definition instead of matching a duplicated magic string. */
export const KEEPALIVE_TEXT = 'Keep-alive ping to hold the prompt cache warm. Reply with exactly: ok'
/** The port actually listened on — ALLOWED_HOSTS is derived from this, so a custom PORT still works. */
export const PORT = parseInt(process.env.PORT || String(DEFAULT_PORT), 10)
const DEFAULT_ALLOWED_ORIGINS = 'http://localhost:5174,http://localhost:5175,http://localhost:5176,http://localhost:3334'

// In production the client is served BY this server, so the app's own origin must
// always be allowed. The default list hardcodes 3334; without deriving these from
// PORT, running production mode on any other port makes the app 403 against itself
// on every request. Same reasoning as ALLOWED_HOSTS being hostname-based.
const SELF_ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]

export const ALLOWED_ORIGINS = Array.from(new Set([
  ...(process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS).split(',').map(o => o.trim()).filter(Boolean),
  ...SELF_ORIGINS
]))

// ── Local-only hardening ────────────────────────────────────────────────────────
// The server drives Claude agents with full filesystem access, so it must only ever
// be reachable from this machine's own UI. Three layers, none of which cost the user
// anything:
//
//   1. BIND_HOST — loopback only, so the server does not exist on the LAN/WiFi.
//   2. Origin allowlist — a browser ALWAYS attaches a truthful `Origin` header to
//      cross-site requests and WebSocket upgrades (a page cannot forge or drop it),
//      so a drive-by page on evil.com is rejected at the handshake. Note the app's
//      own ports (3334/5174) sit in the range malicious scripts routinely scan;
//      changing the port is not a defense — this check is.
//   3. Host allowlist — defeats DNS rebinding, where evil.com re-points its DNS at
//      127.0.0.1 so a page's *same-origin* requests land on this server. Such
//      requests carry `Host: evil.com`, which no legitimate local client ever sends.
//      The check is HOSTNAME-based (port ignored): a rebind attack always presents
//      the attacker's DOMAIN as the Host, never a loopback name — so allowing any
//      loopback host on any port is exactly as safe AND survives the dev setup,
//      where Vite proxies to the backend forwarding the browser's `localhost:5174`
//      Host (a port-pinned allowlist wrongly 403'd that, killing the WS/live UI).
//
// Deliberately NOT included: a bearer token. It would only guard against other
// processes already executing on this machine — and at that point the attacker can
// read the token file too. Layers 1–3 close every browser/network vector.
export const BIND_HOST = process.env.ORCSTRATOR_BIND_HOST || '127.0.0.1'

// Loopback hostnames a legitimate local client resolves to. DNS rebinding cannot
// forge these (it uses the attacker's own domain as Host), so port is irrelevant.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

// Optional exact host:port extras (e.g. a custom LAN hostname) via env override.
export const ALLOWED_HOSTS = (process.env.ORCSTRATOR_ALLOWED_HOSTS || '')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean)

/** Strip the port from a Host header, handling bare host, host:port, and [::1]:port. */
function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']')) // [::1]:3334 → ::1
  const colon = h.indexOf(':')
  return colon === -1 ? h : h.slice(0, colon)
}

/** True when `origin` is absent (same-origin/non-browser) or explicitly allowlisted. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  return ALLOWED_ORIGINS.includes(origin)
}

/** True when the Host header names this machine (any loopback hostname, any port).
 *  Blocks DNS-rebinding hosts (which carry the attacker's domain, not a loopback name). */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false
  if (LOOPBACK_HOSTNAMES.has(hostnameOf(host))) return true
  return ALLOWED_HOSTS.includes(host.toLowerCase())
}
