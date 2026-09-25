// Cache advisor - one 60s ticker that drives two of the "save the cold start" levers:
//
//   1. KEEP-WARM (user opt-in per session, the 🔥 chip): for instances with keep_warm=1,
//      fire a minimal keep-alive turn just before the prompt-cache TTL expires so the
//      cache never goes cold. The ping runs on the session's OWN model - the cache is
//      keyed by model, so a cheaper-model ping would warm the wrong cache.
//
//   2. COLD-START ADVISOR (offer-only): for heavy, idle sessions that are NOT kept warm
//      and are about to go cold, broadcast `compaction:suggested` so the client can offer
//      a one-click compact. Compacting before the cache expires means the eventual cold
//      re-read is of a SMALL context - a cheap cold start instead of an expensive one.
//
// Nothing here enforces or auto-acts beyond the user's explicit keep-warm toggle.
import crypto from 'crypto'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { processRegistry } from './process-registry.js'
import { sendMessage } from './claude-process.js'
import { promptCache1hEnabled } from './prompt-cache.js'

// Claude's prompt-cache TTL: 1h when the 1-hour cache is enabled (our default), else 5m.
// Mirrors the gate in claude-process.ts and the 'cold' threshold in routes/state.ts.
function cacheTtlMs(): number {
  return promptCache1hEnabled() ? 60 * 60 * 1000 : 5 * 60 * 1000
}

const KEEPWARM_FIRE_BEFORE_MS = 6 * 60 * 1000   // fire keep-alive within 6 min of expiry
const ADVISOR_FIRE_BEFORE_MS = 10 * 60 * 1000   // suggest compaction within 10 min of cold
const ADVISOR_CTX_MIN = 250_000                 // only nudge for genuinely heavy contexts (matches the client compact button)
const SUGGEST_COOLDOWN_MS = 30 * 60 * 1000      // at most one suggestion per instance / 30 min
import { KEEPALIVE_TEXT } from '../config.js'

const lastSuggestedAt = new Map<string, number>()
const lastPingAt = new Map<string, number>()
let timer: ReturnType<typeof setInterval> | null = null

interface AdvisorRow {
  id: string
  name: string
  cwd: string
  session_id: string | null
  keep_warm: number
  ctx_tokens: number | null
  ctx_model: string | null
  last_task_at: number | null
}

/** Most recent activity for an instance = latest turn_costs row, falling back to last_task_at. */
function lastActivityAt(id: string, lastTaskAt: number | null): number {
  let at = lastTaskAt ?? 0
  try {
    const t = db.prepare('SELECT MAX(created_at) ts FROM turn_costs WHERE instance_id = ?').get(id) as { ts: number | null } | undefined
    if (t?.ts) at = Math.max(at, t.ts)
  } catch { /* non-critical */ }
  return at
}

async function fireKeepAlive(row: AdvisorRow): Promise<void> {
  if (!row.session_id) return
  const now = Date.now()
  // Record + broadcast a tiny user message so the chat shows the ping (the user opted in)
  // and the assistant "ok" doesn't appear without a visible prompt before a refresh.
  try {
    const msg = { id: crypto.randomUUID(), instanceId: row.id, role: 'user' as const, content: [{ type: 'text', text: '🔥 keep-warm' }], createdAt: now }
    db.prepare('INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(msg.id, row.id, 'user', JSON.stringify(msg.content), now)
    broadcastEvent({ type: 'message:added', payload: { instanceId: row.id, message: msg } })
  } catch { /* non-critical */ }
  // Pin the ping to the session's own model so the right (model-keyed) cache is refreshed.
  const flags = row.ctx_model ? [`--model=${row.ctx_model}`] : []
  // 'keepalive' is a hard no-surface: this fires on a timer against every keep_warm chat,
  // so surfacing it would glow half the grid every cache TTL.
  await sendMessage({ instanceId: row.id, text: KEEPALIVE_TEXT, cwd: row.cwd, sessionId: row.session_id, flags, origin: 'keepalive' })
}

async function tick(): Promise<void> {
  let rows: AdvisorRow[]
  try {
    rows = db.prepare(
      // awaiting_input IS NULL matters: an instance blocked on an unanswered question is
      // state='idle' like any other, so without this the keep-alive ping below would spawn a
      // turn on it, and the spawn-side clear would silently drop its "waiting on you" chip
      // while the question sat unanswered on screen. A keep-alive is a no-op ping, not an
      // answer, and it must never be able to dismiss a real question.
      `SELECT id, name, cwd, session_id, keep_warm, ctx_tokens, ctx_model, last_task_at
       FROM instances
       WHERE session_id IS NOT NULL AND state = 'idle' AND awaiting_input IS NULL`
    ).all() as AdvisorRow[]
  } catch {
    return
  }

  const now = Date.now()
  const ttl = cacheTtlMs()

  for (const row of rows) {
    if (processRegistry.isTracked(row.id)) continue
    const lastAt = lastActivityAt(row.id, row.last_task_at)
    if (!lastAt) continue
    const msToCold = (lastAt + ttl) - now
    if (msToCold <= 0) continue // already cold - keep-warm missed it, advisor has nothing to save

    if (row.keep_warm) {
      // Keep-warm: fire once inside the danger window, throttled so we never double-ping.
      if (msToCold > KEEPWARM_FIRE_BEFORE_MS) continue
      if (now - (lastPingAt.get(row.id) ?? 0) < ttl - KEEPWARM_FIRE_BEFORE_MS) continue
      lastPingAt.set(row.id, now)
      try {
        await fireKeepAlive(row)
      } catch (err) {
        console.warn(`[cache-advisor] keep-warm ping failed for ${row.id.slice(0, 8)}:`, err)
      }
      continue
    }

    // Cold-start advisor: heavy, idle, about to go cold, not kept warm → offer a compact.
    const ctx = row.ctx_tokens ?? 0
    if (ctx < ADVISOR_CTX_MIN) continue
    if (msToCold > ADVISOR_FIRE_BEFORE_MS) continue
    if (now - (lastSuggestedAt.get(row.id) ?? 0) < SUGGEST_COOLDOWN_MS) continue
    lastSuggestedAt.set(row.id, now)
    broadcastEvent({
      type: 'compaction:suggested',
      payload: {
        instanceId: row.id,
        instanceName: row.name,
        ctxTokens: ctx,
        reason: 'cold',
        minutesToCold: Math.max(0, Math.round(msToCold / 60_000)),
      },
    })
  }
}

/** Quota lever: when the 5-hour usage bucket gets high, nudge a compact on the single
 *  heaviest idle session (smaller context → less burn per future turn). Called from the
 *  usage monitor on a threshold crossing. Offer-only - broadcasts, never acts. */
export function suggestCompactionForQuota(pct: number): void {
  let row: { id: string; name: string; ctx_tokens: number | null } | undefined
  try {
    row = db.prepare(
      `SELECT id, name, ctx_tokens FROM instances
       WHERE session_id IS NOT NULL AND state = 'idle' AND COALESCE(ctx_tokens, 0) >= ?
       ORDER BY ctx_tokens DESC LIMIT 1`
    ).get(ADVISOR_CTX_MIN) as { id: string; name: string; ctx_tokens: number | null } | undefined
  } catch {
    return
  }
  if (!row) return
  if (processRegistry.isTracked(row.id)) return
  const now = Date.now()
  if (now - (lastSuggestedAt.get(row.id) ?? 0) < SUGGEST_COOLDOWN_MS) return
  lastSuggestedAt.set(row.id, now)
  broadcastEvent({
    type: 'compaction:suggested',
    payload: {
      instanceId: row.id,
      instanceName: row.name,
      ctxTokens: row.ctx_tokens ?? 0,
      reason: 'quota',
      usagePct: Math.round(pct),
    },
  })
}

export function startCacheAdvisor(): void {
  stopCacheAdvisor()
  timer = setInterval(() => { void tick().catch(() => {}) }, 60_000)
  console.log('[cache-advisor] started (keep-warm + cold-start advisor, 60s tick)')
}

export function stopCacheAdvisor(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
