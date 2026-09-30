// Table tests for the pure functions the report named as untested and load-bearing,
// the secret detector (what gets scrubbed from transcripts) and the stream parser (what turns
// the agent's output into the chat). Permission rules have their own table in
// shared/test/permission-fences.test.ts.
//
//   npx tsx server/test/pure-tables.test.ts
//
// Every key below is SYNTHETIC: the right shape, never a real credential.

import { check, done } from './helpers/scratch-app.js'
import { findSecretMatches, redactSecrets, SECRET_MARKER } from '../../shared/src/secrets.js'
import { createStreamParser } from '../src/services/stream-parser.js'

// ── secrets ───────────────────────────────────────────────────────────────────────
const fake = {
  anthropic: 'sk-ant-' + 'a'.repeat(24),
  aws: 'AKIA' + 'B'.repeat(16),
  github: 'ghp_' + 'c'.repeat(36),
  jwt: 'eyJ' + 'd'.repeat(10) + '.eyJ' + 'e'.repeat(10) + '.' + 'f'.repeat(10),
}
for (const [name, key] of Object.entries(fake)) {
  const hits = findSecretMatches(`here is the key ${key} ok`)
  check(`secrets: detects a ${name} key`, hits.length === 1, JSON.stringify(hits.map(h => h.pattern)))
  const red = redactSecrets(`token=${key}`)
  check(`secrets: redacts a ${name} key`, !red.redacted.includes(key) && red.redacted.includes(SECRET_MARKER))
}
// Note: the 'labeled' pattern carries /i, so its "must contain an uppercase or digit" lookahead
// also accepts lowercase, and `password: changeme` IS flagged today, contrary to its comment.
// Out of scope here; this row tests what the code guarantees.
check('secrets: plain prose is left alone', findSecretMatches('we talked about the password policy and api design today').length === 0)
check('secrets: a labelled value under 8 characters is left alone', findSecretMatches('pwd: abc12').length === 0)
check('secrets: a labelled real-looking password is caught', findSecretMatches('password=Hunter2Hunter2!').length === 1)
check('secrets: a short sk- word is not a key', findSecretMatches('use sk-learn for this').length === 0)

// ── stream parser ─────────────────────────────────────────────────────────────────
const parse = createStreamParser('inst-1')
const one = (line: string) => {
  const r = parse(line)
  return Array.isArray(r) ? r[0] : r
}
check('parser: a blank line is nothing', parse('   ') === null)
const plain = one('not json at all') as { type: string; text?: string } | null
check('parser: a non-JSON line becomes text', plain?.type === 'text-delta' && plain.text === 'not json at all\n', JSON.stringify(plain))
const sys = one(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-123' })) as { type: string; sessionId?: string } | null
check('parser: system init carries the session id', sys?.type === 'system' && sys.sessionId === 'sess-123', JSON.stringify(sys))
check('parser: the "compacting" progress marker is swallowed', parse(JSON.stringify({ type: 'system', subtype: 'status', status: 'compacting' })) === null)
const compacted = one(JSON.stringify({ type: 'system', subtype: 'status', status: null, compact_result: 'success' })) as { type: string } | null
check('parser: a finished /compact is a compaction event', compacted?.type === 'compaction', JSON.stringify(compacted))
const failedCompact = one(JSON.stringify({ type: 'system', subtype: 'status', compact_result: 'failed', compact_error: 'too big' })) as { type: string; text?: string } | null
check('parser: a failed /compact says why', failedCompact?.type === 'text-delta' && /too big/.test(failedCompact.text ?? ''), JSON.stringify(failedCompact))
const auto = one(JSON.stringify({ type: 'system', subtype: 'compact_boundary', trigger: 'auto' })) as { type: string; trigger?: string } | null
check('parser: an auto-compaction is recognised as auto', auto?.type === 'compaction' && auto.trigger === 'auto', JSON.stringify(auto))

done()
