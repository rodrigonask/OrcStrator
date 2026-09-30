// Where secrets end up on disk, in logs and in the chat.
// Every key here is synthetic, built at runtime. Claude's folder is a temp CLAUDE_CONFIG_DIR
// and the claude binary is pointed at nothing, so no real transcript or agent is touched.
//
//   npx tsx server/test/secrets-at-rest.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import { scratchApp, check, done } from './helpers/scratch-app.js'

const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-claude-'))
process.env.CLAUDE_CONFIG_DIR = claudeHome
process.env.ORCSTRATOR_CLAUDE_PATH = path.join(claudeHome, 'no-such-claude.exe')

// A stand-in for this server's own HTTP port, to see what a slash command sends.
const captured: Array<{ url: string; token: string | undefined; body: string }> = []
const capture = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    captured.push({ url: req.url ?? '', token: req.headers['x-orcstrator-token'] as string | undefined, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
})
await new Promise<void>(r => capture.listen(0, '127.0.0.1', () => r()))
process.env.PORT = String((capture.address() as { port: number }).port)

const { app, db, dataDir, close } = await scratchApp(['folders', 'instances'])

const key = 'sk-' + 'ant-api03-' + crypto.randomBytes(30).toString('base64url')
const meta = 'EA' + 'A' + crypto.randomBytes(60).toString('hex')
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-g2-'))
const folder = await app.inject({ method: 'POST', url: '/api/folders', payload: { path: project, name: 'g2' } })
const pid = (folder.json() as { id: string }).id
const sid = crypto.randomUUID()
db.prepare("INSERT INTO instances (id, folder_id, name, cwd, session_id, created_at) VALUES ('chat-s', ?, 's', ?, ?, ?)").run(pid, project, sid, Date.now())

// ── Every copy, sidecar and backup of the session ───────────────────────────────────
const projects = path.join(claudeHome, 'projects')
const slugA = path.join(projects, project.replace(/[^a-zA-Z0-9]/g, '-'))
const slugB = path.join(projects, 'C--old-worktree-copy')
fs.mkdirSync(path.join(slugA, sid, 'subagents'), { recursive: true })
fs.mkdirSync(path.join(slugA, sid, 'tool-results'), { recursive: true })
fs.mkdirSync(slugB, { recursive: true })
const line = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
const files = {
  main: path.join(slugA, `${sid}.jsonl`),
  copy: path.join(slugB, `${sid}.jsonl`),
  sub: path.join(slugA, sid, 'subagents', 'agent-1.jsonl'),
  tool: path.join(slugA, sid, 'tool-results', 'out.txt'),
}
fs.writeFileSync(files.main, line(`my key is ${key}`) + '\n')
fs.writeFileSync(files.copy, line(`old copy ${key}`) + '\n')
fs.writeFileSync(files.sub, line(`subagent saw ${meta}`) + '\n')
fs.writeFileSync(files.tool, `ANTHROPIC_API_KEY=${key}\n`)
const backup = path.join(slugA, `${sid}.jsonl.bak-1700000000000`)
fs.writeFileSync(backup, line(`backup ${key}`) + '\n')
// Claude's other per-session folders.
fs.mkdirSync(path.join(claudeHome, 'debug'), { recursive: true })
const debugLog = path.join(claudeHome, 'debug', `${sid}.txt`)
fs.writeFileSync(debugLog, `[DEBUG] request with Authorization: Bearer ${key}\n`)
fs.mkdirSync(path.join(claudeHome, 'file-history', sid), { recursive: true })
const edited = path.join(claudeHome, 'file-history', sid, 'a1b2c3@v2')
fs.writeFileSync(edited, `SUPABASE_SERVICE_ROLE_KEY=${key}\n`)
fs.mkdirSync(path.join(claudeHome, 'session-env', sid), { recursive: true })
const hookScript = path.join(claudeHome, 'session-env', sid, 'sessionstart-hook-1.sh')
fs.writeFileSync(hookScript, `export GITHUB_TOKEN=${'gh' + 'p_' + crypto.randomBytes(18).toString('hex')}\nexport ANTHROPIC_API_KEY=${key}\n`)
// A binary with no NUL byte (a PDF) was decoded and rewritten.
const pdf = path.join(claudeHome, 'file-history', sid, 'd4e5f6@v1')
const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n%'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0xff, 0x80, 0x01, 0x1f]), Buffer.from(`\nkey ${key}\n`)])
fs.writeFileSync(pdf, pdfBytes)
// Text in other encodings is still scrubbed, and only the key changes.
const latin1 = path.join(claudeHome, 'file-history', sid, 'e7f8a9@v1')
fs.writeFileSync(latin1, Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(` key=${key}\n`)]))
const utf16 = path.join(claudeHome, 'session-env', sid, 'env-dump.txt')
// An odd trailing byte (a truncated write) must survive the rewrite.
fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`ANTHROPIC_API_KEY=${key}\r\n`, 'utf16le'), Buffer.from([0x41])]))
const lateNul = path.join(claudeHome, 'file-history', sid, 'b0c1d2@v1')
fs.writeFileSync(lateNul, Buffer.concat([Buffer.from('x'.repeat(9000)), Buffer.from([0]), Buffer.from(` ${key}\n`)]))
const unrelated = path.join(slugA, `${crypto.randomUUID()}.jsonl`)
fs.writeFileSync(unrelated, line(`another chat ${key}`) + '\n')

// The summary capture: a message with a key in the chat's history.
db.prepare("INSERT INTO messages (id, instance_id, role, content, created_at) VALUES ('m1', 'chat-s', 'user', ?, ?)").run(JSON.stringify([{ type: 'text', text: `use ${key} please` }]), Date.now())
const { captureForSummary } = await import('../src/services/session-summarizer.js')
const cap = captureForSummary('chat-s')
check('the close summary never sees the key (it went to a model and a task comment)', !!cap && !JSON.stringify(cap.transcript).includes(key))

// ── The agent is stopped BEFORE the scrub ──────────────────────────────────────────
// Stand-in for a running agent: stopping it makes it flush one last line, with a key in it.
const { processRegistry } = await import('../src/services/process-registry.js')
const realKill = processRegistry.killProcess.bind(processRegistry)
;(processRegistry as unknown as { killProcess: (id: string) => Promise<unknown> }).killProcess = async (id: string) => {
  if (id === 'chat-s') fs.appendFileSync(files.main, line(`last words ${meta}`) + '\n')
  return realKill(id)
}
const closeRes = await app.inject({ method: 'POST', url: '/api/instances/chat-s/secure-close', payload: {} })
check('secure close answers', closeRes.statusCode === 200, `status ${closeRes.statusCode} ${closeRes.body.slice(0, 120)}`)
const after = (f: string) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
check('a line the agent wrote while being stopped is scrubbed too (scrub ran after the kill)', !after(files.main).includes(meta))
check('the main transcript is scrubbed', !after(files.main).includes(key))
check('a copy under another project folder (an old worktree) is scrubbed', !after(files.copy).includes(key))
check('a subagent transcript is scrubbed', !after(files.sub).includes(meta))
check('a saved tool result is scrubbed', !after(files.tool).includes(key))
check('the sanitizer backup holding the key is deleted', !fs.existsSync(backup))
check('each rewritten JSONL line is still valid JSON', after(files.main).trim().split('\n').every(l => { try { JSON.parse(l); return true } catch { return false } }))
check('another chat\'s transcript is left alone', after(unrelated).includes(key))
check('the session\'s debug log is scrubbed', !after(debugLog).includes(key))
check('the session\'s file edit history is scrubbed', !after(edited).includes(key))
check('a hook script in the session\'s env folder is scrubbed (any text file, not only known extensions)', !after(hookScript).includes(key))
check('a binary that is not valid UTF-8 (a PDF) is left byte for byte', fs.readFileSync(pdf).equals(pdfBytes))
{
  const l = fs.readFileSync(latin1)
  check('a Latin-1 text file is scrubbed and keeps its other bytes', !l.toString('latin1').includes(key) && l.subarray(0, 4).equals(Buffer.from([0x63, 0x61, 0x66, 0xe9])))
  const u = fs.readFileSync(utf16)
  check('a UTF-16 text file (PowerShell 5.1 ">") is scrubbed and stays UTF-16', u[0] === 0xff && u[1] === 0xfe && !u.subarray(2).toString('utf16le').includes(key) && u.subarray(2).toString('utf16le').startsWith('ANTHROPIC_API_KEY=') && u.length % 2 === 1 && u[u.length - 1] === 0x41)
  check('a UTF-8 text file with a NUL byte past 8 KB is scrubbed', !fs.readFileSync(lateNul, 'utf8').includes(key))
}

// ── Agent stderr in the server log ──────────────────────────────────────────────────
try {
  const { stderrLogLine } = await import('../src/services/claude-process.js') as unknown as { stderrLogLine: (l: string) => string }
  const logged = stderrLogLine(`Error: request failed with Authorization: Bearer ${key} ` + 'x'.repeat(2000))
  check('a stderr line is logged without the key', !logged.includes(key))
  check('... and capped at about 500 characters', logged.length <= 520, `length ${logged.length}`)
  const straddle = stderrLogLine('x'.repeat(480) + ` ${key}`)
  check('a key that straddles the cap leaves no fragment behind', !straddle.includes(key.slice(0, 18)))
  // The two compact paths log stderr too. A structural check:
  // every console line in claude-process.ts that prints stderr goes through stderrLogLine.
  const cpSrc = fs.readFileSync(path.resolve('server/src/services/claude-process.ts'), 'utf8')
  const stderrLogs = cpSrc.split('\n').filter(l => /console\.(warn|error|log)\(/.test(l) && /stderr/i.test(l) && /\$\{stderrOut|, line\b|stderrOut\.trim\(\)/.test(l))
  // At least one known site must be found, or an empty list would pass vacuously. (The
  // two compact paths into one helper, runCompactChild, so there is one site now.)
  check('every stderr log line in claude-process.ts is redacted', stderrLogs.length >= 1 && stderrLogs.every(l => l.includes('stderrLogLine')), stderrLogs.filter(l => !l.includes('stderrLogLine')).map(l => l.trim().slice(0, 80)).join(' | '))
} catch (err) {
  check('stderrLogLine exists', false, (err as Error).message.slice(0, 80))
}

// ── The stored secrets key ──────────────────────────────────────────────────────────
try {
  const box = await import('../src/services/secret-box.js') as Record<string, unknown>
  const encrypt = box.encrypt as (t: string) => string
  const decrypt = box.decrypt as (t: string) => string
  const sealed = encrypt(key)
  check('a stored secret round-trips', decrypt(sealed) === key)
  check('it is written in the new format', sealed.startsWith('v2:'), sealed.slice(0, 8))
  // What an attacker with only the DB could do before: derive the key from hostname + username.
  const oldKey = crypto.createHash('sha256').update(`${os.hostname()}:${os.userInfo().username}:orcstrator-token-key`).digest()
  let leaked = ''
  try {
    const raw = sealed.startsWith('v2:') ? Buffer.from(sealed.slice(3), 'base64') : Buffer.alloc(0)
    const d = crypto.createDecipheriv('aes-256-gcm', oldKey, raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(12, 28))
    leaked = d.update(raw.subarray(28)) + d.final('utf8')
  } catch { /* expected */ }
  if (!sealed.startsWith('v2:')) {
    const [iv, tag, ct] = sealed.split(':')
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', oldKey, Buffer.from(iv, 'hex'))
      d.setAuthTag(Buffer.from(tag, 'hex'))
      leaked = d.update(Buffer.from(ct, 'hex')) + d.final('utf8')
    } catch { /* not the old format either */ }
  }
  check('hostname + username no longer decrypt a stored secret (it used to be decrypted offline)', leaked !== key)
  const keyFile = path.join(dataDir, 'secret-key')
  const keyText = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : ''
  check('the key lives in <data dir>/secret-key, not in the database', keyText.length > 10)
  if (process.platform === 'win32') check('(win) the key file holds a DPAPI-wrapped key', keyText.startsWith('dpapi:'), keyText.slice(0, 6))
  // Old rows: still readable, re-encrypted once, reversible.
  const [iv, ct] = [crypto.randomBytes(12), null]
  void ct
  const c = crypto.createCipheriv('aes-256-gcm', oldKey, iv)
  const enc = Buffer.concat([c.update('legacy-secret-value-123', 'utf8'), c.final()])
  const legacy = iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + enc.toString('hex')
  check('a value in the old format still decrypts', decrypt(legacy) === 'legacy-secret-value-123')
  db.prepare("INSERT OR REPLACE INTO secrets (key, value) VALUES ('probe', ?)").run(legacy)
  const up = (box.reencryptLegacySecrets as (d: unknown) => number)(db)
  const stored = (db.prepare("SELECT value FROM secrets WHERE key = 'probe'").get() as { value: string }).value
  check('boot re-encrypts old values under the new key', up >= 1 && stored.startsWith('v2:') && decrypt(stored) === 'legacy-secret-value-123', `rewrote ${up}`)
  const again = (box.reencryptLegacySecrets as (d: unknown) => number)(db)
  check('... and running it again changes nothing (idempotent)', again === 0 && (db.prepare("SELECT value FROM secrets WHERE key = 'probe'").get() as { value: string }).value === stored)
  const down = (box.downgradeSecretsToLegacy as (d: unknown) => number)(db)
  const back = (db.prepare("SELECT value FROM secrets WHERE key = 'probe'").get() as { value: string }).value
  check('it is reversible for a rollback', down >= 1 && !back.startsWith('v2:') && decrypt(back) === 'legacy-secret-value-123')
} catch (err) {
  check('secret-box loads', false, (err as Error).message.slice(0, 100))
}

// An unreadable key file is read once, not on every decrypt.
{
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-g3-bad-'))
  fs.writeFileSync(path.join(badDir, 'orcstrator.db'), '')
  fs.writeFileSync(path.join(badDir, 'secret-key'), 'dpapi:AAAA\n')
  const probe = "(async () => { const b = await import('./server/src/services/secret-box.ts'); for (let i = 0; i < 3; i++) b.decrypt('v2:' + Buffer.alloc(40).toString('base64')); console.log('done') })()"
  const { spawnSync } = await import('child_process')
  const { createRequire } = await import('module')
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [tsxCli, '--eval', probe], { cwd: path.resolve('.'), env: { ...process.env, ORCSTRATOR_DATA_DIR: badDir }, encoding: 'utf8' })
  const warnings = ((r.stdout ?? '') + (r.stderr ?? '')).split('\n').filter(l => l.includes('[secret-box]')).length
  check('a key file that cannot be read is tried once, then reported once (not on every decrypt)', /done/.test(r.stdout ?? '') && warnings === 1, `${warnings} warning(s), ${Date.now() - t0} ms`)
  fs.rmSync(badDir, { recursive: true, force: true })
}

// ── Tool outputs on disk, and the hook's data dir ──────────────────────────────────
try {
  const ret = await import('../src/services/data-retention.js') as Record<string, unknown>
  const ccr = path.join(dataDir, 'ccr')
  fs.mkdirSync(ccr, { recursive: true })
  const oldOut = path.join(ccr, 'old.txt')
  const newOut = path.join(ccr, 'new.txt')
  fs.writeFileSync(oldOut, `tool printed ${key}`)
  fs.writeFileSync(newOut, 'recent')
  const eightDaysAgo = (Date.now() - 8 * 24 * 3600 * 1000) / 1000
  fs.utimesSync(oldOut, eightDaysAgo, eightDaysAgo)
  const removed = (ret.sweepToolOutputs as () => number)()
  check('stored tool outputs older than 7 days are deleted (they were kept forever)', removed === 1 && !fs.existsSync(oldOut) && fs.existsSync(newOut))
  const settingsDir = path.join(dataDir, 'cli-settings')
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(path.join(settingsDir, 'gone-chat.settings.json'), '{}')
  const orphans = (ret.sweepOrphanSettingsFiles as () => number)()
  check('a closed chat\'s settings file is removed', orphans === 1 && !fs.existsSync(path.join(settingsDir, 'gone-chat.settings.json')))
  const logPath = path.join(dataDir, 'compaction-log.jsonl')
  fs.writeFileSync(logPath, 'x'.repeat(2048))
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('compactionLogOffset', '2048')").run()
  const rotated = (ret.rotateCompactionLog as (n: number) => boolean)(1024)
  const offset = (db.prepare("SELECT value FROM settings WHERE key = 'compactionLogOffset'").get() as { value: string }).value
  check('rotating the compaction log starts reading the new one from the top', rotated && Number(JSON.parse(offset)) === 0, `offset ${offset}`)
  const { agentEnvFor } = await import('../src/services/api-auth.js')
  check('the compaction hook is told this server\'s data dir', agentEnvFor('x').ORCSTRATOR_DATA_DIR === dataDir)
} catch (err) {
  check('data-retention loads', false, (err as Error).message.slice(0, 100))
}

// ── Slash commands ──────────────────────────────────────────────────────────────────
db.prepare("INSERT INTO instances (id, folder_id, name, cwd, session_id, created_at) VALUES ('chat-c', ?, 'c', ?, ?, ?)").run(pid, project, crypto.randomUUID(), Date.now())
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('permissionAllowRules', ?)").run(JSON.stringify(['Bash(npm test:*)']))
const { dispatchCommand } = await import('../src/services/command-registry.js')
const ctx = { instanceId: 'chat-c', sessionId: 'x', cwd: project, args: '', flags: [] as string[] }
const perms = await dispatchCommand('/permissions', ctx)
check('/permissions shows the rules this chat actually runs with (said "Allow: none")', perms.result.includes('Bash(npm test:*)'), perms.result.slice(0, 160))
try {
  const { redactForChat } = await import('../src/services/command-registry.js') as unknown as { redactForChat: (t: string) => string }
  const hook = `node C:\\hooks\\notify.mjs --token=${crypto.randomBytes(24).toString('hex')}`
  check('a hook command with an inline token is printed without it', !redactForChat(hook).includes(hook.split('=')[1]) && redactForChat(hook).includes('notify.mjs'), redactForChat(hook))
} catch (err) {
  check('redactForChat exists', false, (err as Error).message.slice(0, 80))
}
captured.length = 0
const skill = await dispatchCommand('/simplify', ctx)
const sent = captured.find(c => c.url.includes('/api/instances/chat-c/send'))
check('a skill runs as an ordinary turn of this chat (was a detached claude -p)', !!sent && sent.body.includes('/simplify'), JSON.stringify(skill).slice(0, 120))
check('... sent with the app\'s own token', !!sent?.token && sent.token.length >= 32)

capture.close()
fs.rmSync(project, { recursive: true, force: true })
fs.rmSync(claudeHome, { recursive: true, force: true })
await close()
done()
