import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import type { InstanceConfig } from '@orcstrator/shared'

export type AwaitingInputKind = NonNullable<InstanceConfig['awaitingInput']>

/**
 * "This instance is blocked on the user", as a persisted fact rather than an inference.
 *
 * AskUserQuestion and ExitPlanMode deliberately kill the process (hardStopForQuestion in
 * claude-process.ts) so the interactive card is the last thing on screen. The exit handler
 * then sets `state = 'idle'`, which is correct for the process and wrong for the user: the
 * work is not finished, it is waiting on an answer. Nothing in the DB distinguished those
 * two, so the top-bar active strip dropped the instance, and on a FIRST turn (no warm cache
 * yet) it disappeared entirely.
 *
 * The flag is deliberately NOT derived on the client from an unanswered tool call. The top
 * bar holds no messages for instances the user never opened this session, which is exactly
 * the case that broke, and a reload would wipe it. Server-persisted survives the kill, a
 * server restart, and a reload.
 */
export function markAwaitingInput(instanceId: string, kind: AwaitingInputKind): void {
  const at = Date.now()
  const res = db.prepare(
    'UPDATE instances SET awaiting_input = ?, awaiting_input_at = ? WHERE id = ?'
  ).run(kind, at, instanceId)
  if (res.changes === 0) return

  broadcastEvent({
    type: 'instance:awaiting-input',
    payload: { instanceId, awaitingInput: kind, awaitingInputAt: at },
  })
}

/**
 * The user is no longer being waited on: a new turn is spawning (they answered, approved,
 * rejected, or just said something else), or the instance was explicitly stopped, paused or
 * reset.
 *
 * Clearing on SPAWN rather than on each answer route is deliberate: spawn is the single
 * choke point every resumed turn passes through, so no caller can forget and strand an
 * instance amber forever. The broadcast is skipped when nothing was set, so the ordinary
 * turn does not add a WS message.
 */
export function clearAwaitingInput(instanceId: string): void {
  const res = db.prepare(
    'UPDATE instances SET awaiting_input = NULL, awaiting_input_at = NULL WHERE id = ? AND awaiting_input IS NOT NULL'
  ).run(instanceId)
  if (res.changes === 0) return

  broadcastEvent({
    type: 'instance:awaiting-input',
    payload: { instanceId, awaitingInput: null, awaitingInputAt: null },
  })
}
