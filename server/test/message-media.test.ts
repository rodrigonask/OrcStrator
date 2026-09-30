// Screenshots and big tool payloads were stored at full size in the chat history for
// ever. A pasted image now goes to a file under the data dir and the row keeps a link plus a
// thumbnail; a tool payload is capped per field. Old rows with inline base64 still load.
// Agents are the fake claude binary; nothing real is read, written or spent.
//
//   npx tsx server/test/message-media.test.ts

import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { buildFakeClaude, sleep } from './helpers/fake-claude.js'

const fake = buildFakeClaude()
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-a10-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.ORCSTRATOR_CLAUDE_PATH = fake
process.env.FAKE_CLAUDE_SLEEP_MS = '1000'

const { scratchApp, check, done } = await import('./helpers/scratch-app.js')
const { app, db, close, dataDir } = await scratchApp(['instances', 'history', 'folders'], { guard: true })
let token = ''
try { token = ((await import('../src/services/api-auth.js')) as { getAdminToken: () => string }).getAdminToken() } catch { /* older tree: no token needed */ }
const auth = { 'x-orcstrator-token': token }
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-a10-work-'))
db.prepare('INSERT INTO folders (id, path, name) VALUES (?, ?, ?)').run('f', work, 'p')
const addChat = (id: string) =>
  db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, process_state, sort_order, created_at) VALUES (?, 'f', ?, ?, 'idle', 'idle', 0, 1)").run(id, id, work)
const waitIdle = async (id: string, ms = 15_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const r = db.prepare('SELECT process_state FROM instances WHERE id = ?').get(id) as { process_state: string } | undefined
    if (r?.process_state === 'idle') return true
    await sleep(200)
  }
  return false
}

// ── A pasted screenshot ───────────────────────────────────────────────────────────────────
{
  addChat('img')
  // Random noise does not compress: a 700x500 PNG of it is about 1 MB, a realistic screenshot size.
  const w = 700, h = 500
  const raw = crypto.randomBytes(w * h * 3)
  const png = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
  const b64 = png.toString('base64')
  const r = await app.inject({ method: 'POST', url: '/api/instances/img/send', headers: auth, payload: { text: 'look at this', images: [b64] } })
  check('setup: a message with a screenshot is sent', r.statusCode === 200, `${r.statusCode} ${r.body.slice(0, 160)}`)
  await waitIdle('img')
  const row = db.prepare("SELECT content FROM messages WHERE instance_id = 'img' AND role = 'user'").get() as { content: string } | undefined
  const blocks = row ? JSON.parse(row.content) as Array<Record<string, string>> : []
  const image = blocks.find(b => b.type === 'image') ?? {}
  check('the stored message is small (the image is not inside it)', !!row && row.content.length < 150_000, `${row?.content.length ?? 0} chars, image was ${b64.length} base64 chars`)
  check('the image block links to the stored file (url under /api/media/)', typeof image.url === 'string' && /^\/api\/media\/[a-f0-9]{64}\.png$/.test(image.url), String(image.url))
  check('... and keeps a thumbnail an older app can still show', typeof image.base64 === 'string' && image.base64.length > 100 && image.base64.length <= 64 * 1024 && image.base64.length < b64.length / 5 && image.mediaType === 'image/jpeg', `${image.base64?.length ?? 0} chars, ${image.mediaType}`)
  const file = image.url ? path.join(dataDir, 'media', image.url.split('/').pop()!) : ''
  check('the full image is a file under the data dir', !!file && fs.existsSync(file) && fs.readFileSync(file).equals(png))

  const got = image.url ? await app.inject({ method: 'GET', url: image.url }) : null
  check('GET /api/media/<name> serves the original bytes as an image', !!got && got.statusCode === 200 && got.headers['content-type'] === 'image/png' && got.rawPayload.equals(png), got ? `${got.statusCode} ${got.headers['content-type']} ${got.rawPayload.length}` : 'no url')
  const foreign = image.url ? await app.inject({ method: 'GET', url: image.url, headers: { 'sec-fetch-site': 'cross-site' } }) : null
  check('... but not to another website (the request guard applies)', !!foreign && foreign.statusCode === 403, String(foreign?.statusCode))
  const traversal = await app.inject({ method: 'GET', url: '/api/media/..%2Forcstrator.db' })
  const other = await app.inject({ method: 'GET', url: '/api/media/orcstrator.db' })
  check('... and only names it wrote itself (no path tricks, no other files)', [traversal.statusCode, other.statusCode].every(c => c === 400 || c === 404), `${traversal.statusCode} ${other.statusCode}`)
}

// ── A row saved before this change still loads ────────────────────────────────────────────
{
  addChat('old')
  const inline = Buffer.from('89504e470d0a1a0a' + '00'.repeat(64), 'hex').toString('base64')
  db.prepare("INSERT INTO messages (id, instance_id, role, content, created_at) VALUES ('old1', 'old', 'user', ?, 5)")
    .run(JSON.stringify([{ type: 'image', base64: inline, mediaType: 'image/png' }]))
  const hist = await app.inject({ method: 'GET', url: '/api/instances/old/history' })
  const msg = (hist.json() as { messages: Array<{ content: Array<Record<string, string>> }> }).messages[0]
  check('an old message with the image inline still comes back unchanged', !!msg && msg.content[0].base64 === inline && msg.content[0].url === undefined)
}

// ── A tool call with a huge payload ──────────────────────────────────────────────────────
{
  addChat('tool')
  const big = 'const x = 1\n'.repeat(30_000) // ~360k characters, a large file being written
  const out = path.join(work, 'tool.jsonl')
  fs.writeFileSync(out, JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [
    { type: 'text', text: 'writing it' },
    { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: 'C:\\code\\app\\big.ts', content: big } },
  ] } }) + '\n')
  process.env.FAKE_CLAUDE_STDOUT_FILE = out
  const r = await app.inject({ method: 'POST', url: '/api/instances/tool/send', headers: auth, payload: { text: 'write it' } })
  check('setup: the turn starts', r.statusCode === 200, `${r.statusCode} ${r.body.slice(0, 160)}`)
  await waitIdle('tool')
  delete process.env.FAKE_CLAUDE_STDOUT_FILE
  const row = db.prepare("SELECT content FROM messages WHERE instance_id = 'tool' AND role = 'assistant'").get() as { content: string } | undefined
  const call = row ? (JSON.parse(row.content) as Array<Record<string, string>>).find(b => b.type === 'tool-call') : undefined
  let input: Record<string, string> = {}
  try { input = JSON.parse(call?.input ?? '{}') } catch { /* reported below */ }
  check('a tool call with a 360k-character payload is stored capped', !!row && row.content.length < 30_000, `${row?.content.length ?? 0} chars`)
  check('... still valid, the file path kept whole and a note where the text was cut', input.file_path === 'C:\\code\\app\\big.ts' && typeof input.content === 'string' && input.content.startsWith('const x = 1') && /session transcript/.test(input.content), JSON.stringify(input).slice(0, 120))
  const text = row ? (JSON.parse(row.content) as Array<Record<string, string>>).find(b => b.type === 'text') : undefined
  check('... and the reply text itself is untouched', text?.text === 'writing it')
}

// A plan the person is about to approve, and the questions they answer, are never cut: the
// approval card is rebuilt from the stored message.
{
  const media = await import('../src/services/message-media.js') as { compactContentForStorage?: (b: Record<string, unknown>[]) => Record<string, unknown>[] }
  if (!media.compactContentForStorage) check('the plan-card exemption exists', false, 'compactContentForStorage missing')
  else {
    const plan = 'Step. '.repeat(3000)
    const [exit, planWrite, plain, ask] = media.compactContentForStorage([
      { type: 'tool-call', toolId: 'p1', toolName: 'ExitPlanMode', input: JSON.stringify({ plan }) },
      { type: 'tool-call', toolId: 'p2', toolName: 'Write', input: JSON.stringify({ file_path: 'C:/Users/me/.claude/plans/p.md', content: plan }) },
      { type: 'tool-call', toolId: 'p3', toolName: 'Write', input: JSON.stringify({ file_path: 'C:/code/a.ts', content: plan }) },
      { type: 'tool-call', toolId: 'p4', toolName: 'AskUserQuestion', input: JSON.stringify({ questions: [{ question: plan }] }) },
    ])
    check('an ExitPlanMode plan over the cap is kept whole', JSON.parse(exit.input as string).plan === plan)
    check('a plan-file Write over the cap is kept whole', JSON.parse(planWrite.input as string).content === plan)
    check('an AskUserQuestion over the cap is kept whole', JSON.parse(ask.input as string).questions[0].question === plan)
    check('... while an ordinary Write of the same size is still capped', (plain.input as string).length < plan.length)
  }
}

// A stored screenshot goes when the last chat that shows it goes, secure close included, and
// never while another chat still shows it.
{
  const row = db.prepare("SELECT content FROM messages WHERE instance_id = 'img' AND role = 'user'").get() as { content: string } | undefined
  const url = row ? ((JSON.parse(row.content) as Array<Record<string, string>>).find(b => b.type === 'image')?.url ?? '') : ''
  const file = url ? path.join(dataDir, 'media', url.split('/').pop()!) : ''
  const mm = await import('../src/services/message-media.js') as { forgetPendingMedia?: () => void; storeImageBlock: (b64: string) => Promise<{ url?: string }>; mediaNamesForInstances: (ids: string[]) => string[]; releaseMedia: (n: string[]) => number }
  mm.forgetPendingMedia?.() // the paste above finished long ago, as far as release is concerned

  // A reproduced race: the same picture is being pasted into another chat (file
  // written, row not inserted yet) when the only chat showing it is cleared.
  {
    addChat('race')
    const b64 = fs.readFileSync(file).toString('base64')
    db.prepare("INSERT INTO messages (id, instance_id, role, content, created_at) VALUES ('race1', 'race', 'user', ?, 7)")
      .run(JSON.stringify([{ type: 'image', base64: '', mediaType: 'image/png', url }]))
    const names = mm.mediaNamesForInstances(['race'])
    await mm.storeImageBlock(b64) // another chat's paste in flight: file written, its row still to come
    db.prepare("DELETE FROM messages WHERE instance_id = 'race'").run()
    mm.releaseMedia(names)
    check('a screenshot being pasted into another chat is not deleted by a release at that moment', !!file && fs.existsSync(file))
    db.prepare("DELETE FROM instances WHERE id = 'race'").run()
    mm.forgetPendingMedia?.()
  }

  addChat('img2')
  db.prepare("INSERT INTO messages (id, instance_id, role, content, created_at) VALUES ('img2a', 'img2', 'user', ?, 6)")
    .run(JSON.stringify([{ type: 'image', base64: '', mediaType: 'image/png', url }]))
  const sc = await app.inject({ method: 'POST', url: '/api/instances/img/secure-close', headers: auth, payload: {} })
  check('setup: the first chat is securely closed', sc.statusCode === 200, `${sc.statusCode} ${sc.body.slice(0, 160)}`)
  check('a screenshot another chat still shows survives the first chat\'s secure close', !!file && fs.existsSync(file))
  const del = await app.inject({ method: 'DELETE', url: '/api/instances/img2', headers: auth })
  check('setup: the second chat is deleted', del.statusCode === 200, `${del.statusCode} ${del.body.slice(0, 160)}`)
  check('... and is removed from disk when the last chat showing it is closed', !!file && !fs.existsSync(file))

  const media = await import('../src/services/message-media.js') as { sweepUnreferencedMedia?: (ms?: number) => number }
  const mediaDir = path.join(dataDir, 'media')
  fs.mkdirSync(mediaDir, { recursive: true })
  const stale = path.join(mediaDir, `${'a'.repeat(64)}.png`)
  const fresh = path.join(mediaDir, `${'b'.repeat(64)}.png`)
  fs.writeFileSync(stale, 'x'); fs.writeFileSync(fresh, 'x')
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  fs.utimesSync(stale, old, old)
  const swept = media.sweepUnreferencedMedia?.() ?? -1
  check('the maintenance sweep removes an old file no message uses, and leaves a just-written one', swept === 1 && !fs.existsSync(stale) && fs.existsSync(fresh), `swept ${swept}`)
}

done()

const reg = await import('../src/services/process-registry.js') as { processRegistry: { killAll: () => Promise<void> } }
await reg.processRegistry.killAll()
await close()
for (const dir of [fakeHome, work, path.dirname(fake)]) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* busy */ } }
process.exit(process.exitCode ?? 0)
