// Dead endpoints are gone. /agents/sync-native (it read a server folder that no
// longer exists, yet the Agents page called it on every open), /agents/scan (it returned the
// .md files, with contents, of any folder under home; nothing called it with a folder), the
// legacy skills create and delete (no caller), and /mcp/available (no caller). The skills
// list the chat header uses stays.
//
//   npx tsx server/test/dead-endpoints.test.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-dead-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR

const { scratchApp, check, done } = await import('./helpers/scratch-app.js')
const { app, close } = await scratchApp(['agents', 'skills', 'mcp'] as never)

// A folder under the home folder with a note in it: what /agents/scan used to hand back.
const notes = path.join(fakeHome, 'private-notes')
fs.mkdirSync(notes, { recursive: true })
fs.writeFileSync(path.join(notes, 'diary.md'), '# private diary')

const hit = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) => {
  const res = await app.inject({ method, url, ...(payload ? { payload } : {}) })
  return { status: res.statusCode, body: res.body }
}

const sync = await hit('POST', '/api/agents/sync-native')
check('POST /agents/sync-native is gone (404)', sync.status === 404, `status ${sync.status}`)
const scan = await hit('POST', '/api/agents/scan', { directory: notes })
check('POST /agents/scan is gone and hands back no file contents', scan.status === 404 && !scan.body.includes('private diary'),
  `status ${scan.status}`)
const createSkill = await hit('POST', '/api/skills', { name: 'x' })
check('POST /skills (legacy create) is gone (404)', createSkill.status === 404, `status ${createSkill.status}`)
const deleteSkill = await hit('DELETE', '/api/skills/some-id')
check('DELETE /skills/:id (legacy delete) is gone (404)', deleteSkill.status === 404, `status ${deleteSkill.status}`)
const mcp = await hit('GET', '/api/mcp/available')
check('GET /mcp/available is gone (404)', mcp.status === 404, `status ${mcp.status}`)

const listSkills = await hit('GET', '/api/skills')
check('setup: GET /skills, which the chat header uses, still works', listSkills.status === 200, `status ${listSkills.status}`)
const listAgents = await hit('GET', '/api/agents')
check('setup: GET /agents still works', listAgents.status === 200, `status ${listAgents.status}`)

const hook = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src', 'hooks', 'useAgents.ts'), 'utf8')
check('the Agents page no longer calls the removed sync endpoint', !/syncNativeAgents|sync-native/.test(hook))

await close()
fs.rmSync(fakeHome, { recursive: true, force: true })
done()
