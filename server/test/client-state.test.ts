// Grid tiles stale after a reconnect, and paged-back history vanishing when a
// message arrives). The logic lives in two pure client helpers, tested here, plus a check that
// the reducer and the reconnect handler actually use them.
//
//   npx tsx server/test/client-state.test.ts

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { check, done } from './helpers/scratch-app.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const exists = (rel: string) => fs.existsSync(path.join(root, rel))
const ctx = fs.readFileSync(path.join(root, 'client/src/context/AppContext.tsx'), 'utf8')

// ── paged-back history ─────────────────────────────────────────────────────────────────────────
check('the capping helper exists', exists('client/src/utils/messageCap.ts'))
if (exists('client/src/utils/messageCap.ts')) {
  const { appendCapped, MESSAGE_CAP } = await import('../../client/src/utils/messageCap.js')
  const paged = Array.from({ length: 320 }, (_, i) => i)
  const afterPaging = appendCapped(paged, 999, true)
  check('a chat paged back to 320 messages keeps all of them when a new one arrives', afterPaging.list.length === 321 && afterPaging.list[0] === 0, `${afterPaging.list.length} kept, first ${afterPaging.list[0]}`)
  check('... and nothing was trimmed', afterPaging.trimmed === false)
  const atCap = Array.from({ length: MESSAGE_CAP }, (_, i) => i)
  const grown = appendCapped(atCap, 999)
  check('a chat that only grew at the bottom is still capped', grown.list.length === MESSAGE_CAP && grown.list[MESSAGE_CAP - 1] === 999)
  check('... and reports the trim so "Load older" stays available', grown.trimmed === true)
  // A list longer than the cap that the user did NOT page back
  // through (a reconnect merge) must still be capped by the next message.
  const merged230 = Array.from({ length: 230 }, (_, i) => i)
  const next = appendCapped(merged230, 999, false)
  check('a long list the user did not page back through is capped again', next.list.length === MESSAGE_CAP, `${next.list.length}`)
}
check('"Load older" marks the chat as paged back', /pagedBack: \{ \.\.\.state\.pagedBack, \[pmId\]: true \}/.test(ctx))
if (exists('client/src/utils/messageCap.ts')) {
  const mod = await import('../../client/src/utils/messageCap.js') as Record<string, unknown>
  const merge = mod.mergeNewestPage as ((e: Array<{ id: string }>, f: Array<{ id: string }>, fh: boolean, eh?: boolean) => { list: Array<{ id: string }>; hasMore: boolean }) | undefined
  check('a newest-page refetch has an overlap merge', typeof merge === 'function')
  if (merge) {
    const loaded = Array.from({ length: 262 }, (_, i) => ({ id: `m${i + 1}` }))
    const page = Array.from({ length: 150 }, (_, i) => ({ id: `m${i + 113}` }))
    const r = merge(loaded, page, true, false)
    check('a turn-end refetch keeps the 262 messages the user paged back to', r.list.length === 262 && r.list[0].id === 'm1', `${r.list.length}, first ${r.list[0]?.id}`)
    check('... and keeps the paging state the user left', r.hasMore === false)
    const moved = merge(loaded, [{ id: 'x1' }, { id: 'x2' }], false, false)
    check('a refetch that does not overlap (history cleared) replaces the list', moved.list.length === 2)
  }
}
check('the turn-end and reconnect refetches use the merge', (ctx.match(/mergeNewest: true/g) || []).length >= 2)
// A merge that replaced the list, or a clear, ends "paged back".
if (exists('client/src/utils/messageCap.ts')) {
  const mod = await import('../../client/src/utils/messageCap.js') as Record<string, unknown>
  const merge = mod.mergeNewestPage as (e: Array<{ id: string }>, f: Array<{ id: string }>, fh: boolean, eh?: boolean) => { replaced?: boolean }
  check('a refetch with no overlap reports it replaced the list', merge([{ id: 'a' }], [{ id: 'z' }], false, false).replaced === true)
  check('an overlapping refetch does not', merge([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }], false, false).replaced === false)
}
check('a replaced merge resets paged-back', /mergeNewest && merged && !merged\.replaced/.test(ctx))
check('clearing a chat resets paged-back', /case 'CLEAR_MESSAGES'[\s\S]{0,400}pagedBack: restPaged/.test(ctx))
const addCase = ctx.slice(ctx.indexOf("case 'ADD_MESSAGE': {"), ctx.indexOf("case 'APPEND_STREAMING':"))
check('ADD_MESSAGE uses the helper, not a bare slice(-200)', /appendCapped\(/.test(addCase) && !/slice\(-200\)/.test(addCase))
check('ADD_MESSAGE sets hasMore when it trims', /trimmed/.test(addCase) && /hasMore/.test(addCase))

// ── refetch on reconnect ─────────────────────────────────────────────────────────────────────────
check('the refetch helper exists', exists('client/src/utils/reconnectRefetch.ts'))
if (exists('client/src/utils/reconnectRefetch.ts')) {
  const { chatsToRefetchOnReconnect } = await import('../../client/src/utils/reconnectRefetch.js')
  const ids = chatsToRefetchOnReconnect('b', ['a', 'b', 'c'])
  check('every Grid tile is refetched, the selected chat once', JSON.stringify(ids) === JSON.stringify(['b', 'a', 'c']), JSON.stringify(ids))
  check('no selection still refetches the grid', JSON.stringify(chatsToRefetchOnReconnect(null, ['a'])) === '["a"]')
}
check('the reconnect handler refetches from gridInstanceIds', /chatsToRefetchOnReconnect\([^)]*gridInstanceIds/.test(ctx))
check('the reconnect handler refetches wake-ups too', /chatsToRefetchOnReconnect[\s\S]{0,700}getWakeups\(/.test(ctx))

done()
