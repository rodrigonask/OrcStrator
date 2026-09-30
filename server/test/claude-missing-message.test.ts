// When the launcher refused the Claude binary it pins the server
// to "<claude-refused>", which is never a file. Then:
//  - a chat send tells the person what to do, instead of the masked "Something went wrong on
//    the server" that any 5xx becomes;
//  - a slash command that runs the CLI (/status) never falls back to a bare "claude.exe", which
//    Windows would look up on PATH and in the project folder: exactly the refused copy.
//
//   npx tsx server/test/claude-missing-message.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { scratchApp, check, done } from './helpers/scratch-app.js'

const MESSAGE = 'Claude AI is not set up on this computer. Go back to the OrcStrator window and click Restart.'

const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-claude-missing-'))
process.env.CLAUDE_CONFIG_DIR = claudeHome
process.env.ORCSTRATOR_CLAUDE_PATH = '<claude-refused>'

const { app, db, close } = await scratchApp(['folders', 'instances'])

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-claude-missing-proj-'))
const folder = await app.inject({ method: 'POST', url: '/api/folders', payload: { path: project, name: 'cm' } })
const pid = (folder.json() as { id: string }).id
db.prepare("INSERT INTO instances (id, folder_id, name, cwd, session_id, created_at) VALUES ('chat-m', ?, 'm', ?, ?, ?)").run(pid, project, crypto.randomUUID(), Date.now())

const send = await app.inject({ method: 'POST', url: '/api/instances/chat-m/send', payload: { text: 'hello' } })
const sendErr = (() => { try { return (send.json() as { error?: string }).error } catch { return undefined } })()
check('a chat send with no usable Claude says what to do (not the masked server error)', send.statusCode === 424 && sendErr === MESSAGE, `status ${send.statusCode} ${send.body.slice(0, 160)}`)
check('  and it carries no install command or env var name', !send.body.includes('irm') && !send.body.includes('ORCSTRATOR_CLAUDE_PATH'), send.body.slice(0, 160))

const storedRows = db.prepare("SELECT role, content FROM messages WHERE instance_id = 'chat-m'").all() as Array<{ role: string; content: string }>
check('  and the chat is left as it was: the undelivered message is not stored, and no "fresh session" note', storedRows.length === 0, JSON.stringify(storedRows).slice(0, 200))

const cmd = await app.inject({ method: 'POST', url: '/api/instances/chat-m/command', payload: { command: '/status' } })
const cmdBody = cmd.json() as { ok?: boolean; result?: string }
check('/status with no usable Claude spawns nothing and says what to do', cmdBody.ok === false && cmdBody.result === MESSAGE, cmd.body.slice(0, 160))

const doc = await app.inject({ method: 'POST', url: '/api/instances/chat-m/command', payload: { command: '/doctor' } })
const docText = (doc.json() as { result?: string }).result ?? ''
check('/doctor marks a missing Claude as a problem, not a green tick', docText.includes(`[✗] ${MESSAGE}`) && !docText.includes('[✓] Claude Code version'), docText.slice(0, 200))

const { readableError } = await import('../src/services/command-registry.js') as unknown as { readableError?: (b: string, s: number) => string }
check('a failed internal send shows the server\'s own message, not HTTP and JSON', typeof readableError === 'function' && readableError(JSON.stringify({ error: MESSAGE }), 424) === MESSAGE)

// The chat line the page shows for a send that never reached Claude (client/src/utils/sendFailure.ts).
const { sendFailureText } = await import('../../client/src/utils/sendFailure.js') as { sendFailureText?: (w: string, e: unknown) => string }
if (typeof sendFailureText !== 'function') {
  check('the page has one plain line for a failed send', false)
} else {
  const line = sendFailureText('that message', new Error(MESSAGE))
  check('the page shows the 424 as one plain line, no doubled full stop, no dash', line === `⚠ Couldn't send that message. ${MESSAGE} It was not delivered.` && !/[\u2013\u2014]/.test(line) && !line.includes('..'), line)
  check('  a server that is not answering is said in words, not "Failed to fetch"', !sendFailureText('that message', new TypeError('Failed to fetch')).includes('Failed to fetch'))
  check('  an empty reason still reads as a sentence', !sendFailureText('that answer', new Error('')).includes('. .'))
  const cmdLine = (sendFailureText as (w: string, e: unknown, v?: string, t?: string) => string)('that command', new Error('This chat no longer exists. Open it again from the sidebar.'), 'run', 'It did not run.')
  check('  a command is "run", not "sent" or "delivered"', cmdLine.startsWith("⚠ Couldn't run that command.") && cmdLine.endsWith('It did not run.') && !cmdLine.includes('delivered'), cmdLine)
}

await close()
fs.rmSync(project, { recursive: true, force: true })
fs.rmSync(claudeHome, { recursive: true, force: true })
done()
