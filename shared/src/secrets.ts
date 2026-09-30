// Secret detection: the single source of truth for "what looks like a secret".
//
// Used by BOTH:
//   • the client, to highlight API-keys/passwords in red as you chat (live warning), and
//   • the server, to permanently scrub them from the transcript .jsonl on Close Session.
// Keeping one module means the thing we WARN about and the thing we DELETE can never drift.
//
// Detection is regex/shape based on purpose:
// secrets have known shapes, so this is deterministic and free, no LLM in the loop.
//
// The first version caught 3 of 12 real formats (it missed .env lines, Meta and
// Supabase tokens, github_pat_, dashed sk-proj keys, Bearer headers and URL passwords) and
// rewrote ordinary code like `password: changeme`. The formats below follow gitleaks' default
// rules (the repo's .gitleaks.toml extends them); shared/test/secrets.test.ts pins each one
// with a synthetic key.

export type SecretCategory = 'apiKey' | 'password'

interface SecretPattern {
  name: string
  category: SecretCategory
  re: RegExp
  /** When set, only this capture group (the value) is the secret, not the whole
   *  match (which includes the `password=` label). */
  valueGroup?: number
  /** Extra test on the value (and the label, group 1), for the rules that must not rewrite code. */
  accept?: (value: string, label: string) => boolean
}

// A boundary that also holds after an underscore, so ANTHROPIC_API_KEY and MY_SECRET count as
// labels. A plain word boundary does not: "_" is a word character, so the old rule never
// matched api_key inside a longer name.
const B = '(?<![A-Za-z0-9])'

// Start of a provider key: not glued to a longer run of key characters, OR right after an escape
// (a literal \n or = inside JSON printed in a transcript, a %3D in a URL). Without the
// escape case "x\nsk-ant-..." was missed; without the
// lookbehind a long run restarts at every character and the scan goes quadratic.
const ESC = String.raw`\\[nrtbfv0]|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}|%[0-9A-Fa-f]{2}`
const key = (notAfter: string, body: string) => new RegExp(`(?:(?<![${notAfter}])|(?<=${ESC}))${body}`, 'g')

/** A value that is code referring to a secret, not the secret itself. */
function isReference(v: string): boolean {
  if (/^(process\.env|import\.meta\.env|os\.environ|os\.getenv|getenv|Deno\.env|env\.)/i.test(v)) return true
  if (/^(\$\{?|%[A-Za-z_]+%|<[^>]*>|\{\{)/.test(v)) return true
  if (/[()]/.test(v)) return true
  return /^(true|false|null|undefined|none|changeme|password|secret|example|placeholder|x{3,}|\*+)$/i.test(v)
}

/** Looks like a credential: long enough, not a reference or a folder, and not one plain word. */
function looksSecret(v: string): boolean {
  if (v.length < 8 || isReference(v)) return false
  // A folder path (PWD=C:\Users\me\app, pwd: /home/me) is not a credential.
  if (/^([A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(v)) return false
  let classes = 0
  if (/[a-z]/.test(v)) classes++
  if (/[A-Z]/.test(v)) classes++
  if (/[0-9]/.test(v)) classes++
  if (/[^A-Za-z0-9]/.test(v)) classes++
  return classes >= 2
}

/** One identifier that reads like words (camelCase, PascalCase, snake, CONSTANT), not random. */
function wordLike(seg: string): boolean {
  // CONSTANT or GITHUB: word segments and an optional numeric suffix. AB12CD34 is not a name.
  if (/^[A-Z]+(_[A-Z]+)*(_[0-9]+)?$/.test(seg)) {
    return seg.split('_').every(p => /^[0-9]+$/.test(p) || (p.length <= 14 && (p.length < 5 || /[AEIOUY]/.test(p))))
  }
  const parts = seg.replace(/^_+/, '').split(/(?=[A-Z])|_/).filter(Boolean)
  // Every part after the first is a real word (aB.cD is not code), and a long part has a vowel.
  return parts.length > 0 && parts.every((p, i) => /^[A-Za-z][a-z]{0,13}$/.test(p) && (i === 0 || p.length > 1) && (p.length < 5 || /[aeiouy]/i.test(p)))
}

/**
 * Code that names a value rather than holding one:
 * `token = config.github.token`, `token: TokenResponse`, `req.headers[`. Used only for the
 * labels that code also uses as variable names (token, secret, api_key...), never for a
 * password label: `password: CorrectHorseBattery` is a password.
 */
function looksLikeCode(v: string): boolean {
  if (/[[\]]/.test(v)) return true
  if (/[0-9]/.test(v.replace(/_[0-9]+$/, ''))) return false
  const segs = v.split('.')
  if (segs.some(s => !/^[A-Za-z_$][\w$]*$/.test(s))) return false
  return segs.every(wordLike)
}

function acceptLabeled(v: string, label: string): boolean {
  if (!looksSecret(v)) return false
  // A bare `pass` label is also test and CI vocabulary (`on_pass: deploy-to-prod`, `pass:
  // 1423/1500`), so its value must hold a letter and a digit and not be a kebab name.
  if (/^pass$/i.test(label)) return /[A-Za-z]/.test(v) && /[0-9]/.test(v) && !/^[a-z0-9]+(-[a-z0-9]+)+$/.test(v) && !v.includes('/')
  if (/pass|pwd/i.test(label)) return true
  return !looksLikeCode(v)
}

const ENV_KEYWORD = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|DSN|(?:^|_)PASS(?:_|$)/
// Names that hold something ABOUT a secret: TOKEN_URL, KEY_NAME, AUTH_MODE, GITHUB_TOKEN_ENV.
const ENV_META_NAME = /_(TYPE|MODE|PROVIDER|NAME|URL|URI|HEADER|ENV|VAR|FILE|PATH|DIR|ENDPOINT|FIELD|PARAM|ID|KIND|LENGTH|SIZE|COUNT|PREFIX|SUFFIX|FORMAT|TTL|EXPIRY|EXPIRES)$/

/**
 * An env-style line. A .env value is literal, so STRIPE_KEY=MySecretKey is a key; the same shape
 * in code (API_KEY: config.apiKey, DEFAULT_KEY = DEFAULT_VALUE_1) names a value, and a lowercase
 * kebab value (TOKEN_HEADER = "x-orcstrator-token") is a header.
 */
function acceptEnv(v: string, name: string): boolean {
  if (!ENV_KEYWORD.test(name) || !looksSecret(v)) return false
  if (/PASS|PWD/.test(name)) return true
  if (ENV_META_NAME.test(name) || /^[a-z]+(-[a-z]+)+$/.test(v)) return false
  return !(looksLikeCode(v) && /[.[\]]|^[A-Z0-9_]+$/.test(v))
}

// Every rule is anchored with a lookbehind and uses bounded repeats, so a scan is linear in
// the text: an unanchored `[a-z][a-z0-9+.-]*://` or `[A-Z0-9_]*KEY[A-Z0-9_]*` restarts at every
// character and took seconds on 100 KB of ordinary tool output.
// Overlaps are resolved longest-first below, so order is for readability only.
// Every `re` MUST carry the global flag (exec loop relies on it).
const SECRET_PATTERNS: SecretPattern[] = [
  // sk- keys may follow an underscore (foo_sk-ant-...), never a dash (a run of sk-sk-sk-).
  { name: 'anthropic',  category: 'apiKey', re: key('A-Za-z0-9-', 'sk-ant-[A-Za-z0-9_-]{20,512}') },
  { name: 'openai',     category: 'apiKey', re: key('A-Za-z0-9-', 'sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,512}') },
  { name: 'aws',        category: 'apiKey', re: /(?<![A-Z0-9])(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}(?![A-Z0-9])/g },
  { name: 'github',     category: 'apiKey', re: key('A-Za-z0-9_', 'gh[pousr]_[A-Za-z0-9]{36,255}') },
  { name: 'githubPat',  category: 'apiKey', re: key('A-Za-z0-9_', 'github_pat_[A-Za-z0-9_]{22,255}') },
  { name: 'gitlab',     category: 'apiKey', re: key('A-Za-z0-9-', 'glpat-[A-Za-z0-9_-]{20,255}') },
  { name: 'stripe',     category: 'apiKey', re: key('A-Za-z0-9_', '(?:(?:[rs]k|pk)_(?:live|test)_[0-9a-zA-Z]{20,255}|whsec_[0-9a-zA-Z]{24,255})') },
  { name: 'google',     category: 'apiKey', re: key('A-Za-z0-9_-', 'AIza[0-9A-Za-z_-]{35}') },
  { name: 'slack',      category: 'apiKey', re: key('A-Za-z0-9-', '(?:xox[abeoprs]|xapp)-[0-9A-Za-z-]{10,255}') },
  // Meta Graph API user, page and system tokens all start with EAA (as in .gitleaks.toml).
  { name: 'meta',       category: 'apiKey', re: key('A-Za-z0-9', 'EAA[A-Za-z0-9]{40,2048}') },
  // Supabase personal access tokens and the new secret API keys.
  { name: 'supabase',   category: 'apiKey', re: key('A-Za-z0-9_', '(?:sbp_[a-f0-9]{40}|sb_secret_[A-Za-z0-9_-]{20,255})') },
  { name: 'npm',        category: 'apiKey', re: key('A-Za-z0-9_', 'npm_[A-Za-z0-9]{36}') },
  { name: 'huggingface', category: 'apiKey', re: key('A-Za-z0-9_', 'hf_[A-Za-z]{34}') },
  { name: 'sendgrid',   category: 'apiKey', re: key('A-Za-z0-9_-', String.raw`SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}`) },
  // Supabase/JWT: header.payload.signature, all base64url.
  { name: 'jwt',        category: 'apiKey', re: key('A-Za-z0-9_-', String.raw`eyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,16384}\.[A-Za-z0-9_-]{8,4096}`) },
  // PEM private key blocks (multi-line). A real key block is a few KB.
  { name: 'privateKey', category: 'apiKey', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]{0,16384}?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  // Authorization: Bearer <token>, or a bare "Bearer <token>".
  {
    name: 'bearer', category: 'apiKey', valueGroup: 1, accept: v => looksSecret(v),
    re: /(?<![A-Za-z0-9])Bearer\s{1,8}([A-Za-z0-9._~+/=-]{16,4096})/gi,
  },
  // Authorization: Basic <base64 of user:password>, and curl -u / --user user:password.
  {
    name: 'basicAuth', category: 'password', valueGroup: 1, accept: v => looksSecret(v),
    re: /(?<![A-Za-z0-9])Authorization:[ \t]{0,8}Basic[ \t]{1,8}([A-Za-z0-9+/]{8,4096}={0,2})/gi,
  },
  {
    // Not a path or a lowercase name: `docker exec -u www-data:www-data`, `git push -u
    // origin:refs/heads/x`.
    name: 'cliUser', category: 'password', valueGroup: 1,
    accept: v => looksSecret(v) && !v.includes('/') && !/^[a-z]+(-[a-z]+)+$/.test(v),
    re: /(?<!\S)(?:-u|--user)[ \t]{1,8}["']?[^\s:"']{1,64}:([^\s"']{3,256})/g,
  },
  // A quoted password with spaces in it (a passphrase), which the rules below stop at.
  {
    // Only an env-style ALL-CAPS name: `password: "Password is required"` and other UI and
    // validation strings under camel or lowercase labels are prose.
    name: 'spacedPassword', category: 'password', valueGroup: 2,
    accept: v => /\s/.test(v.trim()) && !isReference(v.trim()),
    re: new RegExp(`${B}([A-Z0-9_]{0,40}?(?:PASSWORD|PASSWD))(?:\\\\?["'])?[ \\t]{0,8}[:=][ \\t]{0,8}\\\\?["']([^"'\\n\\\\]{8,256})\\\\?["']`, 'g'),
  },
  // Credentials inside a URL: postgres://user:PASSWORD@host.
  {
    name: 'urlCredential', category: 'password', valueGroup: 1,
    // The password runs to the LAST @ before the host, so P@ssw0rd is removed whole,
    // but never into the query or fragment (a@example.com in ?email=).
    re: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/?#]{1,256}:([^\s/?#]{3,256})@/gi,
  },
  // .env lines: ANTHROPIC_API_KEY=..., SUPABASE_SERVICE_ROLE_KEY=..., AWS_SECRET_ACCESS_KEY=...
  // The name is matched as one word and its keyword checked afterwards (linear).
  {
    name: 'envLine', category: 'apiKey', valueGroup: 2,
    accept: acceptEnv,
    // An optional backslash before a quote: JSON printed inside a JSON string (tool output).
    re: /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{1,80})(?:\\?["'])?[ \t]{0,8}[:=][ \t]{0,8}(?:\\?["'])?([^\s"'#;,\\]{8,1024})/g,
  },
  // Loose labeled assignments. Redacts only the value, and only when the value looks like a
  // credential: `password: changeme` and `const secret = process.env.SECRET` stay as written.
  {
    name: 'labeled', category: 'password', valueGroup: 2, accept: acceptLabeled,
    re: new RegExp(
      `${B}(password|passwd|pass|pwd|secret|secret[_-]?key|secret[_-]?access[_-]?key|private[_-]?key|api[_-]?key|account[_-]?key|token|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token|service[_-]?role[_-]?key)(?![A-Za-z0-9])(?:\\\\?["'])?[ \\t]{0,8}[:=][ \\t]{0,8}(?:\\\\?["'])?([^\\s"',;}\\\\]{8,1024})`,
      'gi',
    ),
  },
]

export interface SecretMatch {
  /** Start index of the secret VALUE within the scanned string. */
  start: number
  /** End index (exclusive). */
  end: number
  value: string
  category: SecretCategory
  pattern: string
}

/** Replacement written into the transcript in place of a removed secret. */
export const SECRET_MARKER = '[\u{1F512} secret removed]'

/** Hover text on a highlighted secret in the live chat. It says what the scrub does, no more. */
export const SECRET_HOVER_HINT =
  'Looks like a key or password. Secure close removes the formats OrcStrator recognises from this chat\'s transcript.'

/**
 * Find every secret-shaped token in `text`. Returns non-overlapping matches in
 * document order (longest-wins when two patterns hit the same span).
 */
export function findSecretMatches(text: string): SecretMatch[] {
  if (!text || text.length < 8) return []
  const found: SecretMatch[] = []

  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags) // fresh lastIndex per call
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      let value: string
      let start: number
      if (p.valueGroup != null) {
        const g = m[p.valueGroup]
        if (!g) { if (m.index === re.lastIndex) re.lastIndex++; continue }
        value = g
        start = m.index + m[0].lastIndexOf(g)
      } else {
        value = m[0]
        start = m.index
        // The repeats are capped for speed; a longer key is still removed whole, not with its
        // tail left in the clear.
        if (p.name !== 'privateKey') {
          let end = start + value.length
          while (end < text.length && /[A-Za-z0-9_-]/.test(text[end])) end++
          if (end > start + value.length) { value = text.slice(start, end); re.lastIndex = end }
        }
      }
      if (p.accept && !p.accept(value, m[1] ?? '')) { if (m.index === re.lastIndex) re.lastIndex++; continue }
      let category = p.category
      if (p.name === 'labeled' || p.name === 'envLine') {
        const label = (m[1] || '').toLowerCase()
        category = /pass|pwd/.test(label) ? 'password' : 'apiKey'
      }
      found.push({ start, end: start + value.length, value, category, pattern: p.name })
      if (m.index === re.lastIndex) re.lastIndex++ // guard against zero-width loops
    }
  }

  // Drop overlaps: earliest start first, longest match wins.
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: SecretMatch[] = []
  let lastEnd = -1
  for (const mt of found) {
    if (mt.start >= lastEnd) { out.push(mt); lastEnd = mt.end }
  }
  return out
}

export interface RedactResult {
  redacted: string
  matches: SecretMatch[]
  apiKeys: number
  passwords: number
}

/** Replace every detected secret in `text` with `marker`. */
export function redactSecrets(text: string, marker: string = SECRET_MARKER): RedactResult {
  const matches = findSecretMatches(text)
  let apiKeys = 0
  let passwords = 0
  for (const m of matches) (m.category === 'password' ? passwords++ : apiKeys++)
  if (!matches.length) return { redacted: text, matches, apiKeys, passwords }
  // One pass: re-slicing the whole text per match was quadratic in the number of matches.
  const parts: string[] = []
  let at = 0
  for (const m of matches) { parts.push(text.slice(at, m.start), marker); at = m.end }
  parts.push(text.slice(at))
  return { redacted: parts.join(''), matches, apiKeys, passwords }
}
