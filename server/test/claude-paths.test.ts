// One cwd-to-slug encoder and one projects folder for the whole server, and the
// real-casing cache remembers only paths that exist in full. Everything is in temp folders.
//
//   npx tsx server/test/claude-paths.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-paths-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR

const { check, done } = await import('./helpers/scratch-app.js')
const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

// ── one encoder, matching the CLI ──────────────────────────────────────────────────────
let cwdToSlug: ((cwd: string) => string) | null = null
try {
  cwdToSlug = (await import('../src/services/claude-paths.js')).cwdToSlug
} catch (err) {
  console.log(`NOTE  services/claude-paths.js could not be loaded: ${(err as Error).message.split('\n')[0]}`)
}
check('a shared cwdToSlug gives the CLI\'s folder name',
  cwdToSlug?.('D:\\Work\\app\\.claude\\worktrees\\fix+audit-4 x_y') === 'D--Work-app--claude-worktrees-fix-audit-4-x-y',
  cwdToSlug ? cwdToSlug('D:\\Work\\app\\.claude\\worktrees\\fix+audit-4 x_y') : 'no shared encoder')

function listTs(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listTs(full))
    else if (e.name.endsWith('.ts')) out.push(full)
  }
  return out
}
const SLUG_REGEX = /replace\(\/\[(\^a-zA-Z0-9|:\\\\)/
const encoders = listTs(srcDir).filter(f => path.basename(f) !== 'claude-paths.ts' && SLUG_REGEX.test(fs.readFileSync(f, 'utf8')))
check('no other server file carries its own cwd-to-slug encoder', encoders.length === 0,
  encoders.map(f => path.relative(srcDir, f)).join(', '))

const users = ['services/secret-scrubber.ts', 'services/worktree-orphans.ts', 'services/session-sanitizer.ts', 'services/session-index.ts']
const notShared = users.filter(f => !fs.readFileSync(path.join(srcDir, f), 'utf8').includes("from './claude-paths.js'"))
check('the scrubber, the orphan check, the sanitizer and the index take the projects folder from one place',
  notShared.length === 0, notShared.join(', '))

// Nothing in the server builds the projects folder by hand any more
// (four readers still did, which split the app between two roots under CLAUDE_CONFIG_DIR).
const handBuilt = listTs(srcDir).filter(f => path.basename(f) !== 'claude-paths.ts' && /['"]\.claude['"]\s*,\s*['"]projects['"]/.test(fs.readFileSync(f, 'utf8')))
check('no server file builds ~/.claude/projects itself', handBuilt.length === 0, handBuilt.map(f => path.relative(srcDir, f)).join(', '))

// ── the orphan check finds the transcript without scanning every project folder ─────────
{
  // A folder name with characters the old encoder kept (+, _, space) but the CLI turns into dashes.
  const cwd = path.join(fakeHome, 'work', 'fix+audit_4 demo')
  fs.mkdirSync(cwd, { recursive: true })
  const cliSlug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const projects = path.join(fakeHome, '.claude', 'projects')
  const sid = crypto.randomUUID()
  fs.mkdirSync(path.join(projects, cliSlug), { recursive: true })
  for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(projects, `C--other-project-${i}`), { recursive: true })
  fs.writeFileSync(path.join(projects, cliSlug, `${sid}.jsonl`), JSON.stringify({ type: 'user', cwd }) + '\n')

  let rootScans = 0
  const realReaddirSync = fs.readdirSync
  ;(fs as unknown as Record<string, unknown>).readdirSync = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && path.resolve(args[0]).toLowerCase() === projects.toLowerCase()) rootScans++
    return (realReaddirSync as (...a: unknown[]) => unknown).apply(fs, args)
  }
  const { scanWorktreeOrphans } = await import('../src/services/worktree-orphans.js')
  const scan = await scanWorktreeOrphans(cwd, sid)
  ;(fs as unknown as Record<string, unknown>).readdirSync = realReaddirSync
  check('setup: the orphan check reads the session\'s transcript', scan.checked === true, JSON.stringify(scan))
  check('the orphan check finds the transcript by its direct path, with no scan of every project folder',
    rootScans === 0, `${rootScans} scan(s) of the projects folder`)
}

// ── the real-casing cache ──────────────────────────────────────────────────────────────
{
  const { canonicalizeCwd } = await import('../src/services/canonical-path.js')
  if (process.platform !== 'win32') {
    check('a path that did not exist yet is not remembered with the wrong case (Windows only, skipped)', true)
  } else {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-case-')))
    fs.mkdirSync(path.join(base, 'Real'))
    const input = path.join(base, 'real', 'NewDir') // wrong case for Real, NewDir not there yet
    const first = canonicalizeCwd(input)
    fs.mkdirSync(path.join(base, 'Real', 'newdir')) // created on disk in a different case
    const second = canonicalizeCwd(input)
    check('setup: an existing parent gets its real casing', first === path.join(base, 'Real', 'NewDir'), first)
    check('once the missing folder exists, its real casing is used (not a remembered guess)',
      second === path.join(base, 'Real', 'newdir'), second)
    fs.rmSync(base, { recursive: true, force: true })
  }
}

fs.rmSync(fakeHome, { recursive: true, force: true })
done()
