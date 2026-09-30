// One chat streaming must not re-render every other chat's Grid tile.
//
//   Every chunk of agent output re-rendered the whole app and every tile, because every
//       per-chat component read the WHOLE messages (and instances) context, whose value changed
//       on every chunk. Now those slices are stores read through per-chat selectors.
//   The multipliers: the tool-result map of every chat, a JSON.parse of a Write's whole
//       payload on each render, a UI context whose value changed with usage polls and session
//       costs, and two full board refetches per card event.
//
// Three layers: (1) the source contract: per-chat components never subscribe to a whole
// slice; (2) the store behaviour, rendered for real with React in a jsdom window: four tiles,
// one streaming, the other three render once; (3) the pure helpers. The before/after render
// counts were measured in Grid view on a scratch server.
//
//   npx tsx client/test/grid-renders.test.ts

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const src = (p: string) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8')

let failed = 0
let passed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

// ---------- 1. Source contract ----------

// Everything rendered once per chat (a Grid tile and what is inside it, a sidebar row) or
// rendered around every view. None of these may read a whole slice.
const PER_CHAT = [
  'App.tsx',
  'components/grid/GridTile.tsx',
  'components/grid/GridView.tsx',
  'components/InstanceItem.tsx',
  'components/FolderGroup.tsx',
  'components/Sidebar.tsx',
  'components/MessageList.tsx',
  'components/MessageInput.tsx',
  'components/NativeTaskPanel.tsx',
  'components/PermissionBanner.tsx',
  'components/CliPromptBanner.tsx',
  'components/TerminalPanel.tsx',
  'components/ChatHeader.tsx',
  'hooks/useCacheWarm.ts',
  'hooks/usePermissionScope.ts',
]
for (const f of PER_CHAT) {
  const s = src(f)
  const whole = [...s.matchAll(/\buse(Messages|Instances)\(\)/g)].map(m => m[0])
  check(`${f} reads no whole messages/instances slice`, whole.length === 0, whole.length ? `found ${whole.join(', ')}` : '')
}
{
  const s = src('components/grid/GridTile.tsx')
  check('GridTile is memoized', /export const GridTile = memo\(/.test(s))
  const ui = src('context/UIContext.tsx')
  check('UI context no longer carries usage or session costs', !/\n\s*usage:\s*UsageData/.test(ui) && !/\n\s*sessionCosts:\s*Record/.test(ui))
  const app = src('context/AppContext.tsx')
  check('UI context value is not rebuilt on every UI change', !/\[uiState, instState\.settings\]/.test(app))
  const ml = src('components/MessageList.tsx')
  const tcb = src('components/ToolCallBlock.tsx')
  check('no JSON.parse of a tool input just to spot a plan file', !/JSON\.parse\(tc\.input/.test(ml) && !/JSON\.parse\(input\)\?\.file_path/.test(tcb))
  check('tool results read per chat, not the all-chats map', !/liveResults\?\.\[instanceId\]/.test(ml))
  const pc = src('context/PipelineContext.tsx')
  const ap = src('hooks/useAllPipelineTasks.ts')
  check('card events fetch one card on the open board', /fetchTaskShared\(/.test(pc) && !/\/\/ created, updated, blocked, unblocked -- need full data, refetch\s*\n\s*fetchTasks\(\)/.test(pc))
  check('card events fetch one card in the app-wide list', /fetchTaskShared\(/.test(ap))
}

// ---------- 2. Store behaviour, rendered for real ----------

let JSDOM: typeof import('jsdom').JSDOM
try {
  JSDOM = require('jsdom').JSDOM
} catch {
  JSDOM = createRequire(path.join(process.env.ORC_TEST_MODULES ?? '', 'x.js'))('jsdom').JSDOM
}
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost:5174/' })
const g = globalThis as unknown as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.HTMLElement = dom.window.HTMLElement
g.IS_REACT_ACT_ENVIRONMENT = true

async function storeBehaviour(): Promise<void> {
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const Messages = await import('../src/context/MessagesContext.js') as Record<string, any>
  const Instances = await import('../src/context/InstancesContext.js') as Record<string, any>
  if (typeof Messages.createMessagesStore !== 'function' || typeof Messages.useMessagesSelector !== 'function') {
    check('messages are a store read through per-chat selectors', false, 'createMessagesStore/useMessagesSelector missing')
    return
  }
  if (typeof Instances.createInstancesStore !== 'function' || typeof Instances.useInstance !== 'function') {
    check('instances are a store read through per-chat selectors', false, 'createInstancesStore/useInstance missing')
    return
  }
  const h = React.createElement
  const renders: Record<string, number> = {}
  const ids = ['streamer', 'idle1', 'idle2', 'idle3']

  function Tile({ id }: { id: string }) {
    const live = Messages.useMessagesSelector((s: any) => s.streamingContent[id] || '')
    const list = Messages.useMessagesSelector((s: any) => s.messages[id])
    const results = Messages.useMessagesSelector((s: any) => s.toolResults[id])
    const inst = Instances.useInstance(id)
    renders[id] = (renders[id] ?? 0) + 1
    return h('div', null, `${inst?.name}:${live.length}:${list?.length ?? 0}:${results ? Object.keys(results).length : 0}`)
  }
  let wholeRenders = 0
  function Whole() {
    Messages.useMessages()
    wholeRenders++
    return null
  }

  const empty = { messages: {}, hasMore: {}, pagedBack: {}, streamingContent: {}, streamingToolCalls: {}, toolResults: {}, unreadCounts: {}, rawOutput: {}, cliPrompts: {}, permissionRequests: {}, pendingCommand: {}, pendingWakeups: {} }
  let msgState: any = { ...empty, messages: Object.fromEntries(ids.map(id => [id, [{ id: `${id}-m1` }]])) }
  let instState: any = { folders: [], instances: ids.map((id, i) => ({ id, name: id, sortOrder: i, state: 'idle' })) }
  const mStore = Messages.createMessagesStore(msgState)
  const iStore = Instances.createInstancesStore(instState)

  const root = createRoot(document.getElementById('root')!)
  await React.act(async () => {
    root.render(h(Instances.InstancesContext.Provider, { value: iStore },
      h(Messages.MessagesContext.Provider, { value: mStore },
        ...ids.map(id => h(Tile, { key: id, id })), h(Whole))))
  })
  const mounted = { ...renders }
  const wholeMounted = wholeRenders

  // The streamer's turn, shaped exactly like the reducers shape it: 60 text chunks, a tool
  // result, and 20 progress updates to its instance row. Every other entry keeps its reference.
  for (let i = 0; i < 60; i++) {
    msgState = { ...msgState, streamingContent: { ...msgState.streamingContent, streamer: (msgState.streamingContent.streamer || '') + 'chunk ' } }
    await React.act(async () => { mStore.publish(msgState) })
    if (i === 30) {
      msgState = { ...msgState, toolResults: { ...msgState.toolResults, streamer: { t1: { output: 'ok' } } } }
      await React.act(async () => { mStore.publish(msgState) })
    }
    if (i % 3 === 0) {
      instState = { ...instState, instances: instState.instances.map((x: any) => x.id === 'streamer' ? { ...x, state: 'running', turnOutputTokens: i } : x) }
      await React.act(async () => { iStore.publish(instState) })
    }
  }
  const idleExtra = ids.slice(1).map(id => renders[id] - mounted[id])
  check('idle tiles do not re-render while another chat streams', idleExtra.every(n => n === 0), `extra renders per idle tile: ${idleExtra.join(', ')}`)
  const streamerExtra = renders.streamer - mounted.streamer
  check('the streaming tile does re-render for its own output', streamerExtra >= 60, `extra renders: ${streamerExtra}`)
  check('a whole-state reader still sees every change (so the counts above are real)', wholeRenders - wholeMounted >= 61, `extra renders: ${wholeRenders - wholeMounted}`)

  // A change to one idle chat re-renders that tile only.
  msgState = { ...msgState, messages: { ...msgState.messages, idle2: [...msgState.messages.idle2, { id: 'idle2-m2' }] } }
  const before = { ...renders }
  await React.act(async () => { mStore.publish(msgState) })
  check('a message in one idle chat re-renders that tile only', renders.idle2 - before.idle2 === 1 && renders.idle1 === before.idle1 && renders.idle3 === before.idle3 && renders.streamer === before.streamer)
  await React.act(async () => { root.unmount() })
}

// ---------- 3. Pure helpers ----------

async function helpers(): Promise<void> {
  let planMod: Record<string, any> | null = null
  let upsertMod: Record<string, any> | null = null
  try { planMod = await import('../src/utils/planWrite.js') } catch { /* missing on main */ }
  try { upsertMod = await import('../src/utils/taskUpsert.js') } catch { /* missing on main */ }
  if (!planMod?.isPlanFileWrite) {
    check('plan-file check without parsing the payload exists', false, 'utils/planWrite missing')
  } else {
    const parsed = (tool: string, input: string) => {
      if (tool !== 'Write') return false
      try { return !!JSON.parse(input)?.file_path?.includes('.claude/plans/') } catch { return false }
    }
    const cases: Array<[string, string]> = [
      ['Write', JSON.stringify({ file_path: 'C:/Users/me/.claude/plans/plan.md', content: 'hi' })],
      ['Write', JSON.stringify({ file_path: 'C:\\Users\\me\\.claude\\plans\\plan.md', content: 'hi' })],
      ['Write', JSON.stringify({ file_path: '/home/me/.claude/plans/a.md' })],
      ['Write', '{"file_path":"\\/home\\/me\\/.claude\\/plans\\/a.md","content":"y"}'],
      ['Write', JSON.stringify({ content: 'mentions "file_path": ".claude/plans/" inside', file_path: 'src/a.ts' })],
      ['Write', JSON.stringify({ file_path: 'src/.claude/plansx.md' })],
      ['Write', '{"file_path":"C:/x/.claude/pl'],
      ['Edit', JSON.stringify({ file_path: 'C:/Users/me/.claude/plans/plan.md' })],
      ['Write', ''],
    ]
    const mismatches = cases.filter(([t, i], n) => {
      // Case 3 is the escaped-slash form: the old parse reads it as a plan too.
      return planMod!.isPlanFileWrite(t, i) !== parsed(t, i) ? (console.log(`   case ${n}: new=${planMod!.isPlanFileWrite(t, i)} old=${parsed(t, i)}`), true) : false
    })
    check('plan-file check gives the same answer as the full parse', mismatches.length === 0)
    const big = JSON.stringify({ file_path: 'C:/work/out.txt', content: 'x'.repeat(2_000_000) })
    const realParse = JSON.parse
    let parses = 0
    JSON.parse = ((...a: Parameters<typeof JSON.parse>) => { parses++; return realParse(...a) }) as typeof JSON.parse
    for (let i = 0; i < 50; i++) planMod.isPlanFileWrite('Write', big)
    JSON.parse = realParse
    check('a 2 MB Write payload is never JSON-parsed by the plan check', parses === 0, `parses: ${parses}`)
  }
  if (!upsertMod?.upsertTask || !upsertMod?.shareInFlight) {
    check('one-card board update helpers exist', false, 'utils/taskUpsert missing')
    return
  }
  const t = (id: string, priority: number, createdAt: number, title = id) => ({ id, priority, createdAt, title }) as any
  const list = [t('a', 1, 10), t('b', 2, 5), t('c', 2, 20)]
  const up = upsertMod.upsertTask(list, t('b', 2, 5, 'b edited'))
  check('an updated card is replaced in place', up.map((x: any) => x.id).join() === 'a,b,c' && up[1].title === 'b edited')
  const ins = upsertMod.upsertTask(list, t('d', 1, 15))
  check('a new card lands where the server orders it (priority, then created)', ins.map((x: any) => x.id).join() === 'a,d,b,c')
  const moved = upsertMod.upsertTask(list, t('c', 1, 20))
  check('a card whose priority changed moves like a full refetch would put it', moved.map((x: any) => x.id).join() === 'a,c,b')
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const shared = upsertMod.shareInFlight(async (p: string, id: string) => { calls++; await gate; return t(id, 1, 1, p) })
  const both = Promise.all([shared('p1', 'x'), shared('p1', 'x'), shared('p1', 'y')])
  release()
  const [r1, r2] = await both
  check('two listeners asking for the same card share one request', calls === 2 && r1 === r2, `requests: ${calls}`)
  await shared('p1', 'x')
  check('a later ask fetches again (nothing cached past the request)', calls === 3)
  // A second change to the same card while the first fetch is still out must not reuse it.
  let open!: () => void
  const slow = new Promise<void>(r => { open = r })
  let n = 0
  const order: number[] = []
  const later = upsertMod.shareInFlight(async (_p: string, id: string) => { const mine = ++n; if (mine === 1) await slow; order.push(mine); return t(id, 1, mine) })
  const first = later('p1', 'z')
  await Promise.resolve(); await Promise.resolve()
  const second = later('p1', 'z') // a later event, same card
  const third = later('p1', 'z') // and another, before either returned
  open()
  const [a, b, c] = await Promise.all([first, second, third])
  check('a later event for the same card gets a fetch issued after the first one (not the stale one)', a.createdAt === 1 && b.createdAt === 2 && order.join() === '1,2', `results ${a.createdAt},${b.createdAt}`)
  check('...and later asks meanwhile share that one follow-up', c === b && n === 2)
  const held = [{ ...t('a', 1, 1, 'fresh'), updatedAt: 200 }, { ...t('b', 1, 2, 'old'), updatedAt: 100 }]
  const slowList = [{ ...t('a', 1, 1, 'stale'), updatedAt: 150 }, { ...t('b', 1, 2, 'newer'), updatedAt: 180 }]
  const merged = upsertMod.keepNewer ? upsertMod.keepNewer(held, slowList) : []
  check('a slow full refetch does not put an older card back over a newer one', merged.map((x: any) => x.title).join() === 'fresh,newer')
}

try { await storeBehaviour() } catch (err) { check('store behaviour test ran', false, String(err)) }
try { await helpers() } catch (err) { check('helper tests ran', false, String(err)) }

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
