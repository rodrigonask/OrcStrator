#!/usr/bin/env node
// Integration tests for compact-tool-output.mjs.
// Spawns the hook exactly as Claude Code would (JSON on stdin, JSON or nothing on stdout) and
// asserts behaviour per content type. Run: node server/hooks/test/run-tests.mjs

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'compact-tool-output.mjs')
// Redirect the hook's savings telemetry to a throwaway temp file so tests never pollute the
// real ~/.orcstrator-v2/compaction-log.jsonl that the server ingests into the cost tab.
process.env.ORCSTRATOR_COMPACTION_LOG = join(tmpdir(), `orcstrator-compaction-test-${process.pid}.jsonl`)
// The hook also writes verbatim originals under <home>/.orcstrator-v2/ccr. Give the spawned
// hook a throwaway home so a test run never writes into the real data dir.
const SCRATCH_HOME = join(tmpdir(), `orcstrator-hook-test-home-${process.pid}`)
mkdirSync(SCRATCH_HOME, { recursive: true })
process.env.HOME = SCRATCH_HOME
process.env.USERPROFILE = SCRATCH_HOME
// The default-path tests below must see the UNSET case, whatever the calling shell has.
delete process.env.ORCSTRATOR_DATA_DIR

function run(payload, extraEnv) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(extraEnv || {}) }
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
    const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'], env })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('close', (code) => resolve({ out, err, code }))
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

const big = (n, line) => Array.from({ length: n }, (_, i) => line(i)).join('\n')
let pass = 0
let fail = 0
const check = (name, cond, detail) => {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// 1) Pretty JSON array (string tool_response) -> minified, lossless, valid JSON, smaller.
{
  const arr = Array.from({ length: 80 }, (_, i) => ({
    id: i,
    name: `campaign ${i}`,
    status: i % 2 ? 'ACTIVE' : 'PAUSED',
    spend: i * 12.5,
    clicks: i * 3,
    nested: { region: 'us', tier: 'gold' },
  }))
  const text = JSON.stringify(arr, null, 2)
  const { out } = await run({ tool_name: 'Bash', tool_response: text })
  const parsed = out ? JSON.parse(out) : null
  const min = parsed?.hookSpecificOutput?.updatedToolOutput
  let valid = false
  try {
    valid = Array.isArray(JSON.parse(min)) && JSON.parse(min).length === 80
  } catch {
    /* invalid */
  }
  console.log(`\n[1] pretty JSON string: ${text.length} -> ${min ? min.length : 'unchanged'} chars`)
  check('produced replacement', !!min)
  check('minified is smaller', min && min.length < text.length, `${min?.length} !< ${text.length}`)
  check('minified is still valid+complete JSON (lossless)', valid)
}

// 2) Bash log: ANSI + duplicate lines + long -> ANSI stripped, dupes collapsed, elided + CCR file.
{
  const stdout =
    big(50, () => '\x1B[32mDownloading chunk...\x1B[0m') +
    '\n' +
    big(600, (i) => `processed record ${i} ok`) +
    '\n' +
    'ERROR: disk full'
  const { out } = await run({ tool_name: 'Bash', tool_response: { stdout, stderr: '', interrupted: false } })
  const obj = out ? JSON.parse(out).hookSpecificOutput.updatedToolOutput : null
  const newOut = obj?.stdout || ''
  const m = newOut.match(/full output: (.+?) —/)
  console.log(`\n[2] bash log: ${stdout.length} -> ${newOut.length || 'unchanged'} chars`)
  check('produced replacement object with stdout', !!newOut)
  check('shrunk', newOut && newOut.length < stdout.length, `${newOut.length} !< ${stdout.length}`)
  check('ANSI stripped', newOut && !/\x1B\[/.test(newOut))
  check('collapsed duplicate run', newOut && /\[×\d+\]/.test(newOut))
  check('kept the ERROR (tail)', newOut.includes('ERROR: disk full'))
  check('left a CCR pointer', !!m)
  check('CCR original file exists on disk', m ? existsSync(m[1]) : false, m?.[1])
  check('CCR defaults to <home>/.orcstrator-v2/ccr when ORCSTRATOR_DATA_DIR is unset',
    !!m && m[1].startsWith(join(SCRATCH_HOME, '.orcstrator-v2', 'ccr')), m?.[1])
}

// 2b) ORCSTRATOR_DATA_DIR moves both the CCR store and the default compaction log.
{
  const dataDir = join(tmpdir(), `orcstrator-hook-test-data-${process.pid}`)
  const stdout = big(700, (i) => `\x1B[33mline ${i % 3}\x1B[0m`) + '\nDONE'
  const { out } = await run(
    { tool_name: 'Bash', tool_response: { stdout, stderr: '', interrupted: false } },
    { ORCSTRATOR_DATA_DIR: dataDir, ORCSTRATOR_COMPACTION_LOG: undefined },
  )
  const newOut = out ? JSON.parse(out).hookSpecificOutput.updatedToolOutput?.stdout || '' : ''
  const m = newOut.match(/full output: (.+?) \u2014/)
  console.log(`\n[2b] ORCSTRATOR_DATA_DIR=${dataDir}`)
  check('CCR file lands under ORCSTRATOR_DATA_DIR/ccr', !!m && m[1].startsWith(join(dataDir, 'ccr')) && existsSync(m[1]), m?.[1])
  check('compaction log lands under ORCSTRATOR_DATA_DIR', existsSync(join(dataDir, 'compaction-log.jsonl')))
}

// 3) Inline base64 image (string) -> stripped, pointer left.
{
  const text = 'Screenshot captured:\n\ndata:image/png;base64,' + 'A'.repeat(4000) + '\n\ndone.'
  const { out } = await run({ tool_name: 'mcp__playwriter__execute', tool_response: text })
  const val = out ? JSON.parse(out).hookSpecificOutput.updatedToolOutput : null
  console.log(`\n[3] inline base64 image: ${text.length} -> ${val ? val.length : 'unchanged'} chars`)
  check('produced replacement', !!val)
  check('image stripped', val && val.includes('image stripped'))
  check('much smaller', val && val.length < 500)
}

// 4) Small output -> passthrough (hook prints nothing).
{
  const { out, code } = await run({ tool_name: 'Edit', tool_response: 'Applied 1 edit to file.ts' })
  console.log(`\n[4] small output: hook stdout = ${JSON.stringify(out)} (exit ${code})`)
  check('passed through untouched (no stdout)', out.trim() === '')
}

// 5) MCP content array with big pretty JSON in a text block -> that text minified.
{
  const inner = JSON.stringify(
    Array.from({ length: 60 }, (_, i) => ({ id: i, label: `row ${i}`, ok: true })),
    null,
    2,
  )
  const { out } = await run({
    tool_name: 'mcp__example__get_insights',
    tool_response: { content: [{ type: 'text', text: inner }], isError: false },
  })
  const val = out ? JSON.parse(out).hookSpecificOutput.updatedToolOutput : null
  const newText = val?.content?.[0]?.text || ''
  console.log(`\n[5] MCP content array: inner ${inner.length} -> ${newText.length || 'unchanged'} chars`)
  check('produced replacement preserving MCP shape', !!val && Array.isArray(val.content))
  check('inner text minified+smaller', newText && newText.length < inner.length)
  check('inner still valid JSON (lossless)', (() => { try { return JSON.parse(newText).length === 60 } catch { return false } })())
}

// 6) Malformed payload -> fail-safe, no output, clean exit.
{
  const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (c) => (out += c))
  const code = await new Promise((res) => {
    child.on('close', res)
    child.stdin.write('this is not json{{{')
    child.stdin.end()
  })
  console.log(`\n[6] malformed input: stdout = ${JSON.stringify(out)} (exit ${code})`)
  check('fail-safe: no output', out.trim() === '')
  check('fail-safe: clean exit 0', code === 0)
}

console.log(`\n${'='.repeat(40)}\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
