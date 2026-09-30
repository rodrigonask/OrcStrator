// The transcript folder is walked without blocking the event loop, a
// lookup for a session that is not there is not answered by a fresh walk every time, and
// "Sync untracked sessions" does not re-read transcripts it already found nothing in.
// The transcripts are synthetic, in a temp home folder; nothing real is read.
//
//   npx tsx server/test/transcript-scans.test.ts

import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-scans-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR

const projects = path.join(fakeHome, '.claude', 'projects')
const slugDir = path.join(projects, 'C--work-demo')
fs.mkdirSync(slugDir, { recursive: true })
const EMPTY_COUNT = 12
const emptyIds: string[] = []
for (let i = 0; i < EMPTY_COUNT; i++) {
  const id = crypto.randomUUID()
  emptyIds.push(id)
  // A real CLI transcript: user and assistant lines, and no "type":"result" line anywhere.
  fs.writeFileSync(path.join(slugDir, `${id}.jsonl`),
    JSON.stringify({ type: 'user', cwd: 'C:\\work\\demo', message: { content: 'hi' } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }) + '\n')
}
const resultId = crypto.randomUUID()
fs.writeFileSync(path.join(slugDir, `${resultId}.jsonl`),
  JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 }) + '\n')

const { scratchApp, check, done } = await import('./helpers/scratch-app.js')
const { close } = await scratchApp([])

// Spies: every directory read and every transcript stream under the fake projects folder.
const under = (p: unknown) => typeof p === 'string' && path.resolve(p).toLowerCase().startsWith(projects.toLowerCase())
let syncDirReads: string[] = []
let rootWalks = 0
let streams: string[] = []
const realReaddirSync = fs.readdirSync
;(fs as unknown as Record<string, unknown>).readdirSync = (...args: unknown[]) => {
  if (under(args[0])) syncDirReads.push(String(args[0]))
  if (typeof args[0] === 'string' && path.resolve(args[0]).toLowerCase() === projects.toLowerCase()) rootWalks++
  return (realReaddirSync as (...a: unknown[]) => unknown).apply(fs, args)
}
const realReaddir = fsp.readdir
;(fsp as unknown as Record<string, unknown>).readdir = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && path.resolve(args[0]).toLowerCase() === projects.toLowerCase()) rootWalks++
  return (realReaddir as (...a: unknown[]) => unknown).apply(fsp, args)
}
const realStream = fs.createReadStream
;(fs as unknown as Record<string, unknown>).createReadStream = (...args: unknown[]) => {
  if (under(args[0])) streams.push(String(args[0]))
  return (realStream as (...a: unknown[]) => unknown).apply(fs, args)
}

const index = await import('../src/services/session-index.js')
const scanner = await import('../src/services/session-scanner.js')

// ── The walk is asynchronous ────────────────────────────────────────────────────────
{
  syncDirReads = []
  const entries = await index.getSessionIndex(true)
  check('setup: the index lists every synthetic transcript', entries.length === EMPTY_COUNT + 1, `${entries.length} entries`)
  check('building the Sessions index makes no synchronous directory reads', syncDirReads.length === 0,
    `${syncDirReads.length} readdirSync call(s)`)
}

// ── A miss is remembered for a few seconds ─────────────────────────────────────────
{
  const known = await index.findSessionEntry(emptyIds[0])
  check('a session that exists is still found', known?.sessionId === emptyIds[0])
  const ghost = crypto.randomUUID()
  const first = await index.findSessionEntry(ghost)
  check('a session that does not exist is reported missing', first === null)
  rootWalks = 0
  const second = await index.findSessionEntry(ghost)
  check('looking up the same missing session again does not walk the whole folder again',
    second === null && rootWalks === 0, `${rootWalks} walk(s) of the projects folder`)
}

// ── Transcripts that held nothing are not re-read while unchanged ─────────────────
{
  streams = []
  const r1 = await scanner.scanUntrackedSessions()
  check('setup: the first sync reads every transcript and imports the one with usage',
    r1.imported === 1 && streams.length === EMPTY_COUNT + 1, `imported ${r1.imported}, read ${streams.length}`)

  streams = []
  const r2 = await scanner.scanUntrackedSessions()
  check('a second sync re-reads none of the unchanged transcripts', streams.length === 0 && r2.imported === 0,
    `read ${streams.length} file(s)`)

  const grown = path.join(slugDir, `${emptyIds[3]}.jsonl`)
  fs.appendFileSync(grown, JSON.stringify({ type: 'user', message: { content: 'more' } }) + '\n')
  streams = []
  await scanner.scanUntrackedSessions()
  check('after one transcript grows, a sync reads only that one again',
    streams.length === 1 && path.resolve(streams[0]).toLowerCase() === grown.toLowerCase(),
    `read ${streams.length} file(s)`)
}

await close()
fs.rmSync(fakeHome, { recursive: true, force: true })
done()
