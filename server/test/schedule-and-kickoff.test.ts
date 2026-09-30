// A one-field edit re-armed a paused routine, and `$` in card text was altered.
//
//   npx tsx server/test/schedule-and-kickoff.test.ts

import os from 'os'
import { scratchApp, check, done } from './helpers/scratch-app.js'

const { app, db, close } = await scratchApp(['folders', 'pipeline'])
type Json = Record<string, unknown>
async function call(method: 'POST' | 'PUT' | 'GET', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Json } : {}) })
  return { status: res.statusCode, body: res.json() as Json }
}

const folder = await call('POST', '/api/folders', { path: os.tmpdir(), name: 'c12' })
const pid = folder.body.id as string
const tasksUrl = `/api/pipelines/${pid}/tasks`

// ── Paused stays paused ─────────────────────────────────────────────────────
const paused = await call('POST', tasksUrl, { title: 'paused', description: 'x', scheduleKind: 'every', scheduleValue: '60', scheduleEnabled: false })
const pausedId = paused.body.id as string
check('seed: routine created paused', paused.body.scheduleEnabled === false && paused.body.nextRunAt == null, JSON.stringify({ e: paused.body.scheduleEnabled, n: paused.body.nextRunAt }))
const tz = await call('PUT', `${tasksUrl}/${pausedId}`, { scheduleTz: 'UTC' })
check('PUT {scheduleTz} alone keeps a paused routine paused (was re-armed)', tz.body.scheduleEnabled === false && tz.body.nextRunAt == null, JSON.stringify({ e: tz.body.scheduleEnabled, n: tz.body.nextRunAt }))
const days = await call('PUT', `${tasksUrl}/${pausedId}`, { scheduleDays: '1,2,3' })
check('PUT {scheduleDays} alone keeps it paused too', days.body.scheduleEnabled === false, JSON.stringify(days.body.scheduleEnabled))
const arm = await call('PUT', `${tasksUrl}/${pausedId}`, { scheduleEnabled: true })
check('arming it explicitly still works', arm.body.scheduleEnabled === true && typeof arm.body.nextRunAt === 'number', JSON.stringify({ e: arm.body.scheduleEnabled, n: arm.body.nextRunAt }))
const tz2 = await call('PUT', `${tasksUrl}/${pausedId}`, { scheduleTz: 'Europe/London' })
check('an armed routine stays armed on a one-field edit', tz2.body.scheduleEnabled === true, JSON.stringify(tz2.body.scheduleEnabled))

const plain = await call('POST', tasksUrl, { title: 'plain card' })
const given = await call('PUT', `${tasksUrl}/${plain.body.id}`, { scheduleKind: 'every', scheduleValue: '120' })
check('a card GIVEN its first schedule is armed (unchanged behaviour)', given.body.scheduleEnabled === true, JSON.stringify(given.body.scheduleEnabled))

// ── A one-off that already ran does not fire again ─────────────────────────────
const when = new Date(Date.now() + 86_400_000)
const pad = (n: number) => String(n).padStart(2, '0')
const onceAt = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T09:00`
const once = await call('POST', tasksUrl, { title: 'one-off', description: 'send the report', scheduleKind: 'once', scheduleValue: onceAt, scheduleTz: 'UTC' })
const onceId = once.body.id as string
// What the scheduler leaves behind after the one-off fires at its (now past) time: disarmed,
// with a last run after the slot.
const ago = new Date(Date.now() - 3_600_000)
const pastAt = `${ago.getUTCFullYear()}-${pad(ago.getUTCMonth() + 1)}-${pad(ago.getUTCDate())}T${pad(ago.getUTCHours())}:${pad(ago.getUTCMinutes())}`
db.prepare('UPDATE pipeline_tasks SET schedule_value = ?, schedule_enabled = 0, next_run_at = NULL, last_run_at = ?, run_count = 1 WHERE id = ?').run(pastAt, Date.now(), onceId)
const onceTz = await call('PUT', `${tasksUrl}/${onceId}`, { scheduleTz: 'UTC' })
check('a finished one-off stays off when one field is edited', onceTz.body.scheduleEnabled === false && onceTz.body.nextRunAt == null, JSON.stringify({ e: onceTz.body.scheduleEnabled, n: onceTz.body.nextRunAt }))
const bareRearm = await call('PUT', `${tasksUrl}/${onceId}`, { scheduleEnabled: true })
check('a bare {scheduleEnabled:true} on a spent one-off is refused (it would fire again)', bareRearm.status === 400, `status ${bareRearm.status}`)
const onceRearm = await call('PUT', `${tasksUrl}/${onceId}`, { scheduleEnabled: true, scheduleKind: 'once', scheduleValue: pastAt })
check('re-arming a finished one-off at the SAME time is refused', onceRearm.status === 400, `status ${onceRearm.status}`)
const later = new Date(Date.now() + 2 * 86_400_000)
const laterAt = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T09:00`
const onceNew = await call('PUT', `${tasksUrl}/${onceId}`, { scheduleEnabled: true, scheduleKind: 'once', scheduleValue: laterAt })
check('a one-off given a NEW time can be armed', onceNew.status === 200 && onceNew.body.scheduleEnabled === true, `status ${onceNew.status}`)

// ── A one-off re-armed for a new time is not "already run" ─────────
db.prepare('UPDATE pipeline_tasks SET last_run_at = ? WHERE id = ?').run(Date.now() - 5 * 86_400_000, onceId)
const modalSave = await call('PUT', `${tasksUrl}/${onceId}`, { title: 'renamed', scheduleKind: 'once', scheduleValue: laterAt, scheduleTz: 'UTC', scheduleEnabled: true })
check('a one-off re-armed for a future time can still be saved from the modal', modalSave.status === 200 && modalSave.body.scheduleEnabled === true, `status ${modalSave.status} ${JSON.stringify(modalSave.body.error ?? '')}`)
const futureTz = await call('PUT', `${tasksUrl}/${onceId}`, { scheduleTz: 'Europe/London' })
check('... and a one-field edit keeps it armed', futureTz.body.scheduleEnabled === true, JSON.stringify(futureTz.body.scheduleEnabled))

// ── "false" means false ────────────────────────────────────────
const p2 = await call('POST', tasksUrl, { title: 'paused2', description: 'x', scheduleKind: 'every', scheduleValue: '60', scheduleEnabled: false })
const strFalse = await call('PUT', `${tasksUrl}/${p2.body.id}`, { scheduleEnabled: 'false' })
check('PUT {scheduleEnabled:"false"} keeps a paused routine paused (was armed)', strFalse.status === 200 && strFalse.body.scheduleEnabled === false, `${strFalse.status} ${JSON.stringify(strFalse.body.scheduleEnabled)}`)
const postStr = await call('POST', tasksUrl, { title: 'p3', description: 'x', scheduleKind: 'every', scheduleValue: '60', scheduleEnabled: 'false' })
check('POST {scheduleEnabled:"false"} creates it paused (was armed)', postStr.body.scheduleEnabled === false, JSON.stringify(postStr.body.scheduleEnabled))
const junk = await call('PUT', `${tasksUrl}/${p2.body.id}`, { scheduleEnabled: 'maybe' })
check('a nonsense boolean is refused, not guessed', junk.status === 400, `status ${junk.status}`)

// ── "already ran" follows the card's last run, whatever its kind was ─────
// A spent one-off: its slot is an hour ago, and it ran at that slot.
const spent = await call('POST', tasksUrl, { title: 'spent', description: 'x', scheduleKind: 'once', scheduleValue: laterAt, scheduleTz: 'UTC' })
db.prepare('UPDATE pipeline_tasks SET schedule_value = ?, schedule_enabled = 0, next_run_at = NULL, last_run_at = ? WHERE id = ?').run(pastAt, ago.getTime() + 30_000, spent.body.id)
await call('PUT', `${tasksUrl}/${spent.body.id}`, { scheduleKind: 'every', scheduleValue: '600', scheduleEnabled: false })
const dance = await call('PUT', `${tasksUrl}/${spent.body.id}`, { scheduleKind: 'once', scheduleValue: pastAt, scheduleTz: 'UTC', scheduleEnabled: true })
check('switching a spent one-off to another kind and back cannot re-arm its spent slot (was 200, due now)', dance.status === 400, `status ${dance.status}`)
const plusMinute = new Date(ago.getTime() + 120_000)
const plusAt = `${plusMinute.getUTCFullYear()}-${pad(plusMinute.getUTCMonth() + 1)}-${pad(plusMinute.getUTCDate())}T${pad(plusMinute.getUTCHours())}:${pad(plusMinute.getUTCMinutes())}`
const newPast = await call('PUT', `${tasksUrl}/${spent.body.id}`, { scheduleKind: 'once', scheduleValue: plusAt, scheduleTz: 'UTC', scheduleEnabled: true })
check('a NEW time after its last run is a new run the user asked for (the modal says it fires on save)', newPast.status === 200 && newPast.body.scheduleEnabled === true, `status ${newPast.status}`)
const pastCreate = await call('POST', tasksUrl, { title: 'past', description: 'x', scheduleKind: 'once', scheduleValue: pastAt, scheduleTz: 'UTC' })
check('creating a one-off at a past time still works (it fires on the next check, as promised)', pastCreate.status === 201, `status ${pastCreate.status}`)
// An ARMED one-off still waiting for its (now past) slot, e.g. its chat was busy, stored with a
// zone by a skill: a title edit from the modal (which sends a null zone) must still save.
const waiting = await call('POST', tasksUrl, { title: 'waiting', description: 'x', scheduleKind: 'once', scheduleValue: laterAt, scheduleTz: 'UTC' })
db.prepare('UPDATE pipeline_tasks SET schedule_value = ?, schedule_enabled = 1 WHERE id = ?').run(pastAt, waiting.body.id)
const titleEdit = await call('PUT', `${tasksUrl}/${waiting.body.id}`, { title: 'renamed', scheduleKind: 'once', scheduleValue: pastAt, scheduleTz: null, scheduleEnabled: true })
check('an armed one-off waiting to fire can still be renamed from the modal', titleEdit.status === 200, `status ${titleEdit.status}`)

// ── Card text reaches the agent exactly as written ──────────────────────────────
const kp = await import('../src/services/kickoff-prompt.js') as Record<string, unknown>
const { buildKickoffPrompt } = await import('../src/services/kickoff-prompt.js')
const text = 'echo $$ and $& and $` and $\' and price $5'
const card = { id: 't', projectId: pid, title: 'Shell card', description: text, labels: [], attachments: [], column: 'backlog', priority: 3 } as unknown as Parameters<typeof buildKickoffPrompt>[0]
const prompt = buildKickoffPrompt(card, [])
check('$$, $&, $` and $\' in a card reach the agent unchanged', prompt.includes(text), JSON.stringify(prompt.slice(0, 160)))
const withPlaceholder = buildKickoffPrompt({ ...card, description: 'literal {{comments}} and {{title}} here' } as typeof card, [{ id: 'c', taskId: 't', author: 'human', body: 'SECRET COMMENT', createdAt: 1 }])
check('a {{comments}} typed in the description is not substituted', withPlaceholder.includes('literal {{comments}} and {{title}} here'), JSON.stringify(withPlaceholder.slice(0, 200)))
check('the real comments block is still filled in', withPlaceholder.includes('SECRET COMMENT'))
check('fillKickoffTemplate is exported for reuse', typeof kp.fillKickoffTemplate === 'function')

await close()
done()
