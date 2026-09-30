// Run by the root `prepare` script on `npm install`: point git at the committed
// hooks in .githooks (the gitleaks pre-commit secret scan). Never fails the
// install: outside a git checkout, or without git on PATH, it just says so.
//
// It used to set core.hooksPath unconditionally, on every install, in whatever
// repository the command happened to run in. Installing the app from source inside some
// other repo therefore silently replaced THAT repo's hooks, and a hooks path the owner had
// set on purpose was overwritten. So it now only acts when:
//   - this package folder is itself the top of the git checkout (not a folder inside
//     someone else's repo),
//   - core.hooksPath is unset, or already ours (.githooks),
//   - it is not a CI run (CI machines install for a build, not to commit),
//   - the .githooks folder is actually there (an installed build has none).
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const pkgDir = path.resolve(__dirname, '..')
const OURS = '.githooks'

function git(args) {
  return execFileSync('git', args, { cwd: pkgDir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
}

/** Compare two folder paths the way the file system does (case-blind on Windows, links resolved). */
function samePath(a, b) {
  const norm = (p) => {
    let r = path.resolve(p)
    try { r = fs.realpathSync.native(r) } catch { /* keep the resolved spelling */ }
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

function main() {
  // CI=false (or 0) is set by some tools to mean "not CI", so only a truthy value counts.
  if (process.env.CI && !/^(false|0)$/i.test(process.env.CI)) {
    console.log('git hooks: CI run, hooks not installed')
    return
  }
  // An installed build (no source checkout) ships without the hooks folder: nothing to point at.
  if (!fs.existsSync(path.join(pkgDir, OURS))) {
    console.log('git hooks: no .githooks folder here, hooks not installed')
    return
  }
  let top
  try {
    top = git(['rev-parse', '--show-toplevel'])
  } catch {
    console.log('git hooks: not a git checkout or git missing, hooks not installed')
    return
  }
  if (!top || !samePath(top, pkgDir)) {
    console.log('git hooks: this folder sits inside another git repository, its hooks were left alone')
    return
  }
  let current = ''
  try {
    current = git(['config', '--get', 'core.hooksPath'])
  } catch {
    // Exit code 1: the key is unset at every level (this repo, the user, the machine),
    // which is the case we are here for. A hooks path set at ANY level is someone's choice.
  }
  if (current && current.replace(/[\\/]+$/, '') !== OURS) {
    console.log(`git hooks: core.hooksPath is already set to "${current}", left as it is`)
    return
  }
  if (current) {
    console.log('git hooks: core.hooksPath already points at .githooks (gitleaks pre-commit active)')
    return
  }
  try {
    git(['config', '--local', 'core.hooksPath', OURS])
    console.log('git hooks: core.hooksPath set to .githooks (gitleaks pre-commit active)')
  } catch {
    console.log('git hooks: could not set core.hooksPath, hooks not installed')
  }
}

try {
  main()
} catch {
  // Never fail an install over hooks.
  console.log('git hooks: skipped')
}
