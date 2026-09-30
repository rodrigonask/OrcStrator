// Per-chat preferences kept in browser storage, and their cleanup.
//
// The composer remembers a chat's permission mode, model, effort, a pending model-switch note
// and an unsent draft, each under a key suffixed with the chat id. Nothing ever removed them,
// so every chat ever opened left five keys behind for good. They are dropped when a chat is
// deleted, and once per page load any key whose chat no longer exists is swept (a chat closed
// in another tab, or while this one was shut).

export const PERM_KEY = (id: string) => 'perm-' + id
export const DRAFT_KEY = (id: string) => 'draft-' + id
export const MODEL_KEY = (id: string) => 'model-' + id
export const EFFORT_KEY = (id: string) => 'effort-' + id
export const SWITCH_NOTE_KEY = (id: string) => 'switch-note-' + id

const LOCAL_KEYS = [PERM_KEY, MODEL_KEY, EFFORT_KEY, SWITCH_NOTE_KEY]
const SESSION_KEYS = [DRAFT_KEY]
// Only keys that end in a chat id are ours to sweep: a key like 'model-default' is not.
const CHAT_KEY_RE = /^(perm|draft|model|effort|switch-note)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

type KeyStore = Pick<Storage, 'removeItem' | 'key' | 'length'>

export function forgetChat(id: string, local: KeyStore = localStorage, session: KeyStore = sessionStorage): void {
  try {
    for (const k of LOCAL_KEYS) local.removeItem(k(id))
    for (const k of SESSION_KEYS) session.removeItem(k(id))
  } catch { /* storage unavailable: nothing to clean */ }
}

/** Remove per-chat keys whose chat is not in `liveIds`. Returns how many were removed. */
export function pruneChatKeys(liveIds: Set<string>, stores: KeyStore[] = [localStorage, sessionStorage]): number {
  let removed = 0
  for (const store of stores) {
    try {
      const doomed: string[] = []
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i)
        const m = key ? CHAT_KEY_RE.exec(key) : null
        if (m && !liveIds.has(m[2])) doomed.push(key!)
      }
      for (const key of doomed) store.removeItem(key)
      removed += doomed.length
    } catch { /* storage unavailable */ }
  }
  return removed
}
