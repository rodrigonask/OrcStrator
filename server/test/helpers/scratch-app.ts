// A throwaway server for route tests: a fresh temp data dir holding an EMPTY
// orcstrator.db, then the real migrations and the real route plugins, driven with
// Fastify's inject (no port, no network).
//
// The empty file is not optional. With no DB file at DATA_DIR, initDb imports the
// OrcStrator v1 database from the home folder, and a test must never read or copy
// a real database.
//
// config.ts reads ORCSTRATOR_DATA_DIR at import time, so this module sets it and only
// then imports db.js and the routes, dynamically. Test files must import the server
// modules they use through this helper (or dynamically after calling it), never with
// a static import at the top.

import fs from 'fs'
import os from 'os'
import path from 'path'

export interface ScratchApp {
  app: import('fastify').FastifyInstance
  db: import('better-sqlite3').Database
  dataDir: string
  close: () => Promise<void>
}

let dataDir: string | null = null

/** Point the server at a fresh temp data dir. Safe to call more than once; only the first call counts. */
export function useScratchDataDir(): string {
  if (dataDir) return dataDir
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-test-'))
  fs.writeFileSync(path.join(dataDir, 'orcstrator.db'), '')
  process.env.ORCSTRATOR_DATA_DIR = dataDir
  // Nothing in a test may reach a real claude or a real account.
  delete process.env.ANTHROPIC_API_KEY
  return dataDir
}

type RouteName = 'folders' | 'pipeline' | 'history' | 'settings' | 'state' | 'instances' | 'auth' | 'fs' | 'usage' | 'sessions' | 'agents' | 'profile'

/** `guard: true` installs the real request guard (security.ts: Host, Origin, cross-site, token). */
export async function scratchApp(routes: RouteName[], opts: { guard?: boolean } = {}): Promise<ScratchApp> {
  const dir = useScratchDataDir()
  const dbModule = await import('../../src/db.js')
  await dbModule.initDb()
  // `db` is a live binding assigned inside initDb, so read it only after the call.
  const { db, closeDb } = dbModule
  const Fastify = (await import('fastify')).default
  const app = Fastify({ logger: false })
  try {
    const { installErrorHandler } = await import('../../src/error-handler.js')
    installErrorHandler(app)
  } catch { /* a source tree from before error-handler.ts: Fastify's default handler */ }
  if (opts.guard) {
    try {
      const { installSecurityHooks } = await import('../../src/security.js')
      installSecurityHooks(app)
    } catch {
      // A source tree from before security.ts (the "fails on main" run): install the guard
      // index.ts had then, Host and Origin only, so the test reports what that code does.
      const { isAllowedHost, isAllowedOrigin } = await import('../../src/config.js')
      app.addHook('onRequest', async (request, reply) => {
        if (!isAllowedHost(request.headers.host)) return reply.code(403).send({ error: 'Forbidden: invalid Host header' })
        if (!isAllowedOrigin(request.headers.origin)) return reply.code(403).send({ error: 'Forbidden: origin not allowed' })
      })
    }
  }
  await app.register(async (api) => {
    for (const name of routes) {
      let mod: { default: Parameters<typeof api.register>[0] }
      try {
        mod = await import(`../../src/routes/${name}.js`)
      } catch (err) {
        // A route file this source tree does not have (the "fails on main" run): the test's
        // own checks then report it, instead of the whole file dying on the import.
        console.log(`NOTE  routes/${name}.js could not be loaded: ${(err as Error).message.split('\n')[0]}`)
        continue
      }
      await api.register(mod.default)
    }
  }, { prefix: '/api' })
  await app.ready()
  return {
    app,
    db,
    dataDir: dir,
    close: async () => {
      await app.close()
      closeDb()
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir, best effort */ }
    },
  }
}

// ── A tiny check() shared by every test file ─────────────────────────────────────

let failed = 0
let passed = 0

export function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

/** Print the tally and set the exit code. Call last. */
export function done(): void {
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}
