// The secret scrubber used to catch 3 of 12 sample formats and rewrote ordinary
// code. Every format found missing is a row here, built from SYNTHETIC parts at runtime
// (never a real key, and never a literal a secret scanner would flag in this file), plus the
// code lines that must stay exactly as written.
//
//   npx tsx shared/test/secrets.test.ts

import { findSecretMatches, redactSecrets } from '../src/secrets.js'

let failed = 0
let passed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

// Deterministic filler so every synthetic key has the right alphabet and length.
const fill = (alphabet: string, n: number, seed = 7): string => {
  let out = ''
  let x = seed
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) % 2147483648; out += alphabet[(x >>> 16) % alphabet.length] }
  return out
}
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const HEX = '0123456789abcdef'
const B64URL = ALNUM + '-_'

// value = the part that must disappear; line = how it appears in a transcript.
const caught: Array<{ name: string; line: string; value: string }> = []
const add = (name: string, value: string, line = value) => caught.push({ name, line, value })

// Samples the scrubber used to miss.
add('ANTHROPIC_API_KEY= env line', 'sk-' + 'ant-api03-' + fill(B64URL, 40), `ANTHROPIC_API_KEY=${'sk-' + 'ant-api03-' + fill(B64URL, 40)}`)
const serviceRole = 'eyJ' + fill(B64URL, 30) + '.eyJ' + fill(B64URL, 60, 3) + '.' + fill(B64URL, 43, 5)
add('SUPABASE_SERVICE_ROLE_KEY= env line', serviceRole, `SUPABASE_SERVICE_ROLE_KEY="${serviceRole}"`)
const meta = 'EA' + 'A' + fill(ALNUM, 180, 11)
add('Meta EAA token', meta, `graph_get?access_token=${meta}`)
const sbp = 'sb' + 'p_' + fill(HEX, 40, 13)
add('Supabase sbp_ token', sbp, `SUPABASE_ACCESS_TOKEN=${sbp}`)
const pat = 'github' + '_pat_' + fill(ALNUM + '_', 82, 17)
add('github_pat_ token', pat, `git remote set-url origin https://x:${pat}@github.com/o/r`)
const proj = 'sk-' + 'proj-' + fill(B64URL, 120, 19)
add('sk-proj key with dashes', proj, `OPENAI_API_KEY=${proj}`)
const awsSecret = fill(ALNUM + '/+', 40, 23)
add('AWS secret line', awsSecret, `AWS_SECRET_ACCESS_KEY=${awsSecret}`)
const bearer = fill(B64URL + '.', 48, 29)
add('Authorization: Bearer header', bearer, `curl -H "Authorization: Bearer ${bearer}" https://api.example.com`)
const pgPass = 'Pw' + fill(ALNUM, 14, 31)
add('postgres URL password', pgPass, `postgres://postgres:${pgPass}@db.example.supabase.co:5432/postgres`)
// The three it already caught, still caught.
add('sk-ant key', 'sk-' + 'ant-' + fill(B64URL, 40, 37))
add('ghp_ token', 'gh' + 'p_' + fill(ALNUM, 36, 41))
add('JWT', 'eyJ' + fill(B64URL, 20, 43) + '.eyJ' + fill(B64URL, 30, 47) + '.' + fill(B64URL, 30, 53))
// More gitleaks formats.
add('AWS access key id', 'AK' + 'IA' + fill('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16, 59))
add('Stripe live key', 'sk' + '_live_' + fill(ALNUM, 24, 61))
add('Slack bot token', 'xo' + 'xb-' + fill('0123456789', 12, 67) + '-' + fill(ALNUM, 24, 71))
add('Google API key', 'AI' + 'za' + fill(B64URL, 35, 73))
add('GitLab token', 'gl' + 'pat-' + fill(B64URL, 20, 79))
add('Supabase secret key', 'sb' + '_secret_' + fill(B64URL, 32, 83))
add('npm token', 'np' + 'm_' + fill(ALNUM, 36, 89))
add('MY_SERVICE_TOKEN= env line', 'Tk' + fill(ALNUM, 30, 97), `MY_SERVICE_TOKEN=${'Tk' + fill(ALNUM, 30, 97)}`)
// The ~/.aws/credentials form and a bare `token:` label.
const awsLower = fill(ALNUM + '/+', 40, 103)
add('aws_secret_access_key = (credentials file)', awsLower, `aws_secret_access_key = ${awsLower}`)
add('token: labeled value', 'Tk' + fill(ALNUM, 20, 107), `token: ${'Tk' + fill(ALNUM, 20, 107)}`)
add('api_key: labeled value','Ak' + fill(ALNUM, 24, 101), `api_key: "${'Ak' + fill(ALNUM, 24, 101)}"`)
// Earlier code rules ate real passwords and keys.
for (const [label, value] of [
  ['password: ', 'CorrectHorseBattery'], ['password=', 'Summertime'], ['DB_PASSWORD=', 'Sunshine'],
  ['STRIPE_KEY=', 'MySecretKey'], ['DB_PASSWORD=', 'MY_SUPER_SECRET'], ['token=', 'abcdefghijklmnopqrstuvwxyzABCD'],
  ['secret=', 'kHsbzPdmqwlrtnvxcyfgjeua'], ['client_secret=', 'aB.cD.eF.gH.iJ.kL'], ['password=', 'Pass[word]99'],
  ['Authorization: Bearer ', 'abcdEfghIjklmNopqrStuv.wxYz'],
] as const) add(`${label.trim()} (label form)`, value, label + value)
// A key right after an escape (JSON inside a transcript string,
// a URL-encoded query), glued after an underscore, or longer than the rule's cap; and an all-caps
// random value under a lowercase label.
const antKey = 'sk-' + 'ant-api03-' + fill(B64URL, 40, 109)
const ghKey = 'gh' + 'p_' + fill(ALNUM, 36, 113)
add('key after a literal \\n', antKey, 'line1\\n' + antKey)
add('key after \\u003d', ghKey, 'a\\u003d' + ghKey)
add('key after %3D', ghKey, '?t%3D' + ghKey)
add('key glued after an underscore', antKey, 'foo_' + antKey)
const longGh = 'gh' + 'p_' + fill(ALNUM, 300, 127)
add('key longer than the cap (tail too)', longGh.slice(-40), longGh)
// Forms the rules did not know.
const pw = 'Pw' + fill(ALNUM, 12, 137)
add('Authorization: Basic', Buffer.from(`admin:${pw}`).toString('base64'), `Authorization: Basic ${Buffer.from(`admin:${pw}`).toString('base64')}`)
add('curl -u user:password', pw, `curl -u admin:${pw} https://api.example.com`)
add('DB_PASS= env line', pw, `DB_PASS=${pw}`)
add('redis_pass: label', pw, `redis_pass: ${pw}`)
add('a quoted passphrase with spaces', 'correct horse battery staple', 'PASSWORD="correct horse battery staple"')
add('URL password with an @ in it', `P@${pw}`, `postgres://admin:P@${pw}@db.example.com:5432/app`)
add('password in JSON escaped inside a JSON string', pw, `{"data":"{\\"password\\":\\"${pw}\\"}"}`)
add('secret_key = (lowercase)', pw, `secret_key = "${pw}"`)
add('Azure AccountKey=', fill(ALNUM, 40, 139) + '==', `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${fill(ALNUM, 40, 139)}==;EndpointSuffix=core.windows.net`)
{
  // A URL password stops before the query, so the host and query survive.
  const line = `https://user:${pw}@host.com?email=a@example.com`
  const out = redactSecrets(line).redacted
  check('a URL password is removed and the host and query are kept', !out.includes(pw) && out.endsWith('@host.com?email=a@example.com'), out.includes(pw) ? 'password still there' : out.slice(-30))
}
const caps = fill('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 32, 131)
add('all-caps random value under api_key:', caps, `api_key: "${caps}"`)

for (const c of caught) {
  const out = redactSecrets(c.line).redacted
  // Never print the value: on a tree that misses it, the synthetic key would land in the log.
  check(`caught: ${c.name}`, !out.includes(c.value), out.includes(c.value) ? "the key is still in the text" : "")
}

// Code and prose that must stay exactly as written (the over-redaction samples first).
const untouched = [
  'password: changeme',
  'const secret = process.env.SECRET',
  'const apiKey = process.env.ANTHROPIC_API_KEY',
  'ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}',
  'SUPABASE_SERVICE_ROLE_KEY=<your service role key>',
  'token = getToken(user)',
  'The secret: keep it simple.',
  'Set password_hash in the users table.',
  'export const TOKEN_HEADER = "x-orcstrator-token"',
  'Bearer tokens are sent in the Authorization header.',
  'https://github.com/example-owner/example-repo/pull/1',
  'D:\\Work\\app\\docs\\notes.md',
  // `env` / `set` output: folders are not secrets.
  'PWD=C:\\Users\\me\\projects\\app',
  'OLDPWD=/home/me/Projects2',
  'tokenizer: cl100k_base',
  'maxTokens: 4096',
  // Code that names a token is not a token.
  'token: TokenResponse',
  'const csrf_token = req.body.csrf',
  'session_token = this.sessionStore',
  'token = config.github.token',
  'self.token = self._session.token',
  'github_token = settings.GITHUB',
  'token = request.headers["Authorization"]',
  'access_token: AccessTokenPayload',
  'secret: SecretManagerClient',
  // Env-shaped names in code.
  'API_KEY: config.apiKey',
  'SECRET_KEY = settings.SECRET_KEY',
  'const GITHUB_TOKEN_ENV = "GITHUB_TOKEN"',
  'TOKEN_TYPE=BearerToken',
  'AUTH_MODE=OAuthFlow',
  'AUTH_PROVIDER: GoogleOAuth',
  'KEY_NAME=ANTHROPIC_API_KEY',
  'DEFAULT_KEY = DEFAULT_VALUE_1',
  'TOKEN_URL = "https://oauth2.googleapis.com/token"',
  // UI strings, CI vocabulary, -u flags and URLs.
  '{ password: "Password is required" }',
  'confirmPassword: "Passwords do not match"',
  '"forgotPassword": "Forgot our password?"',
  'labels.password = "Your password"',
  'password = "see the vault"',
  'on_pass: deploy-to-prod',
  'it("should pass: validates-user-input")',
  'pass: 1423/1500',
  'docker exec -u www-data:www-data app sh',
  'git push -u origin:refs/heads/feature-x1',
  'git push -u origin main',
  'docker run -u 1000:1000 image',
  'http://localhost:5174?x=1&y=me@example.com',
]
for (const line of untouched) {
  const out = redactSecrets(line).redacted
  check(`left alone: ${line}`, out === line, out === line ? '' : `became: ${out}`)
}

// Counting is by category, so the close summary can say what it removed.
const counted = redactSecrets(`DB_PASSWORD=${pgPass}9x and ${caught[0].value}`)
check('a password and a key are counted as one of each', counted.passwords === 1 && counted.apiKeys === 1, JSON.stringify({ p: counted.passwords, k: counted.apiKeys }))
check('matches never overlap', (() => {
  const m = findSecretMatches(caught.map(c => c.line).join('\n'))
  return m.every((x, i) => i === 0 || x.start >= m[i - 1].end)
})())

// The scan must stay linear on long runs of label-like text
// (it runs on every secure close, every logged stderr line and the live chat highlight).
// Every unanchored prefix rule restarted at each character (2.7 to 10.7 s each).
// A PEM header line with no key under it, for the linear-time case below. Joined at run time so
// the line never reads as a key block to a scanner that looks for real ones.
const pemHeader = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')
const hexRun = Array.from({ length: 100_000 }, (_, i) => '0123456789abcdef'[(i * 7919) % 16]).join('')
for (const [label, text] of [
  ['a_ repeated', 'a_'.repeat(50000)], ['foo_bar1_ repeated', 'foo_bar1_'.repeat(12000)], ['a repeated', 'a'.repeat(100_000)],
  ['hex', hexRun], ['eyJ repeated', 'eyJ'.repeat(33_000)], ['KEY repeated', 'KEY'.repeat(33_000)],
  ['sk- repeated', 'sk-'.repeat(33_000)], ['xoxb- repeated', 'xoxb-'.repeat(20_000)], ['glpat- repeated', 'glpat-'.repeat(16_000)],
  ['BEGIN repeated', `${pemHeader}\n`.repeat(3_500)], ['scheme:// repeated', 'postgres://a:'.repeat(7_000)],
  // The escape case of the key anchor must not reopen the quadratic scan.
  ['-u a:b repeated', ' -u a:b'.repeat(14_000)], ['Authorization: Basic repeated', 'Authorization: Basic '.repeat(5_000)],
  ['x_password=" repeated', 'x_password="'.repeat(8_500)], ['scheme://a:@@@ repeated', 'db://a:' + '@'.repeat(100_000)],
  ['\\nsk- repeated', '\\nsk-'.repeat(20_000)], ['%3Dghp_ repeated', '%3Dghp_'.repeat(12_500)], ['\\u003deyJ repeated', '\\u003deyJ'.repeat(11_000)],
] as const) {
  const t0 = Date.now()
  redactSecrets(text)
  const ms = Date.now() - t0
  check(`100 KB of ${label} scans in well under a second`, ms < 500, `${ms} ms`)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
