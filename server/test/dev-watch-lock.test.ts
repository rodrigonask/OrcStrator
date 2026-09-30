// The dev watcher's restart lock no longer blocks restarts forever when the PID
// it names has been handed to another process. A genuine lock still blocks.
//
// Runs the real server/dev-watch.mjs from a temp copy, with a temp data dir, and a stand-in
// `npx` that starts a tiny fake server instead of the real one (so no port, no database, no
// agent). Decoy processes play the part of the PID in the lock.
//
//   npx tsx server/test/dev-watch-lock.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { fileURLToPath } from 'url'
import { check, done } from './helpers/scratch-app.js'

const isWin = process.platform === 'win32'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const devWatch = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev-watch.mjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-devwatch-'))
const pkg = path.join(root, 'server')
const dataDir = path.join(root, 'data')
fs.mkdirSync(path.join(pkg, 'src'), { recursive: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.copyFileSync(devWatch, path.join(pkg, 'dev-watch.mjs'))
fs.writeFileSync(path.join(pkg, 'src', 'a.ts'), 'export const a = 1\n')
const startsLog = path.join(root, 'starts.log')
fs.writeFileSync(path.join(root, 'fake-server.mjs'),
  `import fs from 'fs'\nfs.appendFileSync(${JSON.stringify(startsLog)}, 'started ' + process.pid + '\\n')\nsetInterval(() => {}, 1e9)\n`)
// The watcher runs `npx tsx src/index.ts` through a shell; this `npx` is found first.
const bin = path.join(root, 'bin')
fs.mkdirSync(bin)
if (isWin) {
  fs.writeFileSync(path.join(bin, 'npx.cmd'), `@"${process.execPath}" "${path.join(root, 'fake-server.mjs')}"\r\n`)
} else {
  fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, 'fake-server.mjs')}"\n`, { mode: 0o755 })
}

const starts = () => (fs.existsSync(startsLog) ? fs.readFileSync(startsLog, 'utf8').split('\n').filter(Boolean).length : 0)
const lockPath = path.join(dataDir, 'dev.lock')
const writeLock = (pid: number, since: number) => fs.writeFileSync(lockPath, JSON.stringify({ pid, since }))
const touchSrc = (n: number) => fs.writeFileSync(path.join(pkg, 'src', 'a.ts'), `export const a = ${n}\n`)
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return true; await sleep(200) }
  return pred()
}
const decoys: ChildProcess[] = []
const nodeDecoy = () => { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' }); decoys.push(c); return c }

const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
let output = ''
const watcher = spawn(process.execPath, [path.join(pkg, 'dev-watch.mjs')], {
  cwd: pkg,
  env: { ...process.env, ORCSTRATOR_DATA_DIR: dataDir, [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ''}` },
  stdio: ['ignore', 'pipe', 'pipe'],
})
watcher.stdout!.on('data', d => { output += d })
watcher.stderr!.on('data', d => { output += d })

try {
  check('setup: the watcher starts the (fake) server', await waitFor(() => starts() === 1, 15_000), `${starts()} start(s)`)

  // A genuine lock: a live node process that was already running when the lock was written.
  const owner = nodeDecoy()
  await sleep(1500)
  writeLock(owner.pid!, Date.now())
  touchSrc(2)
  // Waits for the watcher to report the block (a fixed 5 s sleep raced its debounce on a busy machine).
  await waitFor(() => /BLOCKED/.test(output), 20_000)
  await sleep(1000)
  check('a lock held by the live server still blocks the restart', starts() === 1 && /BLOCKED/.test(output), `${starts()} start(s)`)

  // The server crashed and its PID went to a process started AFTER the lock was written.
  const reused = nodeDecoy()
  await sleep(300)
  writeLock(reused.pid!, Date.now() - 60_000)
  check('a lock whose PID now belongs to a newer process no longer blocks the restart',
    await waitFor(() => starts() === 2, 20_000), `${starts()} start(s)`)
  check('the stale lock file is removed', !fs.existsSync(lockPath))

  if (isWin) {
    // The PID went to a program that is not node at all (the lock's time says nothing here).
    const other = spawn('cmd.exe', ['/d', '/c', 'ping -n 120 127.0.0.1 >nul'], { stdio: 'ignore', windowsHide: true })
    decoys.push(other)
    await sleep(800)
    writeLock(other.pid!, Date.now() + 60_000)
    touchSrc(3)
    check('a lock whose PID now belongs to a program that is not node no longer blocks the restart',
      await waitFor(() => starts() === 3, 20_000), `${starts()} start(s)`)
  }
} finally {
  if (isWin && watcher.pid) {
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(watcher.pid)], { stdio: 'ignore' }) } catch { /* gone */ }
  } else {
    watcher.kill('SIGKILL')
  }
  for (const d of decoys) {
    if (isWin && d.pid) { try { execFileSync('taskkill', ['/F', '/T', '/PID', String(d.pid)], { stdio: 'ignore' }) } catch { /* gone */ } }
    else d.kill('SIGKILL')
  }
  await sleep(500)
  console.log('\n--- dev-watch output ---\n' + output.trim().split('\n').map(l => `  ${l}`).join('\n'))
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* a file still held by a dying process */ }
}

// The server side of the lock: a lock a crashed server left behind
// names a dead PID, which the watcher ignores. A chat starting now must take the lock over,
// or a source edit mid-turn restarts the server under it.
{
  console.log('NOTE  registry section')
  // Unref'd: fires only if something below never settles, and then names the stall instead of hanging CI.
  setTimeout(() => { console.log('FAIL  the registry section did not finish within 3 minutes'); process.exit(1) }, 180_000).unref()
  const { useScratchDataDir } = await import('./helpers/scratch-app.js')
  const scratch = useScratchDataDir()
  const lock = path.join(scratch, 'dev.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: 999_999_1, since: Date.now() - 3_600_000 }))
  const { processRegistry } = await import('../src/services/process-registry.js')
  const child = { pid: 424242, once() { return this }, on() { return this } } as unknown as ChildProcess
  processRegistry.registerProcess('lock-test', child)
  let owner: number | null = null
  try { owner = (JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number }).pid } catch { /* reported below */ }
  check('a chat starting over a stale lock rewrites it with this server\'s PID', owner === process.pid, `lock pid ${owner}, server pid ${process.pid}`)
  processRegistry.unregisterProcess('lock-test', child)
  check('... and the lock goes when the last chat ends', !fs.existsSync(lock))

  // A second LIVE server's lock is never taken over or removed: taking it
  // would leave the watcher a dead PID the moment this server crashed, under the other's chats.
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' })
  await sleep(300)
  fs.writeFileSync(lock, JSON.stringify({ pid: other.pid, since: Date.now() }))
  processRegistry.registerProcess('lock-test-2', child)
  const kept = (JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number }).pid
  processRegistry.unregisterProcess('lock-test-2', child)
  check('a lock held by another live server is left alone, start and end', kept === other.pid && fs.existsSync(lock) && (JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number }).pid === other.pid, `lock pid ${kept}, other ${other.pid}`)
  if (isWin && other.pid) { try { execFileSync('taskkill', ['/F', '/T', '/PID', String(other.pid)], { stdio: 'ignore' }) } catch { /* gone */ } } else other.kill('SIGKILL')
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* db handle still open */ }
}
done()
// The registry section opens the database and the process registry, which keep the event loop
// alive on Linux: exit explicitly, as the other server tests do (CI hung here otherwise).
process.exit(process.exitCode ?? 0)
