// Live, in-memory progress for the current turn of each running instance: when it
// started + how many output tokens have been generated so far. Powers the composer's
// CLI-style "elapsed · ↓ tokens" footer. Purely ephemeral — there's one entry per
// in-flight turn and it's deleted the moment the turn ends. /state hydrates from this
// so the timer survives a page reload mid-turn; nothing is persisted to the DB.

export interface TurnProgress {
  /** epoch ms the turn started (process spawn) */
  startedAt: number
  /** sum of per-step assistant output_tokens seen so far this turn */
  outputTokens: number
}

const store = new Map<string, TurnProgress>()

/** Begin tracking a fresh turn for this instance (replaces any stale entry). */
export function startTurn(instanceId: string): TurnProgress {
  const tp: TurnProgress = { startedAt: Date.now(), outputTokens: 0 }
  store.set(instanceId, tp)
  return tp
}

/** Add a step's output tokens to the running total. No-op if the turn isn't tracked. */
export function addTurnOutput(instanceId: string, delta: number): TurnProgress | undefined {
  const tp = store.get(instanceId)
  if (!tp) return undefined
  if (Number.isFinite(delta) && delta > 0) tp.outputTokens += delta
  return tp
}

export function getTurnProgress(instanceId: string): TurnProgress | undefined {
  return store.get(instanceId)
}

/** Stop tracking — the turn has ended (clean exit, kill, or pause). */
export function endTurn(instanceId: string): void {
  store.delete(instanceId)
}
