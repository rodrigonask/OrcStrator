// What the server does with an error nothing else caught.
//
// The decision, made on purpose: LOG IT, SHOW IT, KEEP RUNNING.
//
// Node's default for an uncaught exception is to exit, and the usual advice is to let it.
// That advice assumes something restarts the process and that nothing of value dies with
// it. Neither holds here. This server is the parent of every agent turn in flight: exiting
// kills all of them mid-work, loses their unsaved output, and leaves the app with no
// server until the user notices and restarts it by hand. The things that actually throw
// this far are callbacks tied to ONE chat or ONE request (a stream handler, a timer, a
// socket event), and the shared state they touch is the database, which is synchronous and
// transactional here (better-sqlite3): a throw inside a transaction rolls it back rather
// than leaving it half-written. So one chat's bad moment is not allowed to end every other
// chat's turn.
//
// What stops this from hiding problems is the other half: every such error is logged with
// its stack and sent to every open tab as a `server:error` event, so it is seen when it
// happens, not discovered weeks later.

import { reportPersistFailure } from './persist-errors.js'

let installed = false

export function handleUncaught(kind: 'exception' | 'rejection', err: unknown): void {
  try {
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err)
    console.error(`[server] Uncaught ${kind === 'exception' ? 'exception' : 'promise rejection'} (the server keeps running):\n${stack}`)
    reportPersistFailure('process', err, { alreadyLogged: true })
  } catch { /* the last line of defence must not throw */ }
}

export function installProcessErrorHandlers(): void {
  if (installed) return
  installed = true
  process.on('unhandledRejection', (reason) => handleUncaught('rejection', reason))
  process.on('uncaughtException', (err) => handleUncaught('exception', err))
}
