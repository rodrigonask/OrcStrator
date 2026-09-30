// The surrogate repair streams the transcript instead of loading it whole, writes a
// temp file and renames it over the original (never an in-place overwrite), and a failed
// repair or image strip is logged once per file instead of vanishing. Transcripts are
// synthetic, in a temp home folder.
//
//   npx tsx server/test/surrogate-repair.test.ts

import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-surr-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR

const { check, done } = await import('./helpers/scratch-app.js')
const sanitizer = await import('../src/services/session-sanitizer.js')

const cwd = path.join(fakeHome, 'work', 'demo')
const slugDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
fs.mkdirSync(slugDir, { recursive: true })
const same = (a: unknown, b: string) => typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

// Spies on the promise-based file calls both versions use.
let readWhole: string[] = []
let writeWhole: string[] = []
let renames: Array<[string, string]> = []
let failRenameTo: string | null = null
const f = fsp as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
const realReadFile = f.readFile, realWriteFile = f.writeFile, realRename = f.rename
f.readFile = (...a) => { readWhole.push(String(a[0])); return realReadFile.apply(fsp, a) }
f.writeFile = (...a) => { writeWhole.push(String(a[0])); return realWriteFile.apply(fsp, a) }
f.rename = (...a) => {
  renames.push([String(a[0]), String(a[1])])
  if (failRenameTo && same(a[1], failRenameTo)) return Promise.reject(new Error('EPERM: simulated lock on the file'))
  return realRename.apply(fsp, a)
}

// Every log line, so "logged once" can be counted.
const logs: string[] = []
for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level]
  console[level] = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); orig.apply(console, args) }
}

const HIGH = '\\ud83d' // a lone high surrogate, as the JSON escape the CLI writes
const PAIR = '\\ud83d\\ude00' // a valid pair (an emoji)
const lines = [
  JSON.stringify({ type: 'user', message: { content: 'plain line' } }),
  `{"type":"user","message":{"content":"cut emoji ${HIGH} here"}}`,
  `{"type":"assistant","message":{"content":"whole emoji ${PAIR} kept"}}`,
]

// ── the repair: streamed, atomic ───────────────────────────────────────────────────────
{
  const sid = crypto.randomUUID()
  const file = path.join(slugDir, `${sid}.jsonl`)
  const original = lines.join('\n') + '\n'
  fs.writeFileSync(file, original)
  readWhole = []; writeWhole = []; renames = []
  const r = await sanitizer.sanitizeSurrogates(cwd, sid)
  const after = fs.readFileSync(file, 'utf8')
  const afterLines = after.split('\n')
  check('setup: the lone surrogate is removed and everything else is kept',
    r.ok === true && r.affectedLines === 1 && !after.includes(`${HIGH} here`) && after.includes(PAIR) &&
    afterLines[0] === lines[0] && afterLines[2] === lines[2] && after.endsWith('\n'),
    JSON.stringify({ ok: r.ok, affectedLines: r.affectedLines, error: r.error }))
  check('setup: a backup of the original is kept', !!r.backupPath && fs.existsSync(r.backupPath) && fs.readFileSync(r.backupPath, 'utf8') === original,
    String(r.backupPath))
  check('the transcript is never loaded whole into memory', !readWhole.some(p => same(p, file)),
    `${readWhole.filter(p => same(p, file)).length} whole-file read(s)`)
  check('the transcript is never overwritten in place: a temp file is renamed over it',
    !writeWhole.some(p => same(p, file)) && renames.some(([from, to]) => same(to, file) && !same(from, file)),
    `in-place writes ${writeWhole.filter(p => same(p, file)).length}, renames onto it ${renames.filter(([, to]) => same(to, file)).length}`)
}

// ── a failed repair is reported and logged ─────────────────────────────────────────────
{
  const sid = crypto.randomUUID()
  const file = path.join(slugDir, `${sid}.jsonl`)
  const original = lines.join('\n') + '\n'
  fs.writeFileSync(file, original)
  failRenameTo = file
  logs.length = 0
  const r = await sanitizer.sanitizeSurrogates(cwd, sid)
  failRenameTo = null
  const mentions = logs.filter(l => l.includes(sid)).length
  check('a repair that cannot finish says so, leaves the file as it was, and is logged',
    r.ok === false && fs.readFileSync(file, 'utf8') === original && mentions === 1,
    JSON.stringify({ ok: r.ok, error: r.error, logLines: mentions }))
  const leftovers = fs.readdirSync(slugDir).filter(n => n.startsWith(sid) && !n.endsWith('.jsonl') && !/\.bak-\d+$/.test(n))
  check('a failed repair leaves no temp file behind', leftovers.length === 0, leftovers.join(', '))
}

// ── the image strip: failures logged once per file ──────────────────────────────────────
{
  const sid = crypto.randomUUID()
  const file = path.join(slugDir, `${sid}.jsonl`)
  const img = { type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4000) } }] } }
  const original = JSON.stringify(img) + '\n'
  fs.writeFileSync(file, original)
  failRenameTo = file
  logs.length = 0
  await sanitizer.sanitizeSession(cwd, sid)
  await sanitizer.sanitizeSession(cwd, sid)
  await sanitizer.sanitizeSession(cwd, sid)
  failRenameTo = null
  const mentions = logs.filter(l => l.includes(sid)).length
  check('an image strip that fails is logged, once for the file, not on every turn', mentions === 1, `${mentions} log line(s) over 3 failed passes`)
  check('setup: the failed strip left the transcript untouched', fs.readFileSync(file, 'utf8') === original)
  await sanitizer.sanitizeSession(cwd, sid)
  check('setup: once the file can be written the strip goes through', !fs.readFileSync(file, 'utf8').includes('A'.repeat(4000)))
}

fs.rmSync(fakeHome, { recursive: true, force: true })
done()
