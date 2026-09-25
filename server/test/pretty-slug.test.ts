// The prettySlug label test. Run it with:
//   npx tsx server/test/pretty-slug.test.ts
//
// A plain script like shared/test/next-run.test.ts: one PASS line per case, non-zero
// exit on any failure. It imports only the pure helper, never the route (which opens
// the database on import).

import { prettySlug } from '../src/services/pretty-slug.js'

let failed = 0

function check(name: string, got: string, want: string): void {
  if (got === want) {
    console.log(`PASS  ${name}  "${got}"`)
  } else {
    failed++
    console.log(`FAIL  ${name}  got "${got}", want "${want}"`)
  }
}

check('root folder prefix trimmed', prettySlug('C--work-orcstrator-v2', 'C:\\work'), 'orcstrator-v2')
check('empty root folder trims nothing', prettySlug('C--work-orcstrator-v2', ''), 'C--work-orcstrator-v2')
check('other drive and root', prettySlug('D--code-app', 'D:\\code'), 'app')
check('trailing slash on root folder', prettySlug('D--code-app', 'D:\\code\\'), 'app')
check('forward-slash root folder', prettySlug('D--code-app', 'D:/code/'), 'app')
check('case-insensitive prefix', prettySlug('C--Work-app', 'c:\\work'), 'app')
check('slug that IS the root falls back to full slug', prettySlug('D--code', 'D:\\code'), 'D--code')
check('unrelated slug untouched', prettySlug('E--other-app', 'D:\\code'), 'E--other-app')
check('worktree suffix split out', prettySlug('D--code-app--claude-worktrees-feat-x', 'D:\\code'), 'app (worktree: feat-x)')

if (failed > 0) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
