// Client polish checks, each against the behaviour it fixes.
//   - the terminal panel goes silent after any reconnect
//   - markdown images never render; link text loses its formatting; href/title unescaped
//   - saving a card writes back fields it did not touch; closing discards edits silently
//   - Enter pressed twice creates the card twice
//   - live numbers on the board shift the layout
//
//   npx tsx client/test/client-polish.test.ts

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (p: string) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8')

let failed = 0
let passed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}
async function load<T>(p: string): Promise<T | null> {
  try { return await import(p) as T } catch (err) { console.log(`   (could not load ${p}: ${String(err).split('\n')[0]})`); return null }
}

// ---------- Terminal subscriptions survive a reconnect ----------
{
  class FakeSocket {
    static all: FakeSocket[] = []
    static OPEN = 1
    static CONNECTING = 0
    readyState = 0
    sent: string[] = []
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((e: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(public url: string) { FakeSocket.all.push(this) }
    send(d: string) { this.sent.push(d) }
    close() { this.readyState = 3 }
    open() { this.readyState = 1; this.onopen?.() }
    drop() { this.readyState = 3; this.onclose?.() }
  }
  const g = globalThis as Record<string, unknown>
  g.WebSocket = FakeSocket
  g.location = { protocol: 'http:', host: 'localhost:5174' }
  g.fetch = async () => ({ ok: true, json: async () => ({ token: 'fake-token' }) })
  const mod = await load<{ wsClient: any }>('../src/api/ws.js')
  const tick = () => new Promise(r => setTimeout(r, 0))
  if (!mod) {
    check('the WS client loads under test', false)
  } else {
    const ws = mod.wsClient
    ws.connect(); await tick(); await tick()
    FakeSocket.all.at(-1)!.open()
    ws.subscribeTerminal('chat-a')
    const first = FakeSocket.all.at(-1)!
    check('subscribing on an open socket sends it', first.sent.some(s => s.includes('subscribe:terminal') && s.includes('chat-a')))
    first.drop()
    await new Promise(r => setTimeout(r, 1100)); await tick(); await tick()
    const second = FakeSocket.all.at(-1)!
    check('the client reconnects after a drop', second !== first)
    second.open()
    check('the terminal subscription is replayed on the new socket', second.sent.some(s => s.includes('subscribe:terminal') && s.includes('chat-a')))
    // A panel opened while the socket is still connecting must not be lost either.
    second.drop()
    await new Promise(r => setTimeout(r, 2100)); await tick(); await tick()
    const third = FakeSocket.all.at(-1)!
    ws.subscribeTerminal('chat-b')
    third.open()
    check('a subscription made while connecting is sent once the socket opens', third.sent.some(s => s.includes('chat-b')))
    ws.unsubscribeTerminal('chat-a')
    ws.unsubscribeTerminal('chat-b')
    ws.disconnect()
  }
  const s = src('api/ws.ts')
  // Static twin of the behaviour above, for a tree whose ws.ts cannot load under node.
  check('onopen replays every terminal subscription', /onopen[\s\S]*?for \(const instanceId of this\.terminalSubs\.keys\(\)\)/.test(s))
  check('the reconnect timer is kept so it can be cancelled', /reconnectTimer = setTimeout/.test(s) && /clearTimeout\(this\.reconnectTimer\)/.test(s))
}

// ---------- Markdown ----------
{
  // markdown.ts pulls in the sanitizer, which installs DOMPurify hooks: it needs a window.
  const { createRequire } = await import('module')
  const req = createRequire(import.meta.url)
  let JSDOM: typeof import('jsdom').JSDOM
  try { JSDOM = req('jsdom').JSDOM } catch { JSDOM = createRequire(path.join(process.env.ORC_TEST_MODULES ?? '', 'x.js'))('jsdom').JSDOM }
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:5174/' })
  const g = globalThis as Record<string, unknown>
  g.window = dom.window
  g.document = dom.window.document
  g.Element = dom.window.Element
  g.Node = dom.window.Node
  const md =await load<{ parseMarkdown: (t: string, o?: object) => string }>('../src/utils/markdown.js')
  const lk = await load<{ autoLinkify: (h: string) => string }>('../src/utils/linkify.js')
  if (!md) check('markdown loads', false)
  else {
    const bold = md.parseMarkdown('[**bold**](https://e.example/p)')
    check('link text keeps its formatting', /<a [^>]*><strong>bold<\/strong><\/a>/.test(bold), bold.trim())
    const quoted = md.parseMarkdown('[x](https://e.example/p "say \\"hi\\" onmouseover=alert(1)")')
    check('a quote in a link title cannot close the attribute', !/"\s*onmouseover=/.test(quoted) && /&quot;/.test(quoted), quoted.trim())
  }
  if (!lk || !md) check('autoLinkify is a testable helper', false, 'utils/linkify missing')
  else {
    const img = lk.autoLinkify(md.parseMarkdown('![shot](https://host.example/a.png)'))
    check('an image keeps its src (no link spliced into the attribute)', /<img src="https:\/\/host\.example\/a\.png"/.test(img) && !/auto-url/.test(img), img.trim())
    const bare = lk.autoLinkify(md.parseMarkdown('see https://a.example/x.'))
    check('a bare URL in text is still linked once, trailing dot left out', /<a [^>]*href="https:\/\/a\.example\/x"[^>]*>https:\/\/a\.example\/x<\/a>\./.test(bare) && (bare.match(/<a /g) || []).length === 1, bare.trim())
    const inCode = lk.autoLinkify('<p>run <code>curl https://a.example/y</code></p>')
    check('a URL inside code text is still linked (text run, not attribute)', /<code>curl <a class="auto-url" href="https:\/\/a\.example\/y"/.test(inCode), inCode)
    const inLink = lk.autoLinkify(md.parseMarkdown('[docs](https://a.example/d)'))
    check('a markdown link is not wrapped twice', (inLink.match(/<a /g) || []).length === 1)
  }
  check('the chat bubble uses the shared helper', /from '..\/utils\/linkify'/.test(src('components/MessageBubble.tsx')))
}

// ---------- Card edits ----------
{
  const ce = await load<{ changedCardFields: Function; hasCardEdits: Function }>('../src/utils/cardEdits.js')
  if (!ce) check('only-changed-fields helper exists', false, 'utils/cardEdits missing')
  else {
    const loaded = { title: 'T', description: 'agent rewrote this', priority: 3, labels: ['a', 'run:ok'] }
    const none = ce.changedCardFields(loaded, { title: 'T', description: 'agent rewrote this', priority: 3, labels: ['a', 'run:ok'] })
    check('an untouched card sends nothing', Object.keys(none).length === 0)
    const onlyTitle = ce.changedCardFields(loaded, { title: 'New title', description: 'agent rewrote this', priority: 3, labels: ['a', 'run:ok'] })
    check('editing the title sends the title only', JSON.stringify(Object.keys(onlyTitle)) === '["title"]')
    check('dirty tracks real edits', ce.hasCardEdits(loaded, { ...loaded, labels: ['a'] }) === true && ce.hasCardEdits(loaded, { ...loaded }) === false && ce.hasCardEdits(null, loaded) === false)
    // The run settings follow the same rule. A Save after the scheduler disarmed the
    // card must not re-arm it, and an untouched form sends nothing.
    const csf = (ce as { changedSettingFields?: Function }).changedSettingFields
    const row = { model: 'haiku', scheduleEnabled: false, allowedTools: ['Read'], budgetUsd: null }
    check('untouched run settings send nothing (a disarmed schedule stays off)',
      !!csf && Object.keys(csf(row, { model: 'haiku', scheduleEnabled: false, allowedTools: ['Read'], budgetUsd: undefined })).length === 0)
    check('a changed run setting is sent alone',
      !!csf && JSON.stringify(csf(row, { model: 'sonnet', scheduleEnabled: false, allowedTools: ['Read'], budgetUsd: null })) === '{"model":"sonnet"}')
  }
  const panel = src('components/pipeline/TaskDetailPanel.tsx')
  check('Save sends only the changed fields', /changedCardFields\(full,/.test(panel) && !/updateTask\(projectId, task\.id, \{ title, description, priority, labels,/.test(panel))
  check('closing with changed run settings asks too, and Save sends only the changed settings',
    /if \(!dirty && !settingsDirty\(\)\)/.test(panel) && /changedSettingFields\(full, settings\)/.test(panel))
  check('a title typed before the card finished loading is kept', /setTitle\(t => \(t === task\.title \? fetched\.title : t\)\)/.test(panel))
  check('backdrop, x and Escape ask before discarding edits', /task-detail-backdrop" onClick=\{\(\) => void requestClose\(\)\}/.test(panel) && /modal-close" onClick=\{\(\) => void requestClose\(\)\}/.test(panel) && /Escape'\) void requestClose\(\)/.test(panel))
}

// ---------- Single-flight save ----------
{
  const sf = await load<{ singleFlight: <A extends unknown[]>(f: (...a: A) => Promise<void>) => (...a: A) => Promise<void> }>('../src/hooks/useSingleFlight.js')
  if (!sf) check('single-flight guard exists', false, 'hooks/useSingleFlight missing')
  else {
    let creates = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const save = sf.singleFlight(async () => { creates++; await gate })
    const a = save(); const b = save() // two Enter presses in the same tick
    release(); await Promise.all([a, b])
    check('two presses before the first save returns create one card', creates === 1, `creates: ${creates}`)
    await save()
    check('a later press after it finished saves again', creates === 2)
  }
  check('the create modal saves through the guard', /const handleSave = useSingleFlight\(/.test(src('components/pipeline/CreateTaskModal.tsx')))
}

// ---------- Reserved widths ----------
{
  const css = src('styles.css')
  const rule = (sel: string) => (css.match(new RegExp(`\\n${sel.replace('.', '\\.')} \\{([^}]*)\\}`)) || [])[1] ?? ''
  const count = rule('.pipeline-column-count')
  const cost = rule('.task-cost-badge')
  check('the column count uses equal-width digits and a minimum width', /tabular-nums/.test(count) && /min-width/.test(count))
  check('the card cost badge uses equal-width digits and a minimum width', /tabular-nums/.test(cost) && /min-width/.test(cost))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
