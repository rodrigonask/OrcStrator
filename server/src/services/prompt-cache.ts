import { db } from '../db.js'
import type { CacheTtl } from '@orcstrator/shared'

// The 1-hour prompt cache is ON unless the promptCache1h setting is explicitly false.
// One gate for everything that depends on it: the ENABLE_PROMPT_CACHING_1H env at spawn,
// the cache-write rate a live turn is priced at, and the cache advisor's cold threshold.
// If they read the setting differently, the tracker bills a TTL the CLI never ran.
export function promptCache1hEnabled(): boolean {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'promptCache1h'").get() as { value: string } | undefined
    return !row || JSON.parse(row.value) !== false
  } catch {
    return true
  }
}

export function promptCacheTtl(): CacheTtl {
  return promptCache1hEnabled() ? '1h' : '5m'
}
