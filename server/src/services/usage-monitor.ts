// Claude plan-limits monitor — polls api.anthropic.com/api/oauth/usage. Display only.
// PRIMARY token source: the Claude CLI's own credentials (~/.claude/.credentials.json),
// zero-setup and automatically tracking whichever account `claude login` is using.
// FALLBACK: the app's own OAuth PKCE flow (oauth_tokens table).
import crypto from 'crypto'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { encrypt, decrypt } from './secret-box.js'
import { suggestCompactionForQuota } from './cache-advisor.js'
import { OAUTH, USAGE_ALERT_THRESHOLDS } from '@orcstrator/shared'
import type { UsageData, UsageBucket, UsageBucketKey } from '@orcstrator/shared'

// ── Token storage (oauth_tokens table, single row id=1) ──
// encrypt/decrypt live in secret-box.ts (shared with instance-namer's API-key storage).

interface Tokens { accessToken: string; refreshToken: string; expiresAt: string; verifier: string }

function getTokens(): Tokens {
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE id = 1').get() as Record<string, string> | undefined
  if (!row) return { accessToken: '', refreshToken: '', expiresAt: '', verifier: '' }
  return {
    accessToken: decrypt(row.access_token || ''),
    refreshToken: decrypt(row.refresh_token || ''),
    expiresAt: row.expires_at || '',
    verifier: row.verifier || ''
  }
}

function saveTokens(tokens: Partial<Tokens>): void {
  const current = getTokens()
  db.prepare(`
    UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, verifier = ? WHERE id = 1
  `).run(
    encrypt(tokens.accessToken ?? current.accessToken),
    encrypt(tokens.refreshToken ?? current.refreshToken),
    tokens.expiresAt ?? current.expiresAt,
    tokens.verifier ?? current.verifier
  )
}

function getSettingNumber(key: string, fallback: number): number {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return fallback
    const v = JSON.parse(row.value)
    return typeof v === 'number' && v > 0 ? v : fallback
  } catch {
    return fallback
  }
}

function getSettingBool(key: string, fallback: boolean): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return fallback
    return Boolean(JSON.parse(row.value))
  } catch {
    return fallback
  }
}

// ── Usage parsing ──
// Primary: the API's `limits` array (kind: session / weekly_all / weekly_scoped),
// which carries per-model weekly limits with a display name (e.g. Fable).
// Legacy fallback: flexible top-level key detection (for older response shapes).

type FixedBucketKey = 'session' | 'weekly' | 'extra'

const KEYS: FixedBucketKey[] = ['session', 'weekly', 'extra']

const KEY_MAP: Record<FixedBucketKey, string[]> = {
  session: ['five_hour', 'fiveHour', '5_hour', 'short_term', 'shortTerm'],
  weekly: [
    'seven_day', 'seven_day_all', 'sevenDayAll', '7_day_all',
    'long_term', 'longTerm', 'daily', 'weekly'
  ],
  extra: [
    'extra_usage', 'extra', 'seven_day_sonnet',
    'sevenDaySonnet', '7_day_sonnet', 'sonnet'
  ]
}

const LABELS: Record<FixedBucketKey, string> = {
  session: 'Session',
  weekly: 'Weekly',
  extra: 'Extra'
}

function formatReset(isoStr: string): string {
  try {
    let s = isoStr
    if (s.endsWith('Z')) s = s.slice(0, -1) + '+00:00'
    const dt = new Date(s)
    const secs = Math.floor((dt.getTime() - Date.now()) / 1000)
    if (secs <= 0) return 'now'
    const d = Math.floor(secs / 86400)
    const h = Math.floor((secs % 86400) / 3600)
    const m = Math.floor((secs % 3600) / 60)
    if (d > 0) return `${d}d ${h}h`
    if (h > 0) return `${h}h ${m}m`
    return `${m}m`
  } catch {
    return ''
  }
}

interface ParsedBucket { pct: number; reset: string; resetsAt?: string }

function parseBucket(raw: unknown): ParsedBucket | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  let util = obj.utilization as number | undefined
  if (util == null) util = (obj.usage ?? obj.value) as number | undefined
  if (util == null) {
    const pctVal = obj.percent as number | undefined
    if (pctVal != null) util = pctVal / 100.0
  }
  if (util == null) return null
  const pct = Math.max(0, Math.min(Number(util), 100))
  const resetRaw = (obj.resets_at ?? obj.reset_at ?? obj.resetAt ?? '') as string
  return {
    pct: Math.round(pct * 10) / 10,
    reset: resetRaw ? formatReset(resetRaw) : '',
    resetsAt: resetRaw || undefined
  }
}

interface LimitEntry {
  kind?: string
  percent?: number
  resets_at?: string
  scope?: { model?: { display_name?: string | null } | null } | null
}

function bucketFromLimit(key: UsageBucketKey, label: string, l: LimitEntry): UsageBucket | null {
  if (typeof l.percent !== 'number') return null
  const pct = Math.max(0, Math.min(l.percent, 100))
  const resetRaw = l.resets_at || ''
  return {
    key,
    label,
    pct: Math.round(pct * 10) / 10,
    reset: resetRaw ? formatReset(resetRaw) : '',
    resetsAt: resetRaw || undefined
  }
}

// New-shape parse: the `limits` array. Order: Session, Weekly, then each
// model-scoped weekly limit (Fable etc.), then Extra credits when enabled.
function parseLimitsArray(data: Record<string, unknown>): UsageBucket[] {
  const limits = data.limits
  if (!Array.isArray(limits)) return []
  const entries = limits.filter((l): l is LimitEntry => Boolean(l && typeof l === 'object'))
  const out: UsageBucket[] = []

  const session = entries.find(l => l.kind === 'session')
  if (session) {
    const b = bucketFromLimit('session', 'Session', session)
    if (b) out.push(b)
  }
  const weekly = entries.find(l => l.kind === 'weekly_all')
  if (weekly) {
    const b = bucketFromLimit('weekly', 'Weekly', weekly)
    if (b) out.push(b)
  }
  for (const l of entries) {
    if (l.kind !== 'weekly_scoped') continue
    const label = l.scope?.model?.display_name || 'Model'
    const b = bucketFromLimit(`model:${label.toLowerCase()}`, label, l)
    if (b) out.push(b)
  }

  // Extra-usage credits only when actually enabled: a disabled credits object
  // used to render as a misleading 0% "Sonnet" bar.
  const extraRaw = data.extra_usage as Record<string, unknown> | undefined
  if (extraRaw && typeof extraRaw === 'object' && extraRaw.is_enabled === true) {
    const p = parseBucket(extraRaw)
    if (p) out.push({ key: 'extra', label: LABELS.extra, pct: p.pct, reset: p.reset, resetsAt: p.resetsAt })
  }

  return out
}

function parseUsage(data: Record<string, unknown>): UsageBucket[] {
  const fromLimits = parseLimitsArray(data)
  if (fromLimits.length > 0) return fromLimits

  // Legacy shape: flexible top-level key detection
  const result: Partial<Record<FixedBucketKey, ParsedBucket>> = {}

  for (const barKey of KEYS) {
    for (const ak of KEY_MAP[barKey]) {
      if (ak in data) {
        const parsed = parseBucket(data[ak])
        if (parsed) {
          result[barKey] = parsed
          break
        }
      }
    }
  }

  // Fallback: dynamic bucket detection (alphabetical key order → session/weekly/extra)
  if (Object.keys(result).length === 0) {
    const buckets: ParsedBucket[] = []
    for (const key of Object.keys(data).sort()) {
      const parsed = parseBucket(data[key])
      if (parsed) buckets.push(parsed)
    }
    for (let i = 0; i < KEYS.length && i < buckets.length; i++) {
      result[KEYS[i]] = buckets[i]
    }
  }

  const out: UsageBucket[] = []
  for (const k of KEYS) {
    const p = result[k]
    if (p) out.push({ key: k, label: LABELS[k], pct: p.pct, reset: p.reset, resetsAt: p.resetsAt })
  }
  return out
}

// ── State ──

let pollTimer: ReturnType<typeof setInterval> | null = null
let refreshing = false // mutex for token refresh
let lastUsageData: UsageData = { connected: false, buckets: [] }
// Highest threshold already notified per bucket; each threshold fires once per crossing,
// resets when usage drops back below it. Keyed by bucket key,
// including dynamic model-scoped ones ('model:fable').
const alerted: Record<string, number> = {}

// ── HTTP helpers (browser-like headers; the token endpoint rejects bare bot requests) ──

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function postJSON(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: 'POST',
    // Mirrors the claude CLI: no Origin header. (Older code sent
    // Origin: console.anthropic.com, which predates the platform.claude.com move.)
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  })
  const text = await resp.text()
  if (resp.status >= 400) {
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`)
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`Invalid JSON: ${text.slice(0, 200)}`)
  }
}

async function fetchUsageAPI(accessToken: string): Promise<Record<string, unknown>> {
  const resp = await fetch(OAUTH.usageUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': USER_AGENT,
      'Accept': 'application/json'
    }
  })
  if (resp.status >= 400) {
    const err = new Error(`HTTP ${resp.status}`) as Error & { statusCode: number }
    err.statusCode = resp.status
    throw err
  }
  return await resp.json() as Record<string, unknown>
}

// ── OAuth flow ──

export function generateAuthUrl(): { url: string } {
  const verifier = crypto.randomBytes(64).toString('base64url').slice(0, 128)
  const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url')

  const params = new URLSearchParams({
    code: 'true',
    client_id: OAUTH.clientId,
    response_type: 'code',
    redirect_uri: OAUTH.redirectUri,
    scope: OAUTH.scopes,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier
  })

  saveTokens({ verifier })

  return { url: `${OAUTH.authBaseUrl}?${params.toString()}` }
}

function storeTokenResponse(resp: Record<string, unknown>): void {
  const at = (resp.access_token as string) || ''
  const current = getTokens()
  const rt = (resp.refresh_token as string) || current.refreshToken
  let ei = resp.expires_in as number | string
  if (typeof ei === 'string') ei = parseInt(ei)
  if (!ei || Number.isNaN(ei)) ei = 3600
  const expiresAt = new Date(Date.now() + ei * 1000).toISOString()
  saveTokens({ accessToken: at, refreshToken: rt, expiresAt, verifier: '' })
}

// Accepts the raw paste from the callback page ("code" or "code#state"). The token
// endpoint wants the state echoed back when present, and the EXACT redirect_uri that
// /authorize used — a mismatch surfaces as a fake 429 "Rate limited".
export async function exchangeCode(codeRaw: string): Promise<UsageData> {
  const { verifier } = getTokens()
  if (!verifier) throw new Error('No verifier found. Start the connect flow first.')

  const parts = codeRaw.trim().split('#')
  const code = parts[0]
  const state = parts.length > 1 ? parts[1] : undefined
  if (!code) throw new Error('Empty authorization code')

  const body: Record<string, string> = {
    code,
    grant_type: 'authorization_code',
    client_id: OAUTH.clientId,
    redirect_uri: OAUTH.redirectUri,
    code_verifier: verifier
  }
  if (state) body.state = state

  const resp = await postJSON(OAUTH.tokenUrl, body)
  if (!resp.access_token) {
    throw new Error(`No access_token in response. Keys: ${Object.keys(resp).join(', ')}`)
  }
  storeTokenResponse(resp)

  // Fetch immediately, then poll
  await fetchUsage(true)
  startPolling()
  return lastUsageData
}

async function doRefresh(): Promise<string | null> {
  if (refreshing) return null
  refreshing = true
  try {
    const { refreshToken } = getTokens()
    if (!refreshToken) return null
    const resp = await postJSON(OAUTH.tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH.clientId
    })
    if (!resp.access_token) return null
    storeTokenResponse(resp)
    return resp.access_token as string
  } catch (e) {
    console.log('[usage-monitor] refresh failed:', e)
    return null
  } finally {
    refreshing = false
  }
}

// ── Claude CLI credentials (primary, zero-setup source) ──
// The native CLI stores its OAuth token at ~/.claude/.credentials.json and uses it
// for this same usage endpoint. Reading it means: no connect flow, and the widget
// automatically follows whichever account is logged in via `claude login`.
// The token never leaves this machine except to Anthropic's own usage endpoint.

interface CliCreds { token: string; expiresAt: number | null }

function getCliCredentials(): CliCreds | null {
  try {
    const file = path.join(os.homedir(), '.claude', '.credentials.json')
    if (!fs.existsSync(file)) return null
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    // Known shape: { claudeAiOauth: { accessToken, refreshToken, expiresAt(ms), scopes, ... } }
    // Scan defensively: take the first object value carrying an accessToken string.
    const candidates: Array<Record<string, unknown>> = []
    if (raw.accessToken) candidates.push(raw)
    for (const v of Object.values(raw)) {
      if (v && typeof v === 'object' && (v as Record<string, unknown>).accessToken) {
        candidates.push(v as Record<string, unknown>)
      }
    }
    for (const c of candidates) {
      const token = c.accessToken
      if (typeof token === 'string' && token.length > 20) {
        let expiresAt: number | null = null
        const e = c.expiresAt
        if (typeof e === 'number') expiresAt = e
        else if (typeof e === 'string') {
          const t = Date.parse(e)
          if (!Number.isNaN(t)) expiresAt = t
        }
        return { token, expiresAt }
      }
    }
    return null
  } catch {
    return null
  }
}

async function getValidToken(): Promise<string | null> {
  const tokens = getTokens()
  if (!tokens.accessToken) return null
  if (tokens.expiresAt) {
    try {
      let s = tokens.expiresAt
      if (s.endsWith('Z')) s = s.slice(0, -1) + '+00:00'
      const exp = new Date(s)
      if (!Number.isNaN(exp.getTime()) && Date.now() >= exp.getTime()) {
        return doRefresh()
      }
    } catch {
      // If we can't parse the date, try the token anyway
    }
  }
  return tokens.accessToken
}

// ── Polling + parsing ──

let currentSource: 'oauth' | 'cli' | undefined

function applyParsed(buckets: UsageBucket[]): void {
  lastUsageData = { connected: true, buckets, lastUpdated: Date.now(), source: currentSource }
  checkAlerts()
  broadcastEvent({ type: 'usage:plan-updated', payload: lastUsageData })
}

function checkAlerts(): void {
  if (!getSettingBool('notifications', true)) return
  for (const bucket of lastUsageData.buckets) {
    const k = bucket.key
    const pct = bucket.pct
    const prevLevel = alerted[k] || 0

    // Highest crossed threshold
    let crossed = 0
    for (const t of USAGE_ALERT_THRESHOLDS) {
      if (pct >= t) crossed = t
    }

    // Notify only on a NEW crossing
    if (crossed > prevLevel) {
      alerted[k] = crossed
      broadcastEvent({
        type: 'usage:alert',
        payload: { bucket: bucket.label, pct, threshold: crossed }
      })
      // Quota lever for "save the cold start": high 5-hour usage → offer to compact the
      // heaviest idle session (smaller context = less input billed on every later turn).
      if (k === 'session' && crossed >= 75) {
        try { suggestCompactionForQuota(pct) } catch { /* non-critical */ }
      }
    }

    // Reset if usage dropped below the notified level (e.g. bucket reset)
    if (pct < prevLevel) {
      let newLevel = 0
      for (const t of USAGE_ALERT_THRESHOLDS) {
        if (pct >= t) newLevel = t
      }
      alerted[k] = newLevel
    }
  }
}

// Throttle: turn completions also trigger fetches (see index.ts) — with many
// instances finishing at once that bursts into Anthropic's rate limit (HTTP 429).
// At most one real fetch per MIN_FETCH_INTERVAL; a 429 backs off for 5 minutes.
const MIN_FETCH_INTERVAL_MS = 30_000
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000
let lastFetchStartedAt = 0
let backoffUntil = 0

export async function fetchUsage(force = false): Promise<UsageData> {
  const now = Date.now()
  if (!force && (now - lastFetchStartedAt < MIN_FETCH_INTERVAL_MS || now < backoffUntil)) {
    return lastUsageData
  }
  lastFetchStartedAt = now

  // CLI credentials first (zero-setup, follows `claude login` account switches),
  // then the app's own OAuth tokens.
  let token: string | null = null
  const cli = getCliCredentials()
  if (cli) {
    if (cli.expiresAt && cli.expiresAt < Date.now()) {
      // The CLI refreshes this token whenever claude runs; a stale token just means
      // claude hasn't run recently. Fall through to own-OAuth tokens if present.
      currentSource = undefined
    } else {
      token = cli.token
      currentSource = 'cli'
    }
  }
  if (!token) {
    token = await getValidToken()
    if (token) currentSource = 'oauth'
  }
  if (!token) {
    const wasConnected = lastUsageData.connected
    const staleCliMsg = cli ? 'Claude CLI token expired — run any claude command to refresh it' : undefined
    lastUsageData = { connected: false, buckets: [], lastError: staleCliMsg ?? (getTokens().refreshToken ? 'Session expired — reconnect' : undefined) }
    if (wasConnected) broadcastEvent({ type: 'usage:plan-updated', payload: lastUsageData })
    return lastUsageData
  }

  try {
    const data = await fetchUsageAPI(token)
    applyParsed(parseUsage(data))
    return lastUsageData
  } catch (e) {
    const err = e as Error & { statusCode?: number }
    if (err.statusCode === 401 && currentSource === 'oauth') {
      // Refresh and retry once (own-OAuth tokens only; the CLI refreshes its own)
      const newToken = await doRefresh()
      if (newToken) {
        try {
          const data = await fetchUsageAPI(newToken)
          applyParsed(parseUsage(data))
          return lastUsageData
        } catch (e2) {
          lastUsageData = { ...lastUsageData, lastError: String(e2).slice(0, 120), lastUpdated: Date.now() }
        }
      } else {
        lastUsageData = { ...lastUsageData, connected: false, lastError: 'Session expired — reconnect', lastUpdated: Date.now() }
      }
    } else if (err.statusCode === 401 && currentSource === 'cli') {
      lastUsageData = { ...lastUsageData, connected: false, lastError: 'Claude CLI token rejected — run any claude command to refresh it', lastUpdated: Date.now() }
    } else if (err.statusCode === 429) {
      // Throttled — keep the last known buckets, surface a calm note, back off
      backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS
      lastUsageData = { ...lastUsageData, lastError: 'Usage check throttled — retrying in 5 min', lastUpdated: Date.now() }
    } else {
      lastUsageData = { ...lastUsageData, lastError: String(e).slice(0, 120), lastUpdated: Date.now() }
    }
    broadcastEvent({ type: 'usage:plan-updated', payload: lastUsageData })
    return lastUsageData
  }
}

export function startPolling(intervalMinutes?: number): void {
  stopPolling()
  // Poll when EITHER source is available; otherwise idle until connected.
  if (!getTokens().accessToken && !getCliCredentials()) return

  const minutes = Math.max(1, intervalMinutes ?? getSettingNumber('usagePollMinutes', 1))
  fetchUsage().catch(() => {})
  pollTimer = setInterval(() => {
    fetchUsage().catch(() => {})
  }, minutes * 60_000)
}

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export function disconnect(): UsageData {
  stopPolling()
  saveTokens({ accessToken: '', refreshToken: '', expiresAt: '', verifier: '' })
  lastUsageData = { connected: false, buckets: [] }
  for (const k of Object.keys(alerted)) alerted[k] = 0
  broadcastEvent({ type: 'usage:plan-updated', payload: lastUsageData })
  return lastUsageData
}

export function getCurrentUsage(): UsageData {
  return lastUsageData
}
