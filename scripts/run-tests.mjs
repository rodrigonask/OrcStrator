// The one test entry point: `npm run test:unit` locally and in CI.
//
// Every *.test.ts under shared/test, server/test and client/test runs in its OWN process, because
// the server tests each boot a scratch database from an env var that config.ts reads
// once at import. Then the two older suites that live elsewhere (the compaction hook
// and the stream-parser permission test). One line per file, non-zero exit if any
// file fails, so CI goes red on the first real regression.

import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')

function findTests(dir) {
  const abs = path.join(root, dir)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs)
    .filter(f => f.endsWith('.test.ts'))
    .sort()
    .map(f => path.join(dir, f))
}

const only = process.argv.slice(2)
const suites = [
  ...findTests('shared/test').map(f => ({ name: f, args: [tsxCli, f] })),
  ...findTests('server/test').map(f => ({ name: f, args: [tsxCli, f] })),
  ...findTests('client/test').map(f => ({ name: f, args: [tsxCli, f] })),
  { name: 'server/hooks/test/run-tests.mjs', args: ['server/hooks/test/run-tests.mjs'] },
  { name: 'scripts/test-parser-permission.ts', args: [tsxCli, 'scripts/test-parser-permission.ts'] },
].filter(s => only.length === 0 || only.some(o => s.name.includes(o)))

const failed = []
for (const s of suites) {
  const r = spawnSync(process.execPath, s.args, { cwd: root, encoding: 'utf8', env: { ...process.env } })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const ok = r.status === 0
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${s.name}`)
  if (!ok || process.env.TEST_VERBOSE) console.log(out.split('\n').map(l => `      ${l}`).join('\n'))
  if (!ok) failed.push(s.name)
}

console.log(`\n${suites.length - failed.length}/${suites.length} suites passed`)
if (failed.length) {
  console.log(`Failed: ${failed.join(', ')}`)
  process.exit(1)
}
