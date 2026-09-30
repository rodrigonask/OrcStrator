import fs from 'fs'
import readline from 'readline'
import { db } from '../db.js'
import { getSessionIndex } from './session-index.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ScanResult {
  imported: number
  scanned: number
  errors: number
  /** Transcripts skipped because they were read before, had nothing to import, and have not changed since. */
  unchanged?: number
}

/**
 * Transcripts already read in full that held no usage line, keyed by session id, with the
 * size and mtime they had at the time.
 *
 * A session is skipped only once it has a token_usage row, and a CLI transcript
 * never gets one (it contains no "type":"result" line at all: 0 of a 200-file sample did).
 * So every click of "Sync untracked sessions" re-streamed the entire transcript store,
 * gigabytes of it, to learn the same nothing again. A file that has not changed since it
 * came up empty is now skipped; one that grew or was rewritten is read again.
 *
 * In memory on purpose: the worst case after a restart is one full pass, which is what every
 * click used to cost, and it needs no new table.
 */
const emptyReads = new Map<string, { mtime: number; size: number }>()

/**
 * Scan ~/.claude/projects for .jsonl session files not yet tracked in token_usage.
 * Extract usage from the last 'result' line and insert with role='direct'.
 */
export async function scanUntrackedSessions(): Promise<ScanResult> {
  const result: ScanResult = { imported: 0, scanned: 0, errors: 0, unchanged: 0 }

  // The shared transcript index (session-index.ts): an asynchronous walk that already holds
  // each file's size and mtime, instead of a second synchronous walk of the same tree.
  const entries = await getSessionIndex(true)

  const checkStmt = db.prepare('SELECT 1 FROM token_usage WHERE session_id = ?')
  const insertStmt = db.prepare(`
    INSERT INTO token_usage (session_id, instance_id, role, task_id, prompt_chars, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, is_overdrive_session, created_at)
    VALUES (?, NULL, 'direct', NULL, 0, ?, ?, ?, ?, ?, 0, ?)
  `)

  for (const entry of entries) {
    const { sessionId, filePath, mtime, size } = entry
    if (!UUID_RE.test(sessionId)) continue

    result.scanned++

    if (checkStmt.get(sessionId)) continue

    const seen = emptyReads.get(sessionId)
    if (seen && seen.mtime === mtime && seen.size === size) {
      result.unchanged!++
      continue
    }

    try {
      const usage = await extractUsageFromJsonl(filePath)
      if (!usage) {
        emptyReads.set(sessionId, { mtime, size })
        continue
      }
      emptyReads.delete(sessionId)

      insertStmt.run(
        sessionId,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheCreationTokens,
        usage.costUsd,
        Math.round(mtime),
      )
      result.imported++
    } catch {
      result.errors++
    }
  }

  return result
}

interface UsageData {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
}

async function extractUsageFromJsonl(filePath: string): Promise<UsageData | null> {
  // Read the file line by line, find the last 'result' type line
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  let lastResultLine: string | null = null

  for await (const line of rl) {
    if (line.includes('"type":"result"') || line.includes('"type": "result"')) {
      lastResultLine = line
    }
  }

  if (!lastResultLine) return null

  try {
    const parsed = JSON.parse(lastResultLine)
    const usage = parsed.usage || parsed.result?.usage
    const costUsd = parsed.total_cost_usd ?? parsed.costUsd ?? parsed.cost_usd ?? 0

    if (!usage) return null

    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? 0,
      costUsd: Number(costUsd) || 0,
    }
  } catch {
    return null
  }
}
