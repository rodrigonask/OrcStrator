/**
 * A `?limit=` from a request, clamped to 1..max. SQLite treats a negative LIMIT as
 * "no limit", so `Math.min(n, max)` alone let `?limit=-1` pull a whole table in one query.
 */
export function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(Math.trunc(n), max))
}

/** Request bodies are capped at 1 MB. The few routes that carry pasted images
 *  (a message with screenshots, a card with attachments) opt in to this larger ceiling. */
export const DEFAULT_BODY_LIMIT = 1024 * 1024
export const LARGE_BODY_LIMIT = 20 * 1024 * 1024
