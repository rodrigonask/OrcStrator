// Secret detection — the single source of truth for "what looks like a secret".
//
// Used by BOTH:
//   • the client, to highlight API-keys/passwords in red as you chat (live warning), and
//   • the server, to permanently scrub them from the transcript .jsonl on Close Session.
// Keeping one module means the thing we WARN about and the thing we DELETE can never drift.
//
// Detection is regex/shape based on purpose (see the "Security Audit Costs" finding):
// secrets have known shapes, so this is deterministic and free — no LLM in the loop.

export type SecretCategory = 'apiKey' | 'password'

interface SecretPattern {
  name: string
  category: SecretCategory
  re: RegExp
  /** When set, only this capture group (the value) is the secret — not the whole
   *  match (which includes the `password=` label). */
  valueGroup?: number
}

// Order matters: specific structured shapes first, the loose labeled catch-all last.
// Every `re` MUST carry the global flag (exec loop relies on it).
const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'anthropic',  category: 'apiKey', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai',     category: 'apiKey', re: /sk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { name: 'aws',        category: 'apiKey', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'github',     category: 'apiKey', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'stripe',     category: 'apiKey', re: /[rs]k_live_[0-9a-zA-Z]{20,}/g },
  { name: 'google',     category: 'apiKey', re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'slack',      category: 'apiKey', re: /xox[baprs]-[0-9A-Za-z-]{10,}/g },
  // Supabase/JWT: header.payload.signature, all base64url.
  { name: 'jwt',        category: 'apiKey', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // PEM private key blocks (multi-line).
  { name: 'privateKey', category: 'apiKey', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  // Loose labeled assignments (the opt-in "aggressive" tier). Redacts only the value.
  // Value must be >=8 chars and contain at least one digit/symbol/uppercase, so plain
  // prose like `password: changeme` is left alone but real-looking creds are caught.
  {
    name: 'labeled', category: 'password', valueGroup: 2,
    re: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|bearer)\b["']?\s*[:=]\s*["']?((?=[^\s"',;}]*[A-Z0-9_\-./+])[^\s"',;}]{8,})/gi,
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

/** Hover text on a highlighted secret in the live chat. */
export const SECRET_HOVER_HINT =
  'API key detected — will be permanently removed when you close this session'

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
      }
      let category = p.category
      if (p.name === 'labeled') {
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
  let out = text
  for (let i = matches.length - 1; i >= 0; i--) {
    out = out.slice(0, matches[i].start) + marker + out.slice(matches[i].end)
  }
  return { redacted: out, matches, apiKeys, passwords }
}
