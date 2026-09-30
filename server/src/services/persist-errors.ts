// One place for a failed write on the path that saves a chat.
//
// The message, the session id and the turn's cost used to be written inside empty
// `catch { /* non-critical */ }` blocks. A busy or full disk then dropped the user's prompt,
// the session the chat resumes from, or what a turn cost, and nothing anywhere said so: not
// the log, not the screen. None of those writes is worth crashing a turn over, so they still
// do not throw, but each failure now does two things:
//
//   1. a log line naming the write that failed, the chat, and the error;
//   2. a `server:error` event to every open tab, in plain words, so the user can see that
//      something was not saved while it still matters.
//
// Both are throttled per write site (the same broken disk fails every write on every turn),
// so a persistent failure logs once, then at most once a minute with a count, instead of
// flooding the log and the screen.

import { broadcastEvent } from '../ws/handler.js'

export type PersistSite =
  | 'user-message'
  | 'assistant-message'
  | 'system-note'
  | 'retry-message'
  | 'routine-message'
  | 'session-id'
  | 'turn-cost'
  | 'turn-cost-context'
  | 'final-message'
  | 'process'

/** What the user reads for each site. Plain language: the people using this are not coders. */
const USER_TEXT: Record<PersistSite, string> = {
  'user-message': 'A message could not be saved to the chat history.',
  'assistant-message': 'A reply could not be saved to the chat history. It may be missing after a reload.',
  'system-note': 'A status note could not be saved to the chat history.',
  'retry-message': 'The automatic retry could not be saved to the chat history.',
  'routine-message': 'A scheduled card\'s message could not be saved to the chat history.',
  'session-id': 'The chat\'s conversation link could not be saved, so reopening it later may start a fresh conversation.',
  'turn-cost': 'The cost of a turn could not be saved, so the usage figures may be low.',
  'turn-cost-context': 'Part of a turn\'s cost details could not be read, so its running total may be off.',
  'final-message': 'The last reply could not be saved to the chat history.',
  'process': 'Something went wrong inside OrcStrator. It kept running; details are in the server log.',
}

/** One log line per site per window; the rest are counted and reported with the next one. */
const LOG_WINDOW_MS = 60_000

interface SiteState { lastLoggedAt: number; suppressed: number }
const sites = new Map<string, SiteState>()

export interface PersistFailureContext {
  instanceId?: string | null
  /** Anything else that helps find the row later (a message id, a card id). */
  detail?: string
  /** The caller already logged it (with a stack): only the screen still needs telling. */
  alreadyLogged?: boolean
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  try { return String(err) } catch { return 'unknown error' }
}

/**
 * Report a failed write on the chat-saving path. Never throws: it is called from inside
 * catch blocks on hot paths, and a report that could itself fail would bring back exactly
 * the silent drop it exists to end.
 */
export function reportPersistFailure(site: PersistSite, err: unknown, ctx: PersistFailureContext = {}): void {
  try {
    const now = Date.now()
    // Per site AND chat: a failure in chat B right after one in chat A must still reach chat B.
    const key = `${site}:${ctx.instanceId ?? ''}`
    const state = sites.get(key) ?? { lastLoggedAt: 0, suppressed: 0 }
    const who = ctx.instanceId ? ` chat ${ctx.instanceId.slice(0, 8)}` : ''
    const extra = ctx.detail ? ` (${ctx.detail})` : ''
    if (now - state.lastLoggedAt < LOG_WINDOW_MS) {
      state.suppressed++
      sites.set(key, state)
      return
    }
    const more = state.suppressed > 0 ? ` [${state.suppressed} more like this since the last report]` : ''
    if (!ctx.alreadyLogged) console.error(`[persist] ${site} write failed for${who || ' the server'}${extra}: ${errorText(err)}${more}`)
    state.lastLoggedAt = now
    state.suppressed = 0
    sites.set(key, state)
    broadcastEvent({
      type: 'server:error',
      payload: {
        site,
        instanceId: ctx.instanceId ?? null,
        message: USER_TEXT[site],
        detail: errorText(err).slice(0, 300),
        at: now,
      },
    })
  } catch { /* the report is best effort by definition: see the doc comment */ }
}

/** For tests: forget the throttle so each check starts clean. */
export function resetPersistFailureThrottle(): void {
  sites.clear()
}
