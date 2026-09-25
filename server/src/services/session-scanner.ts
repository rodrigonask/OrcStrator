import fs from 'fs'
import path from 'path'
import os from 'os'
import readline from 'readline'
import { db } from '../db.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ScanResult {
  imported: number
  scanned: number
  errors: number
}

/**
 * Scan ~/.claude/projects for .jsonl session files not yet tracked in token_usage.
 * Extract usage from the last 'result' line and insert with role='direct'.
 */
export async function scanUntrackedSessions(): Promise<ScanResult> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  const result: ScanResult = { imported: 0, scanned: 0, errors: 0 }

  if (!fs.existsSync(projectsDir)) return result

  const jsonlFiles = collectJsonlFiles(projectsDir, 0, 3)

  const checkStmt = db.prepare('SELECT 1 FROM token_usage WHERE session_id = ?')
  const insertStmt = db.prepare(`
    INSERT INTO token_usage (session_id, instance_id, role, task_id, prompt_chars, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, is_overdrive_session, created_at)
    VALUES (?, NULL, 'direct', NULL, 0, ?, ?, ?, ?, ?, 0, ?)
  `)

  for (const filePath of jsonlFiles) {
    const sessionId = path.basename(filePath, '.jsonl')
    if (!UUID_RE.test(sessionId)) continue

    result.scanned++

    if (checkStmt.get(sessionId)) continue

    try {
      const usage = await extractUsageFromJsonl(filePath)
      if (!usage) continue

      const stat = fs.statSync(filePath)
      const createdAt = stat.mtimeMs

      insertStmt.run(
        sessionId,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheCreationTokens,
        usage.costUsd,
        Math.round(createdAt),
      )
      result.imported++
    } catch {
      result.errors++
    }
  }

  return result
}

function collectJsonlFiles(dir: string, depth: number, maxDepth: number): string[] {
  if (depth > maxDepth) return []
  const files: string[] = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectJsonlFiles(fullPath, depth + 1, maxDepth))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath)
    }
  }

  return files
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
