import { existsSync, statSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from '../config.js'
import { db } from '../db.js'
import { resolvePricing, MODEL_PRICING } from '@orcstrator/shared'
import type { CompactionSavingsDay, CompactionSavingsSummary } from '@orcstrator/shared'
import { compactionEnabled } from './hook-injector.js'

// The JSONL telemetry log the PostToolUse compaction hook appends to (one line per compaction).
const LOG_PATH = join(DATA_DIR, 'compaction-log.jsonl')
// Chars→tokens divisor for the savings ESTIMATE. Minified JSON is denser (~3), prose/logs looser
// (~4); 3.8 is a deliberately middle-conservative figure. Surfaced in the API for transparency.
const CHARS_PER_TOKEN = 3.8
const OFFSET_KEY = 'compactionLogOffset'

function getOffset(): number {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(OFFSET_KEY) as { value: string } | undefined
    return row ? Number(JSON.parse(row.value)) || 0 : 0
  } catch {
    return 0
  }
}

function setOffset(n: number): void {
  try {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(OFFSET_KEY, JSON.stringify(n))
  } catch {
    /* non-critical */
  }
}

// Prepared statements are created lazily INSIDE the functions below, never at module load:
// `db` is only assigned when initDb() runs, and this module is imported (via the usage route)
// before that — touching db.prepare at top level would crash startup. better-sqlite3 caches by
// SQL text, so per-call prepare is effectively free.

// Synchronous by design: with no `await` inside, concurrent callers can't interleave, so the
// byte-offset cursor stays consistent without locking. Reads only the new tail of the log.
export function ingestCompactionLog(): void {
  try {
    if (!existsSync(LOG_PATH)) return
    const size = statSync(LOG_PATH).size
    let offset = getOffset()
    if (offset > size) offset = 0 // log was rotated/truncated under us
    if (offset >= size) return // nothing new

    const len = size - offset
    const buf = Buffer.alloc(len)
    const fd = openSync(LOG_PATH, 'r')
    try {
      readSync(fd, buf, 0, len, offset)
    } finally {
      closeSync(fd)
    }
    const text = buf.toString('utf8')
    const lastNl = text.lastIndexOf('\n')
    if (lastNl === -1) return // no complete line yet (hook mid-write)
    const consumed = text.slice(0, lastNl + 1)
    const lines = consumed.split('\n').filter(Boolean)

    const insertRow = db.prepare(`
      INSERT INTO compaction_savings
        (created_at, session_id, instance_id, folder_id, model, tool_name, before_chars, after_chars, saved_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const instBySession = db.prepare('SELECT id, folder_id, ctx_model FROM instances WHERE session_id = ?')

    const tx = db.transaction((rows: string[]) => {
      for (const line of rows) {
        let rec: Record<string, unknown>
        try {
          rec = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const before = Number(rec.before_chars) || 0
        const after = Number(rec.after_chars) || 0
        const saved = Math.max(0, Math.round((before - after) / CHARS_PER_TOKEN))
        const sid = typeof rec.session_id === 'string' ? rec.session_id : null
        let instanceId: string | null = null
        let folderId: string | null = null
        let model: string | null = null
        if (sid) {
          const inst = instBySession.get(sid) as { id: string; folder_id: string; ctx_model: string | null } | undefined
          if (inst) {
            instanceId = inst.id
            folderId = inst.folder_id
            model = inst.ctx_model ?? null
          }
        }
        insertRow.run(
          Number(rec.ts) || Date.now(),
          sid,
          instanceId,
          folderId,
          model,
          typeof rec.tool_name === 'string' ? rec.tool_name : null,
          before,
          after,
          saved,
        )
      }
    })
    tx(lines)
    setOffset(offset + Buffer.byteLength(consumed, 'utf8'))
  } catch (err) {
    console.warn('[compaction-savings] ingest failed:', err)
  }
}

export function getCompactionSavingsSummary(since: number): CompactionSavingsSummary {
  const dayRows = db.prepare(`
    SELECT date(created_at / 1000, 'unixepoch') AS day,
      COUNT(*) AS compactions,
      COALESCE(SUM(before_chars), 0) AS before_chars,
      COALESCE(SUM(after_chars), 0) AS after_chars,
      COALESCE(SUM(saved_tokens), 0) AS saved_tokens
    FROM compaction_savings
    WHERE created_at >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(since) as Array<Record<string, number | string>>

  // Dollar value per (day, model) at that model's INPUT rate, counted once = conservative
  // (ignores the smaller recurring cache-read savings on later turns).
  const dayModelRows = db.prepare(`
    SELECT date(created_at / 1000, 'unixepoch') AS day, model, COALESCE(SUM(saved_tokens), 0) AS saved_tokens
    FROM compaction_savings
    WHERE created_at >= ?
    GROUP BY day, model
  `).all(since) as Array<{ day: string; model: string | null; saved_tokens: number }>

  const usdByDay = new Map<string, number>()
  let totalSavedUsd = 0
  for (const r of dayModelRows) {
    const p = resolvePricing(r.model) ?? MODEL_PRICING['opus-4-7']
    const usd = ((Number(r.saved_tokens) || 0) * p.input) / 1_000_000
    usdByDay.set(r.day, (usdByDay.get(r.day) || 0) + usd)
    totalSavedUsd += usd
  }

  const days: CompactionSavingsDay[] = dayRows.map((r) => ({
    day: r.day as string,
    compactions: Number(r.compactions) || 0,
    beforeChars: Number(r.before_chars) || 0,
    afterChars: Number(r.after_chars) || 0,
    savedTokens: Number(r.saved_tokens) || 0,
    savedUsd: +(usdByDay.get(r.day as string) || 0).toFixed(4),
  }))

  return {
    days,
    totalCompactions: days.reduce((s, d) => s + d.compactions, 0),
    totalBeforeChars: days.reduce((s, d) => s + d.beforeChars, 0),
    totalAfterChars: days.reduce((s, d) => s + d.afterChars, 0),
    totalSavedTokens: days.reduce((s, d) => s + d.savedTokens, 0),
    totalSavedUsd: +totalSavedUsd.toFixed(4),
    charsPerToken: CHARS_PER_TOKEN,
    enabled: compactionEnabled(),
  }
}
