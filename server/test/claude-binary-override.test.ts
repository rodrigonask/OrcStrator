// The installed launcher pins the Claude binary the server runs through
// ORCSTRATOR_CLAUDE_PATH, to the claude.exe whose Anthropic signature it verified, or to a path
// that is not a file when it refused the one it found. An explicit override is final: the server
// must never fall back to some other, unverified copy on PATH or in the native folder.
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-claude-override-'))
const onPath = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude')
fs.writeFileSync(onPath, 'not really claude')
process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`
process.env.ORCSTRATOR_CLAUDE_PATH = path.join(dir, 'refused-not-a-file')

const mod = await import('../src/services/claude-binary.js') as { resolveClaudeBinary: () => { path: string | null }; isFullyQualified?: (p: string, platform: NodeJS.Platform) => boolean }
const { resolveClaudeBinary, isFullyQualified } = mod

let failed = 0
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`  PASS  ${name}`) } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${(e as Error).message}`) }
}

check('an override that is not a file resolves to no binary, even with a claude on PATH', () => {
  assert.equal(resolveClaudeBinary().path, null)
})

// A root- or drive-relative override names one file here and another
// when a turn is spawned from a project on another drive. Only a fully qualified path counts.
check('a root- or drive-relative override is not a binary, even when it exists from here', () => {
  assert.equal(typeof isFullyQualified, 'function')
  const q = isFullyQualified!
  assert.equal(q('\\tools\\claude.exe', 'win32'), false)
  assert.equal(q('C:tools\\claude.exe', 'win32'), false)
  assert.equal(q('tools\\claude.exe', 'win32'), false)
  assert.equal(q('C:\\tools\\claude.exe', 'win32'), true)
  assert.equal(q('C:/tools/claude.exe', 'win32'), true)
  assert.equal(q('\\\\server\\share\\claude.exe', 'win32'), true)
  assert.equal(q('\\\\?\\C:\\tools\\claude.exe', 'win32'), true)
  if (process.platform === 'win32' && process.cwd().slice(0, 2).toLowerCase() === onPath.slice(0, 2).toLowerCase()) {
    // The same file as "onPath", written root-relative: it exists from here (same drive), and is
    // still refused. (Skipped where the temp folder is on another drive, as on CI runners.)
    const rootRelative = onPath.slice(2)
    assert.ok(fs.existsSync(rootRelative))
    assert.equal(q(rootRelative, 'win32'), false)
  }
})

// An extensionless pin "X\claude" is checked as written, but spawn runs
// "X\claude.com" or "X\claude.exe"; a stream "x.txt:evil" runs too. Only a plain ".exe" counts.
check('an override without ".exe", with a stream or a trailing dot is not a binary', () => {
  const m = mod as { isPinnable?: (p: string, platform: NodeJS.Platform) => boolean }
  assert.equal(typeof m.isPinnable, 'function')
  const ok = m.isPinnable!
  assert.equal(ok('C:\\x\\claude', 'win32'), false)
  assert.equal(ok('C:\\x\\host.txt:evil', 'win32'), false)
  assert.equal(ok('C:\\x\\claude.exe:evil', 'win32'), false)
  assert.equal(ok('C:\\x\\claude.exe.', 'win32'), false)
  assert.equal(ok('C:\\x\\claude.exe ', 'win32'), false)
  assert.equal(ok('\\tools\\claude.exe', 'win32'), false)
  assert.equal(ok('C:\\x\\claude.exe', 'win32'), true)
  assert.equal(ok('C:\\x\\CLAUDE.EXE', 'win32'), true)
  assert.equal(ok('\\\\?\\C:\\x\\claude.exe', 'win32'), true)
  assert.equal(ok('\\\\server\\share\\claude.exe', 'win32'), true)
  assert.equal(ok('/usr/local/bin/claude', 'linux'), true)
})

fs.rmSync(dir, { recursive: true, force: true })
if (failed) process.exit(1)
