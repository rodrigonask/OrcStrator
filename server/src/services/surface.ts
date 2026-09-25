import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import type { SurfaceSource, InstanceConfig } from '@orcstrator/shared'

// ─────────────────────────────────────────────────────────────────────────────
// Surfacing: a SCHEDULED fire (a routine, or a ScheduleWakeup wake-up) makes its chat
// show itself. The client pulls the chat into the grid, plays one glow, and holds a
// bright "scheduled, waiting on you" status until the chat is actually looked at.
//
// The server owns exactly one fact: instances.surfaced_at (plus surfaced_source). That
// is what lets the surface outlive the app being closed: on the next /api/state load the
// client sees the pending surface and treats it as if the event had just arrived.
//
// Everything about WHEN the glow plays (tab visible, window focused, grid on screen,
// tile mounted) is client-side and deliberately not modelled here. The server says "this
// chat surfaced at T"; the client decides when the user can actually see it.
//
// Silence is read off the INSTANCE, not the routine. A silent routine stamps
// surface_silent on the chat it spawns, and a routine firing on an existing chat
// re-stamps that chat to match. A wake-up scheduled from inside a silent run therefore
// inherits the silence with no cross-table lookup at fire time.
// ─────────────────────────────────────────────────────────────────────────────

export interface SurfacedPayload {
  instanceId: string
  source: SurfaceSource
  surfacedAt: number
  routineId?: string
  /**
   * A snapshot of the chat, same shape as the instance:created broadcast, so a client
   * that never saw the chat (a WS reconnect swallowed instance:created, or the chat was
   * spawned by this very fire) can still add it and give it a tile.
   */
  instance: InstanceConfig
}

/**
 * Mark a chat as surfaced by a scheduled fire and tell every client. No-op for a chat
 * stamped silent. Returns the payload that was broadcast, or null when nothing happened.
 */
export function surfaceInstance(instanceId: string, source: SurfaceSource, opts: { routineId?: string } = {}): SurfacedPayload | null {
  const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId) as Record<string, unknown> | undefined
  if (!row) return null
  if (row.surface_silent) {
    // A chat switched to silent may still be wearing the bright status from an earlier,
    // visible fire. Leaving it would show "scheduled, waiting on you" about a run that is
    // now deliberately quiet, so the stale surface is cleared here.
    ackSurface(instanceId)
    console.log(`[surface] instance ${instanceId.slice(0, 8)} is silent; ${source} fire stays out of the grid`)
    return null
  }
  const surfacedAt = Date.now()
  db.prepare('UPDATE instances SET surfaced_at = ?, surfaced_source = ? WHERE id = ?')
    .run(surfacedAt, source, instanceId)
  const instance: InstanceConfig = {
    id: row.id as string,
    folderId: row.folder_id as string,
    name: row.name as string,
    cwd: row.cwd as string,
    sessionId: (row.session_id as string | null) ?? undefined,
    state: ((row.state as InstanceConfig['state']) || 'idle'),
    agentId: (row.agent_id as string | null) ?? undefined,
    idleRestartMinutes: (row.idle_restart_minutes as number) ?? 0,
    sortOrder: (row.sort_order as number) ?? 0,
    createdAt: row.created_at as number,
    surfacedAt,
    surfacedSource: source,
    surfaceSilent: false,
  }
  const payload: SurfacedPayload = { instanceId, source, surfacedAt, routineId: opts.routineId, instance }
  broadcastEvent({ type: 'instance:surfaced', payload })
  console.log(`[surface] instance ${instanceId.slice(0, 8)} surfaced by ${source} at ${surfacedAt}`)
  return payload
}

/**
 * The chat has been looked at: clear the pending surface so the bright status drops on
 * every client. Idempotent. Broadcasts instance:updated only when something changed, so
 * a focus on an ordinary chat costs nothing on the wire.
 */
export function ackSurface(instanceId: string, surfacedAt?: number): boolean {
  // When the caller says WHICH surface it is acking, only that one is cleared: a fire that
  // landed inside the click's round trip wrote a newer value and must not be swallowed by
  // an ack aimed at the older one. Callers with no value (silent fire, failed send) clear
  // whatever is there.
  const r = surfacedAt != null
    ? db.prepare(
        'UPDATE instances SET surfaced_at = NULL, surfaced_source = NULL WHERE id = ? AND surfaced_at = ?'
      ).run(instanceId, surfacedAt)
    : db.prepare(
        'UPDATE instances SET surfaced_at = NULL, surfaced_source = NULL WHERE id = ? AND surfaced_at IS NOT NULL'
      ).run(instanceId)
  if (r.changes === 0) return false
  // Flat payload: the client's instance:updated handler copies known keys off the top level.
  // null, not undefined, so the keys survive JSON and the client actually clears them.
  broadcastEvent({
    type: 'instance:updated',
    payload: { id: instanceId, surfacedAt: null, surfacedSource: null },
  })
  return true
}

/** Stamp (or re-stamp) a chat's silence from the routine that is about to fire on it. */
export function setSurfaceSilent(instanceId: string, silent: boolean): void {
  db.prepare('UPDATE instances SET surface_silent = ? WHERE id = ?').run(silent ? 1 : 0, instanceId)
}
