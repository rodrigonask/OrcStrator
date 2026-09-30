#!/usr/bin/env node
// OrcStrator — PostToolUse context-compaction hook.
//
// Reads a Claude Code PostToolUse payload on stdin and, when it can SAFELY shrink the tool
// result, prints { hookSpecificOutput: { hookEventName, updatedToolOutput } } on stdout so the
// CLI replaces what the model sees. Requires claude >= 2.1.119 for built-in tools.
//
// Design rules (in priority order):
//   1. FAIL-SAFE. Any error, or any output we don't recognise, => print nothing and exit 0.
//      The original tool output then passes through untouched. We never break a tool result.
//   2. LOSSLESS where possible. JSON is only MINIFIED (whitespace removed) — same bytes, fewer
//      tokens. We never reorder/tabularise (that's a Tier-4 idea, deliberately excluded).
//   3. REVERSIBLE when lossy. When we drop/elide content (logs, base64 images, oversized text)
//      we write the verbatim original to <data dir>/ccr/<hash>.txt and point the model at
//      that file so it can Read the full thing if it ever needs the elided detail.
//   4. CHEAP. Below MIN_CHARS we don't touch anything (small outputs aren't worth a cache bust).
//
// Tiers implemented: Tier 1 (JSON minify) + Tier 2 (log dedup / ANSI strip / base64-image strip /
// oversized-text elision, all reversible). Nothing else.

import { mkdirSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const MIN_CHARS = 3000        // leave anything smaller than ~750 tokens alone
const MAX_TEXT_CHARS = 12000  // ceiling for a single text/log result after compaction (~3k tokens)
const KEEP_HEAD = 60          // lines kept at the top when eliding a long log
const KEEP_TAIL = 40          // lines kept at the bottom
// Same data dir the server uses (server/src/config.ts): ORCSTRATOR_DATA_DIR when set, which
// reaches this hook through the CLI's inherited environment, else ~/.orcstrator-v2.
const DATA_DIR = process.env.ORCSTRATOR_DATA_DIR || join(homedir(), '.orcstrator-v2')
const CCR_DIR = join(DATA_DIR, 'ccr')
const TELEMETRY_PATH = process.env.ORCSTRATOR_COMPACTION_LOG || join(DATA_DIR, 'compaction-log.jsonl')
// Lossless mode (the DEFAULT) keeps every transform that preserves what the model can actually
// read, but SKIPS the lossy head/tail elision. Only ORCSTRATOR_COMPACTION_LOSSLESS=0 re-enables it.
const LOSSLESS = process.env.ORCSTRATOR_COMPACTION_LOSSLESS !== '0'

// --- reversible store -------------------------------------------------------------------------
function stash(original) {
  // Write the verbatim original keyed by content hash; return its absolute path (or null).
  try {
    if (!existsSync(CCR_DIR)) mkdirSync(CCR_DIR, { recursive: true })
    const hash = createHash('sha256').update(original).digest('hex').slice(0, 12)
    const file = join(CCR_DIR, `${hash}.txt`)
    if (!existsSync(file)) writeFileSync(file, original, 'utf8')
    return file
  } catch {
    return null
  }
}

function note(beforeLen, afterLen, file) {
  const where = file ? ` · full output: ${file}` : ''
  return `\n[orcstrator: compacted ${beforeLen}→${afterLen} chars${where} — Read that file for any elided detail]`
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g

// --- core: compact one text blob -> compacted text, or null to leave it unchanged -------------
function compactText(text) {
  if (typeof text !== 'string' || text.length < MIN_CHARS) return null

  // (1) JSON -> minify. Lossless. Only if it round-trips and meaningfully shrinks. Return the
  //     FULL minified string (never slice JSON — that would produce invalid JSON in context).
  const trimmed = text.trim()
  if (/^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) {
    try {
      const min = JSON.stringify(JSON.parse(trimmed))
      if (min.length <= text.length * 0.9) return min
    } catch {
      /* not valid JSON — fall through to text handling */
    }
  }

  let work = text
  let changed = false

  // (2) base64 image payloads -> strip (Playwriter screenshots, inline data URIs).
  work = work.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{200,}/g, (m) => {
    changed = true
    return `[image stripped: ${m.length} base64 chars]`
  })
  // Bare, very long base64 runs (no data: prefix). Conservative length so we don't eat normal text.
  work = work.replace(/[A-Za-z0-9+/]{800,}={0,2}/g, (m) => {
    changed = true
    return `[base64 blob stripped: ${m.length} chars]`
  })

  // (3) logs/console: strip ANSI colour codes, collapse runs of identical lines.
  if (ANSI.test(work)) {
    work = work.replace(ANSI, '')
    changed = true
  }
  const lines = work.split('\n')
  const collapsed = []
  for (let i = 0; i < lines.length; ) {
    let j = i + 1
    while (j < lines.length && lines[j] === lines[i]) j++
    const run = j - i
    if (run > 1) changed = true
    collapsed.push(run > 1 ? `${lines[i]}  [×${run}]` : lines[i])
    i = j
  }
  let out = collapsed.join('\n')

  // (4) still oversized -> head+tail elision (or hard slice for a single huge line), reversible.
  // LOSSY — skipped in lossless mode (the default); there we never drop the middle of an output.
  if (!LOSSLESS && out.length > MAX_TEXT_CHARS) {
    const cl = out.split('\n')
    const file = stash(text)
    if (cl.length > KEEP_HEAD + KEEP_TAIL + 5) {
      const head = cl.slice(0, KEEP_HEAD).join('\n')
      const tail = cl.slice(-KEEP_TAIL).join('\n')
      const elided = cl.length - KEEP_HEAD - KEEP_TAIL
      out = `${head}\n[… ${elided} lines elided …]\n${tail}${note(text.length, head.length + tail.length, file)}`
    } else {
      out = out.slice(0, MAX_TEXT_CHARS) + note(text.length, MAX_TEXT_CHARS, file)
    }
    return out
  }

  if (!changed) return null
  // We stripped images/ANSI/dupes but stayed under the ceiling. If anything irreversible was
  // dropped (images/base64), leave a pointer to the original; ANSI/dupe removal is recoverable
  // enough not to need one, but a pointer never hurts.
  const file = stash(text)
  return out + note(text.length, out.length, file)
}

// --- apply compaction to a tool_response of unknown shape, preserving that shape ---------------
function compactResponse(resp) {
  if (typeof resp === 'string') {
    const c = compactText(resp)
    return c == null ? { changed: false, value: resp } : { changed: true, value: c }
  }
  if (resp && typeof resp === 'object') {
    let changed = false
    const out = Array.isArray(resp) ? resp.slice() : { ...resp }

    // MCP tool results: { content: [{ type:'text', text }, ...] }
    if (Array.isArray(out.content)) {
      out.content = out.content.map((blk) => {
        if (blk && typeof blk === 'object' && typeof blk.text === 'string') {
          const c = compactText(blk.text)
          if (c != null) {
            changed = true
            return { ...blk, text: c }
          }
        }
        return blk
      })
    }

    // Bash / generic string-bearing fields.
    for (const key of ['stdout', 'stderr', 'output', 'result', 'text', 'data']) {
      if (typeof out[key] === 'string') {
        const c = compactText(out[key])
        if (c != null) {
          out[key] = c
          changed = true
        }
      }
    }

    // `file.content` (a Read result) is NEVER touched. An agent that reads a file has to
    // see the bytes on disk: a collapsed blank line or a minified package.json makes its next
    // Edit miss, or its next Write save the altered text back over the user's file.

    return { changed, value: out }
  }
  return { changed: false, value: resp }
}

/**
 * Only command and MCP output is ever compacted. The settings file already limits the
 * matcher to these tools; this is the second line, for a settings file written by an older build
 * with `matcher: '*'`. Read, Edit, Write, Grep, Glob and the rest pass through byte for byte.
 *
 * Also skipped: a command that reads a file back out of the CCR folder. That folder holds the
 * verbatim originals this hook points the model at, and compacting the way back in would defeat
 * the whole "Read that file for any elided detail" promise.
 */
const COMPACTABLE_TOOL = /^(Bash|PowerShell|mcp__.+)$/
export function shouldCompact(payload) {
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  if (!COMPACTABLE_TOOL.test(tool)) return false
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? JSON.stringify(payload.tool_input) : ''
  const ccr = CCR_DIR.replace(/\\/g, '/').toLowerCase()
  if (input && input.replace(/\\\\/g, '/').toLowerCase().includes(ccr)) return false
  if (input && /[\\/]ccr[\\/][0-9a-f]{12}\.txt/i.test(input)) return false
  return true
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function sizeOf(x) {
  if (typeof x === 'string') return x.length
  try {
    return JSON.stringify(x).length
  } catch {
    return 0
  }
}

// Best-effort telemetry: one JSONL line per compaction, ingested by the server for the cost
// tab's savings card. Never throws — telemetry must not break a tool result.
function logSaving(payload, beforeChars, afterChars) {
  try {
    const rec = {
      ts: Date.now(),
      session_id: typeof payload.session_id === 'string' ? payload.session_id : null,
      tool_name: typeof payload.tool_name === 'string' ? payload.tool_name : null,
      before_chars: beforeChars,
      after_chars: afterChars,
    }
    appendFileSync(TELEMETRY_PATH, JSON.stringify(rec) + '\n')
  } catch {
    /* ignore */
  }
}

async function main() {
  const raw = await readStdin()
  if (!raw) return
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return
  }
  if (!payload || payload.tool_response === undefined) return
  if (!shouldCompact(payload)) return
  const beforeChars = sizeOf(payload.tool_response)
  const { changed, value } = compactResponse(payload.tool_response)
  if (!changed) return
  logSaving(payload, beforeChars, sizeOf(value))
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: value },
    }),
  )
}

main().catch(() => {
  /* fail-safe: never break a tool result */
  process.exit(0)
})
