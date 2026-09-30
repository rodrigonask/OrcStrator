// Client hygiene checks.
//   - the whole UI is one bundle: the pages opened now and then load on first visit
//   - fonts from Google, per-chat storage that is never cleaned, polling a hidden page,
//     unchecked fetches, mouse-only controls
//   - dead client modules and dependencies (react-virtuoso stays OUT: it is not re-added)
//   - machine paths in scripts; the agent prompt's hardcoded port
//
//   npx tsx client/test/client-hygiene.test.ts

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')
const exists = (p: string) => fs.existsSync(path.join(root, p))

let failed = 0
let passed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

// ---------- lazy-loaded pages ----------
{
  const app = read('client/src/App.tsx')
  const pages = ['PipelineBoard', 'SettingsPage', 'AgentsPage', 'UsageReportPage', 'SessionsPage', 'SkillsPage', 'ActivityPage']
  const eager = pages.filter(p => new RegExp(`^import \\{ ${p} \\}`, 'm').test(app))
  const lazyOk = pages.every(p => new RegExp(`const ${p} = lazy\\(`).test(app))
  check('the non-Grid pages are lazy-loaded', eager.length === 0 && lazyOk, eager.length ? `still eager: ${eager.join(', ')}` : '')
  check('a Suspense boundary covers them', /<Suspense fallback=/.test(app))
  check('Grid and Chat stay in the main bundle', /^import \{ GridView \}/m.test(app) && /^import \{ ChatView \}/m.test(app))
}

// ---------- fonts, per-chat storage, hidden polling, checked fetches, keyboard access ----------
{
  const html = read('client/index.html')
  check('no font request to Google on launch', !/fonts\.googleapis|fonts\.gstatic/.test(html))
  const vite = read('client/vite.config.ts')
  check('the CSP no longer allows Google font hosts', !/fonts\.googleapis|fonts\.gstatic/.test(vite))
  const main = read('client/src/main.tsx')
  check('the fonts are bundled with the app (@fontsource)', /@fontsource\/inter/.test(main) && /@fontsource\/jetbrains-mono/.test(main) && /@fontsource\/space-grotesk/.test(main))

  let storageMod: Record<string, any> | null = null
  try { storageMod = await import('../src/utils/chatStorage.js') } catch { /* missing on main */ }
  if (!storageMod) check('per-chat storage cleanup exists', false, 'utils/chatStorage missing')
  else {
    const mk = (entries: Record<string, string>) => {
      const m = new Map(Object.entries(entries))
      return { get length() { return m.size }, key: (i: number) => [...m.keys()][i] ?? null, removeItem: (k: string) => { m.delete(k) }, map: m }
    }
    const a = '00000000-0000-4000-8000-00000000000a', b = '00000000-0000-4000-8000-00000000000b'
    const local = mk({ [`perm-${a}`]: 'auto', [`model-${a}`]: 'x', [`effort-${a}`]: 'x', [`switch-note-${a}`]: 'x', [`perm-${b}`]: 'auto', 'model-default': 'keep', 'orcstrator.gridTiles': 'keep' })
    const session = mk({ [`draft-${a}`]: 'hello', [`draft-${b}`]: 'keep' })
    storageMod.forgetChat(a, local, session)
    check('deleting a chat drops all five of its keys', !local.map.has(`perm-${a}`) && !local.map.has(`model-${a}`) && !local.map.has(`effort-${a}`) && !local.map.has(`switch-note-${a}`) && !session.map.has(`draft-${a}`))
    check('...and nobody else\'s', local.map.has(`perm-${b}`) && session.map.has(`draft-${b}`) && local.map.has('model-default'))
    const local2 = mk({ [`perm-${a}`]: 'x', [`perm-${b}`]: 'x', 'model-default': 'keep', [`draft-${b}`]: 'x' })
    const removed = storageMod.pruneChatKeys(new Set([b]), [local2])
    check('a boot-time sweep drops keys of chats that no longer exist', removed === 1 && !local2.map.has(`perm-${a}`) && local2.map.has(`perm-${b}`) && local2.map.has('model-default'))
  }
  const app = read('client/src/context/AppContext.tsx')
  check('the app forgets a deleted chat\'s keys and sweeps once per load', /forgetChat\(action\.payload\)/.test(app) && /pruneChatKeys\(/.test(app))
  const usage = read('client/src/components/UsageReportPage.tsx')
  check('the Usage page does not poll while hidden', /if \(document\.hidden\) return/.test(usage))
  check('a refused sync says why instead of "Imported undefined"', /if \(!res\.ok\)/.test(usage))
  check('the conflict banner checks the answer before hiding', /if \(!res\.ok\)/.test(read('client/src/components/ConflictBanner.tsx')))
  const bubble = read('client/src/components/MessageBubble.tsx')
  const list = read('client/src/components/MessageList.tsx')
  check('"View more" is a keyboard-reachable button', /<button type="button" className="view-more-inline"/.test(bubble) && !/<span className="view-more-inline" onClick/.test(bubble))
  check('the tool group toggle is a keyboard-reachable button', /<button type="button" className="tool-call-group-header"/.test(list) && !/<div className="tool-call-group-header" onClick/.test(list))
}

// ---------- dead modules and dependencies ----------
{
  const dead = ['client/src/components/OverdriveFire.tsx', 'client/src/components/ThinkingIndicator.tsx', 'client/src/utils/orcQuips.ts', 'client/src/hooks/useFocusTrap.ts', 'client/src/utils.ts']
  const left = dead.filter(exists)
  check('the dead client modules are gone', left.length === 0, left.join(', '))
  const cpkg = JSON.parse(read('client/package.json'))
  const all = { ...cpkg.dependencies, ...cpkg.devDependencies }
  check('react-virtuoso is not a dependency (virtualization stays out)', !('react-virtuoso' in all))
  check('@types/dompurify is gone (dompurify ships its own types)', !('@types/dompurify' in all))
  const rpkg = JSON.parse(read('package.json'))
  check('the root package has no unused sharp', !('sharp' in { ...rpkg.dependencies, ...rpkg.devDependencies }))
  const lock = read('package-lock.json')
  check('react-virtuoso is not in the lockfile', !/"node_modules\/react-virtuoso"/.test(lock))
  const srcFiles: string[] = []
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name)) srcFiles.push(p) } }
  walk(path.join(root, 'client', 'src'))
  check('nothing imports react-virtuoso', !srcFiles.some(f => /from ['"]react-virtuoso['"]/.test(fs.readFileSync(f, 'utf8'))))
}

// ---------- machine paths and the hardcoded port ----------
{
  const scripts = fs.readdirSync(path.join(root, 'scripts')).filter(f => /\.(mjs|cjs|ts|js)$/.test(f))
  const withUser = scripts.filter(f => /C:[\\/]+Users[\\/]+[A-Za-z]/.test(fs.readFileSync(path.join(root, 'scripts', f), 'utf8')))
  check('no machine user path in the scripts', withUser.length === 0, withUser.join(', '))
  const menu = read('client/src/hooks/useInstanceContextMenu.tsx')
  check('the "make it a routine" prompt uses the live port, not 3334', !/127\.0\.0\.1:3334/.test(menu) && /ORCSTRATOR_PORT/.test(menu))
}

// ---------- The WS boundary is typed; the prepare() comment is true ----------
{
  const mapPath = 'shared/src/ws-events.ts'
  if (!exists(mapPath)) check('a shared WS event map exists', false, `${mapPath} missing`)
  else {
    const map = read(mapPath)
    const names = new Set([...map.matchAll(/^\s+'([a-z-]+:[a-z:-]+)':/gm)].map(m => m[1]))
    // Every event name the server broadcasts, from the source.
    const emitted = new Set<string>()
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ts')) { const s = fs.readFileSync(p, 'utf8'); for (const m of s.matchAll(/broadcastEvent\(\{\s*type:\s*'([^']+)'/g)) emitted.add(m[1]) } } }
    walk(path.join(root, 'server', 'src'))
    const missing = [...emitted].filter(n => !names.has(n))
    check('every event the server broadcasts is in the shared map', emitted.size > 20 && missing.length === 0, missing.join(', ') || `${emitted.size} events`)
    const listened = new Set<string>()
    const cwalk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) cwalk(p); else if (/\.tsx?$/.test(e.name)) { const s = fs.readFileSync(p, 'utf8'); for (const m of s.matchAll(/(?:onEvent|wsClient\.on)\('([a-z-]+:[a-z:-]+)'/g)) listened.add(m[1]) } } }
    cwalk(path.join(root, 'client', 'src'))
    const deaf = [...listened].filter(n => !names.has(n))
    check('every event the client listens for is in the shared map', deaf.length === 0, deaf.join(', '))
  }
  const handler = read('server/src/ws/handler.ts')
  check('the server broadcast takes a typed event name', /export function broadcastEvent<K extends WsEventName>/.test(handler))
  const apiIdx = read('client/src/api/index.ts')
  check('the client subscription is typed by event (no `any` payloads)', /onEvent: <K extends WsEventName>/.test(apiIdx) && !/payload: any/.test(apiIdx))
  check('the misleading "prepare is cached" comment is corrected', !/caches by\s*\n?\s*\/\/\s*SQL text/.test(read('server/src/services/compaction-savings.ts')) && /does NOT\s*\n\/\/ cache statements/.test(read('server/src/services/compaction-savings.ts')))
}

// ---------- Runtime dependencies out of their advisory ranges ----------
{
  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string }> }
  const ver = (v: string) => v.split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0)
  const gt = (a: string, b: string) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false }
  // name -> [lowest, highest] vulnerable version, as `npm audit` reported them before the upgrade
  const ranges: Record<string, [string, string]> = {
    fastify: ['0.0.0', '5.12.0'], '@fastify/static': ['0.0.0', '10.1.1'], ws: ['8.0.0', '8.20.1'], sharp: ['0.0.0', '0.35.4'],
    dompurify: ['0.0.0', '3.4.12'], 'fast-uri': ['3.0.0', '3.1.5'], 'find-my-way': ['0.0.0', '9.6.0'], 'brace-expansion': ['3.0.0', '5.0.8'],
  }
  for (const [name, [low, worst]] of Object.entries(ranges)) {
    const mine = (k: string) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`)
    const found = Object.entries(lock.packages).filter(([k]) => mine(k)).map(([, v]) => `${name}@${v.version}`)
    const bad = Object.entries(lock.packages).filter(([k, v]) => mine(k) && v.version && !gt(low, v.version) && !gt(v.version, worst))
    check(`${name} is past its advisory range (> ${worst})`, found.length > 0 && bad.length === 0, found.join(', '))
  }
  const ci = read('.github/workflows/ci.yml')
  const step = ci.slice(ci.indexOf('npm audit --omit=dev'), ci.indexOf('npm audit --omit=dev') + 120)
  check('the CI dependency audit is a hard gate', /npm audit --omit=dev --audit-level=high/.test(ci) && !/continue-on-error/.test(step))
}

// ---------- stored images and server errors, client side ----------
{
  const bubble = read('client/src/components/MessageBubble.tsx')
  check('an image block loads its stored file by url, the inline data is only a fallback', /src=\{block\.url \?\? thumb/.test(bubble) && /onError=\{e => \{ if \(block\.url && thumb && e\.currentTarget\.src !== thumb\) e\.currentTarget\.src = thumb \}\}/.test(bubble))
  check('an image with no thumbnail gets no empty data URL', /const thumb = block\.base64 \?/.test(bubble))
  const app = read('client/src/context/AppContext.tsx')
  check('a server:error for a chat is shown in that chat', /api\.onEvent\('server:error'/.test(app))
  const shell = read('client/src/App.tsx')
  const banner = fs.existsSync(path.join(root, 'client/src/components/ServerErrorBanner.tsx')) ? read('client/src/components/ServerErrorBanner.tsx') : ''
  check('an error with no chat (a failed save, a broken scheduler) gets an app-level banner', /<ServerErrorBanner\s*\/>/.test(shell) &&/onEvent\('server:error'/.test(banner) && /instanceId/.test(banner))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
