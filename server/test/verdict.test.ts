// The self-closing verdict: the parser (pure) and the "which message is this run's final
// message" read (scratch db). Absence of proof is failure, so most cases here are refusals.
//
//   npx tsx server/test/verdict.test.ts

import { parseVerdict, NO_VERDICT_REASON } from '../src/services/verdict.js'

const { scratchApp, check, done } = await import('./helpers/scratch-app.js')

const isOk = (t: string | null) => parseVerdict(t).ok
const reasonOf = (t: string | null) => { const v = parseVerdict(t); return v.ok ? '' : v.reason }

// ── The grammar ──
check('OK on the last line', isOk('Paused all 4 campaigns.\n\nRESULT: OK'))
check('OK with trailing whitespace', isOk('done\nRESULT: OK   \n\n  '))
check('OK with CRLF line ends', isOk('done\r\nRESULT: OK\r\n'))
check('OK with no space after the colon', isOk('RESULT:OK'))
check('NEEDS_REVIEW with reason is not OK', !isOk('x\nRESULT: NEEDS_REVIEW - campaign 3 still ACTIVE'))
check('NEEDS_REVIEW reason is carried', reasonOf('x\nRESULT: NEEDS_REVIEW - campaign 3 still ACTIVE') === 'campaign 3 still ACTIVE', reasonOf('x\nRESULT: NEEDS_REVIEW - campaign 3 still ACTIVE'))
check('NEEDS_REVIEW with colon separator', reasonOf('RESULT: NEEDS_REVIEW: token expired') === 'token expired')
check('NEEDS_REVIEW with no reason', reasonOf('RESULT: NEEDS_REVIEW') === 'no reason given')
check('verdict not on the last line is rejected', !isOk('RESULT: OK\nActually, one more thing failed.'))
check('verdict not on the last line says no verdict', reasonOf('RESULT: OK\nActually, one more thing failed.') === NO_VERDICT_REASON)
check('lowercase result: ok is rejected', !isOk('result: ok'))
check('mixed case Result: Ok is rejected', !isOk('Result: Ok'))
check('lowercase attempt reads as not understood', reasonOf('result: ok').startsWith('verdict line not understood'))
check('empty text is rejected', !isOk(''))
check('null text is rejected', !isOk(null))
check('whitespace-only text is rejected', !isOk('  \n \n'))
check('code-fenced verdict is rejected', !isOk('Done.\n```\nRESULT: OK\n```'))
check('inline-code verdict is rejected', !isOk('Done.\n`RESULT: OK`'))
check('bold verdict is rejected', !isOk('**RESULT: OK**'))
check('quoted verdict is rejected', !isOk('> RESULT: OK'))
check('OKAY is rejected', !isOk('RESULT: OKAY'))
check('OK followed by junk word is rejected', !isOk('RESULT: OK then'))
check('qualified OK with a dash is rejected', !isOk('RESULT: OK - but 3 tests failed'))
check('qualified OK with a colon is rejected', !isOk('RESULT: OK: partially'))
check('qualified OK reads as not understood', reasonOf('RESULT: OK - but 3 tests failed').startsWith('verdict line not understood'))
check('em dash separator is not a valid verdict', !isOk('RESULT: NEEDS_REVIEW \u2014 x') && reasonOf('RESULT: NEEDS_REVIEW \u2014 x').startsWith('verdict line not understood'))
check('verdict inside a sentence is rejected', !isOk('I will print RESULT: OK at the end'))

// ── Which message counts (scratch db) ──
const { db, close } = await scratchApp([])
const { finalRunText, readRunVerdict } = await import('../src/services/run-verdict.js')
db.prepare("INSERT INTO folders (id, path, name) VALUES ('f', 'C:/nowhere', 'p')").run()
db.prepare("INSERT INTO instances (id, folder_id, name, cwd, state, process_state, sort_order, created_at) VALUES ('i', 'f', 'i', 'C:/nowhere', 'idle', 'idle', 0, 1)").run()
let n = 0
const addMsg = (role: string, content: unknown[], at: number) =>
  db.prepare('INSERT INTO messages (id, instance_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(`m${n++}`, 'i', role, JSON.stringify(content), at)

// Yesterday's run ended with a clean OK.
addMsg('user', [{ type: 'text', text: 'run 1' }], 1000)
addMsg('assistant', [{ type: 'text', text: 'all good\nRESULT: OK' }], 1100)
const v1 = readRunVerdict({ instanceId: 'i', since: 1000, exitCode: 0, stoppedByUser: false })
check('the earlier run itself reads OK', v1.ok)

// Today's run on the SAME chat crashed before it said anything.
addMsg('user', [{ type: 'text', text: 'run 2' }], 2000)
check('stale OK from an earlier run is not this run\'s final text', finalRunText('i', 2000) === null)
const v2 = readRunVerdict({ instanceId: 'i', since: 2000, exitCode: 0, stoppedByUser: false })
check('stale OK never counts: a run with no message of its own is NEEDS_REVIEW', !v2.ok, JSON.stringify(v2))

// Today's run said OK and then started a tool call it never finished.
addMsg('assistant', [{ type: 'text', text: 'RESULT: OK' }, { type: 'tool-call', toolId: 't', toolName: 'Bash', input: '{}' }], 2100)
check('a final row that ends in a tool call is not a verdict', !readRunVerdict({ instanceId: 'i', since: 2000, exitCode: 0, stoppedByUser: false }).ok)

// Clean OK, but the process facts say otherwise.
addMsg('assistant', [{ type: 'text', text: 'RESULT: OK' }], 2200)
check('clean exit + OK is OK', readRunVerdict({ instanceId: 'i', since: 2000, exitCode: 0, stoppedByUser: false }).ok)
check('non-zero exit + OK is NEEDS_REVIEW', !readRunVerdict({ instanceId: 'i', since: 2000, exitCode: 1, stoppedByUser: false }).ok)
check('killed (null exit) + OK is NEEDS_REVIEW', !readRunVerdict({ instanceId: 'i', since: 2000, exitCode: null, stoppedByUser: false }).ok)
check('stopped by the user + OK is NEEDS_REVIEW', !readRunVerdict({ instanceId: 'i', since: 2000, exitCode: 0, stoppedByUser: true }).ok)
check('unknown run start + OK is NEEDS_REVIEW', !readRunVerdict({ instanceId: 'i', since: null, exitCode: 0, stoppedByUser: false }).ok)

// Same-millisecond rows: the one written last wins, not an arbitrary one.
addMsg('assistant', [{ type: 'text', text: 'RESULT: NEEDS_REVIEW - second thoughts' }], 2200)
check('same-timestamp tie goes to the later row', !readRunVerdict({ instanceId: 'i', since: 2000, exitCode: 0, stoppedByUser: false }).ok)

await close()
done()
