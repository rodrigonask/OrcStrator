import crypto from 'crypto'
import os from 'os'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { OAUTH } from '@nasklaude/shared'
import type { UsageData, UsageBucket } from '@nasklaude/shared'

// Machine-specific encryption key derived from hostname+username
function getMachineKey(): Buffer {
  const raw = `${os.hostname()}:${os.userInfo().username}:nasklaude-token-key`
  return crypto.createHash('sha256').update(raw).digest()
}

function encrypt(text: string): string {
  if (!text) return ''
  const key = getMachineKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex')
}

function decrypt(data: string): string {
  if (!data) return ''
  try {
    const parts = data.split(':')
    if (parts.length !== 3) return ''
    const iv = Buffer.from(parts[0], 'hex')
    const tag = Buffer.from(parts[1], 'hex')
    const encrypted = Buffer.from(parts[2], 'hex')
    const key = getMachineKey()
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return decipher.update(encrypted) + decipher.final('utf8')
  } catch {
    return ''
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let lastUsageData: UsageData = { connected: false, buckets: [] }
let lastAlertedThresholds = new Set<string>()

function getTokens(): { accessToken: string; refreshToken: string; expiresAt: string; verifier: string } {
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE id = 1').get() as Record<string, string> | undefined
  if (!row) return { accessToken: '', refreshToken: '', expiresAt: '', verifier: '' }
  return {
    accessToken: decrypt(row.access_token || ''),
    refreshToken: decrypt(row.refresh_token || ''),
    expiresAt: row.expires_at || '',
    verifier: row.verifier || ''
  }
}

function saveTokens(tokens: { accessToken?: string; refreshToken?: string; expiresAt?: string; verifier?: string }): void {
  const current = getTokens()
  db.prepare(`
    UPDATE oauth_tokens SET
      access_token = ?,
      refresh_token = ?,
      expires_at = ?,
      verifier = ?
    WHERE id = 1
  `).run(
    encrypt(tokens.accessToken ?? current.accessToken),
    encrypt(tokens.refreshToken ?? current.refreshToken),
    tokens.expiresAt ?? current.expiresAt,
    tokens.verifier ?? current.verifier
  )
}

export function generateAuthUrl(): { url: string; verifier: string } {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH.clientId,
    redirect_uri: OAUTH.redirectUri,
    scope: OAUTH.scopes,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: crypto.randomUUID()
  })

  saveTokens({ verifier })

  return {
    url: `${OAUTH.authBaseUrl}?${params.toString()}`,
    verifier
  }
}

export async function exchangeCode(code: string): Promise<boolean> {
  const { verifier } = getTokens()
  if (!verifier) throw new Error('No verifier found. Start auth flow first.')

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OAUTH.clientId,
    code,
    redirect_uri: OAUTH.redirectUri,
    code_verifier: verifier
  })

  const resp = await fetch(OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Token exchange failed: ${resp.status} ${text}`)
  }

  const data = await resp.json() as { access_token: string; refresh_token: string; expires_in: number }
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()

  saveTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    verifier: ''
  })

  // Start polling after successful auth
  startPolling()
  return true
}

export async function refreshTokens(): Promise<boolean> {
  const { refreshToken } = getTokens()
  if (!refreshToken) return false

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: OAUTH.clientId,
    refresh_token: refreshToken
  })

  try {
    const resp = await fetch(OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })

    if (!resp.ok) return false

    const data = await resp.json() as { access_token: string; refresh_token: string; expires_in: number }
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()

    saveTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt
    })

    return true
  } catch {
    return false
  }
}

export async function fetchUsage(): Promise<UsageData> {
  const tokens = getTokens()
  if (!tokens.accessToken) {
    lastUsageData = { connected: false, buckets: [] }
    return lastUsageData
  }

  // Check if token is expired, refresh if needed
  if (tokens.expiresAt && new Date(tokens.expiresAt) <= new Date()) {
    const refreshed = await refreshTokens()
    if (!refreshed) {
      lastUsageData = { connected: false, buckets: [] }
      return lastUsageData
    }
  }

  try {
    const currentTokens = getTokens()
    const resp = await fetch(OAUTH.usageUrl, {
      headers: { Authorization: `Bearer ${currentTokens.accessToken}` }
    })

    if (resp.status === 401) {
      const refreshed = await refreshTokens()
      if (refreshed) {
        return fetchUsage()
      }
      lastUsageData = { connected: false, buckets: [] }
      return lastUsageData
    }

    if (!resp.ok) {
      throw new Error(`Usage fetch failed: ${resp.status}`)
    }

    const data = await resp.json() as { buckets?: Array<{ label: string; used: number; limit: number; resets_at?: string }> }
    const buckets: UsageBucket[] = (data.buckets || []).map(b => {
      const pct = b.limit > 0 ? Math.round((b.used / b.limit) * 100) : 0
      let resetCountdown: string | undefined
      if (b.resets_at) {
        const diff = new Date(b.resets_at).getTime() - Date.now()
        if (diff > 0) {
          const hours = Math.floor(diff / 3_600_000)
          const minutes = Math.floor((diff % 3_600_000) / 60_000)
          resetCountdown = `${hours}h ${minutes}m`
        }
      }
      return {
        label: b.label,
        used: b.used,
        limit: b.limit,
        percentage: pct,
        resetsAt: b.resets_at,
        resetCountdown
      }
    })

    lastUsageData = { connected: true, buckets, lastUpdated: Date.now() }

    // Check alert thresholds
    const thresholds = [50, 80, 95]
    for (const bucket of buckets) {
      for (const threshold of thresholds) {
        const key = `${bucket.label}:${threshold}`
        if (bucket.percentage >= threshold && !lastAlertedThresholds.has(key)) {
          lastAlertedThresholds.add(key)
          broadcastEvent({
            type: 'usage:alert',
            payload: { bucket: bucket.label, percentage: bucket.percentage, threshold }
          })
        }
      }
    }

    broadcastEvent({ type: 'usage:updated', payload: lastUsageData })
    return lastUsageData
  } catch (err) {
    console.error('[usage-monitor] Fetch error:', err)
    return lastUsageData
  }
}

export function startPolling(intervalMinutes?: number): void {
  stopPolling()
  const tokens = getTokens()
  if (!tokens.accessToken) return

  const interval = (intervalMinutes || 10) * 60 * 1000
  fetchUsage().catch(() => {})
  pollTimer = setInterval(() => {
    fetchUsage().catch(() => {})
  }, interval)
}

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export function disconnect(): void {
  stopPolling()
  saveTokens({ accessToken: '', refreshToken: '', expiresAt: '', verifier: '' })
  lastUsageData = { connected: false, buckets: [] }
  lastAlertedThresholds.clear()
  broadcastEvent({ type: 'usage:updated', payload: lastUsageData })
}

export function getCurrentUsage(): UsageData {
  return lastUsageData
}
