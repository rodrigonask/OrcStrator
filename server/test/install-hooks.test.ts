// `npm install` (the root `prepare` script) points git at .githooks only when this
// package IS the git checkout, nothing else already set a hooks path, and it is not a CI run.
// Every repository here is a throwaway `git init` in a temp folder, with git's global and
// system config switched off, so no real repository or user setting is read or changed.
//
//   npx tsx server/test/install-hooks.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync, execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { check, done } from './helpers/scratch-app.js'

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'install-hooks.cjs')
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-hooks-')))
const emptyGlobal = path.join(base, 'empty-gitconfig')
fs.writeFileSync(emptyGlobal, '')

const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: base }
delete gitEnv.CI
delete gitEnv.GIT_DIR
delete gitEnv.GIT_WORK_TREE

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
const hooksPath = (repo: string) => { try { return git(repo, 'config', '--local', '--get', 'core.hooksPath') } catch { return '' } }

/** A copy of the package's hook installer, laid out the way the repo has it. */
function makePackage(dir: string): string {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n')
  fs.copyFileSync(script, path.join(dir, 'scripts', 'install-hooks.cjs'))
  return dir
}
function install(pkg: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, ['scripts/install-hooks.cjs'], { cwd: pkg, env: { ...gitEnv, ...extraEnv }, encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  console.log(`      ${path.relative(base, pkg) || '.'}${extraEnv.CI ? ' (CI)' : ''}: exit ${r.status}, "${out}"`)
  return { status: r.status, out }
}

// ── the normal case: this package is its own checkout ──────────────────────────────────
{
  const pkg = makePackage(path.join(base, 'own'))
  git(pkg, 'init', '-q')
  const r = install(pkg)
  check('setup: in its own checkout the hooks are installed', r.status === 0 && hooksPath(pkg) === '.githooks', `hooksPath "${hooksPath(pkg)}"`)
  const again = install(pkg)
  check('setup: a second install with the hooks already ours is fine', again.status === 0 && hooksPath(pkg) === '.githooks', `hooksPath "${hooksPath(pkg)}"`)
}

// ── inside somebody else's repository ──────────────────────────────────────────────────
{
  const outer = path.join(base, 'outer')
  fs.mkdirSync(outer, { recursive: true })
  git(outer, 'init', '-q')
  const pkg = makePackage(path.join(outer, 'vendor', 'orcstrator'))
  const r = install(pkg)
  check('installing inside another repository leaves that repository\'s hooks alone',
    r.status === 0 && hooksPath(outer) === '', `outer hooksPath "${hooksPath(outer)}"`)
}

// ── a hooks path somebody already chose ────────────────────────────────────────────────
{
  const pkg = makePackage(path.join(base, 'custom'))
  git(pkg, 'init', '-q')
  git(pkg, 'config', '--local', 'core.hooksPath', 'my-own-hooks')
  const r = install(pkg)
  check('an existing core.hooksPath is not overwritten', r.status === 0 && hooksPath(pkg) === 'my-own-hooks', `hooksPath "${hooksPath(pkg)}"`)
}

// ── CI ─────────────────────────────────────────────────────────────────────────────────
{
  const pkg = makePackage(path.join(base, 'ci'))
  git(pkg, 'init', '-q')
  const r = install(pkg, { CI: 'true' })
  check('a CI install does not touch git config', r.status === 0 && hooksPath(pkg) === '', `hooksPath "${hooksPath(pkg)}"`)
}
// CI=false is how some tools say "not CI": the hooks are still installed.
{
  const pkg = makePackage(path.join(base, 'ci-false'))
  git(pkg, 'init', '-q')
  const r = install(pkg, { CI: 'false' })
  check('CI=false is not a CI run: the hooks are installed', r.status === 0 && hooksPath(pkg) !== '', `hooksPath "${hooksPath(pkg)}"`)
}

// ── not a git checkout at all ──────────────────────────────────────────────────────────
{
  const pkg = makePackage(path.join(base, 'plain'))
  const r = install(pkg)
  check('outside any git checkout the install still succeeds', r.status === 0, `exit ${r.status}`)
}

fs.rmSync(base, { recursive: true, force: true })
done()
