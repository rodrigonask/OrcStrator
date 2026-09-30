// Encryption for secrets stored in the local SQLite DB (Claude OAuth tokens, the user's
// Anthropic API key). AES-256-GCM with a 16-byte tag and associated data.
//
// The key used to be sha256(hostname + username + a constant from the source), so
// anyone holding a copy of the DB (a backup, a support zip) could decrypt it with two
// guessable strings. Now the key is 32 random bytes in <data dir>/secret-key, which never
// sits in the DB:
//   - on Windows the file holds the key wrapped by DPAPI for the current user
//     (CryptProtectData through PowerShell, once per boot), so the file alone is useless
//     on another account or machine;
//   - elsewhere, or if DPAPI is unavailable, the raw key in a user-only file.
// New values are written as "v2:<base64 iv|tag|ciphertext>". Values in the old format still
// decrypt (legacyDecrypt), and reencryptLegacySecrets() rewrites them as v2 at boot, once;
// it is idempotent. downgradeSecretsToLegacy() is its reverse, for a rollback.
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { DATA_DIR } from '../config.js'

const V2 = 'v2:'
const AAD = Buffer.from('orcstrator-secret-v2')

export function secretKeyFile(): string {
  return path.join(DATA_DIR, 'secret-key')
}

// ── the legacy format (kept to read old rows) ──────────────────────────────────────────

function legacyKey(): Buffer {
  const raw = `${os.hostname()}:${os.userInfo().username}:orcstrator-token-key`
  return crypto.createHash('sha256').update(raw).digest()
}

export function isLegacyCiphertext(data: string): boolean {
  return !!data && !data.startsWith(V2) && data.split(':').length === 3
}

function legacyDecrypt(data: string): string {
  try {
    const parts = data.split(':')
    if (parts.length !== 3) return ''
    const decipher = crypto.createDecipheriv('aes-256-gcm', legacyKey(), Buffer.from(parts[0], 'hex'), { authTagLength: 16 })
    decipher.setAuthTag(Buffer.from(parts[1], 'hex'))
    return decipher.update(Buffer.from(parts[2], 'hex')) + decipher.final('utf8')
  } catch {
    return ''
  }
}

function legacyEncrypt(text: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey(), iv, { authTagLength: 16 })
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return iv.toString('hex') + ':' + cipher.getAuthTag().toString('hex') + ':' + encrypted.toString('hex')
}

// ── the key ────────────────────────────────────────────────────────────────────────────

function dpapi(op: 'Protect' | 'Unprotect', b64: string): string | null {
  if (process.platform !== 'win32' || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null
  const script = 'Add-Type -AssemblyName System.Security; ' +
    `$b = [Convert]::FromBase64String('${b64}'); ` +
    `$o = [System.Security.Cryptography.ProtectedData]::${op}($b, $null, 'CurrentUser'); ` +
    '[Convert]::ToBase64String($o)'
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    const out = (r.stdout ?? '').trim()
    return r.status === 0 && /^[A-Za-z0-9+/=]+$/.test(out) ? out : null
  } catch {
    return null
  }
}

function restrictToUser(file: string): void {
  try { fs.chmodSync(file, 0o600) } catch { /* not supported */ }
  if (process.platform !== 'win32' || !process.env.USERNAME) return
  try {
    spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
  } catch { /* leave the profile ACL */ }
}

let cachedKey: Buffer | null = null
// A key file that could not be read stays unread for the life of the process: retrying would
// run a blocking PowerShell call (up to 20 s) on every decrypt.
let keyError: Error | null = null

/** The master key, created on first use. Throws only if the key file exists and cannot be read. */
function masterKey(): Buffer {
  if (cachedKey) return cachedKey
  if (keyError) throw keyError
  const file = secretKeyFile()
  if (fs.existsSync(file)) {
    const stored = fs.readFileSync(file, 'utf8').trim()
    let raw: string | null = null
    if (stored.startsWith('dpapi:')) raw = dpapi('Unprotect', stored.slice(6))
    else if (stored.startsWith('raw:')) raw = stored.slice(4)
    const key = raw ? Buffer.from(raw, 'base64') : null
    if (!key || key.length !== 32) {
      keyError = new Error(`${file} could not be read, so stored secrets (the Anthropic key, the plan-usage login) read as empty until the next restart`)
      console.warn(`[secret-box] ${keyError.message}`)
      throw keyError
    }
    cachedKey = key
    return key
  }
  const key = crypto.randomBytes(32)
  const wrapped = dpapi('Protect', key.toString('base64'))
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(file, wrapped ? `dpapi:${wrapped}\n` : `raw:${key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 })
  restrictToUser(file)
  cachedKey = key
  return key
}

// ── the public API ─────────────────────────────────────────────────────────────────────

export function encrypt(text: string): string {
  if (!text) return ''
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv, { authTagLength: 16 })
  cipher.setAAD(AAD)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return V2 + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

export function decrypt(data: string): string {
  if (!data) return ''
  if (!data.startsWith(V2)) return legacyDecrypt(data)
  try {
    const buf = Buffer.from(data.slice(V2.length), 'base64')
    if (buf.length < 29) return ''
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), buf.subarray(0, 12), { authTagLength: 16 })
    decipher.setAAD(AAD)
    decipher.setAuthTag(buf.subarray(12, 28))
    return decipher.update(buf.subarray(28)) + decipher.final('utf8')
  } catch {
    return ''
  }
}

type Db = import('better-sqlite3').Database

/** Every stored ciphertext: [table, key column, key, value column]. */
function storedCiphertexts(db: Db): Array<{ table: string; where: string; id: unknown; column: string; value: string }> {
  const out: Array<{ table: string; where: string; id: unknown; column: string; value: string }> = []
  try {
    for (const r of db.prepare('SELECT key, value FROM secrets').all() as Array<{ key: string; value: string }>) {
      out.push({ table: 'secrets', where: 'key', id: r.key, column: 'value', value: r.value })
    }
  } catch { /* no secrets table */ }
  try {
    for (const r of db.prepare('SELECT id, access_token, refresh_token FROM oauth_tokens').all() as Array<{ id: number; access_token: string | null; refresh_token: string | null }>) {
      out.push({ table: 'oauth_tokens', where: 'id', id: r.id, column: 'access_token', value: r.access_token ?? '' })
      out.push({ table: 'oauth_tokens', where: 'id', id: r.id, column: 'refresh_token', value: r.refresh_token ?? '' })
    }
  } catch { /* no oauth table */ }
  return out
}

/**
 * Rewrite every old-format secret as v2. Idempotent: v2 values and empty values are left
 * alone, and a value that no longer decrypts (another machine's DB) is left as it was.
 * Returns how many values were rewritten.
 */
export function reencryptLegacySecrets(db: Db): number {
  let n = 0
  const rows = storedCiphertexts(db).filter(r => isLegacyCiphertext(r.value))
  db.transaction(() => {
    for (const r of rows) {
      const plain = legacyDecrypt(r.value)
      if (!plain) continue
      db.prepare(`UPDATE ${r.table} SET ${r.column} = ? WHERE ${r.where} = ?`).run(encrypt(plain), r.id)
      n++
    }
  })()
  return n
}

/** The reverse of reencryptLegacySecrets, for rolling the app back to a build without v2. */
export function downgradeSecretsToLegacy(db: Db): number {
  let n = 0
  const rows = storedCiphertexts(db).filter(r => r.value.startsWith(V2))
  db.transaction(() => {
    for (const r of rows) {
      const plain = decrypt(r.value)
      if (!plain) continue
      db.prepare(`UPDATE ${r.table} SET ${r.column} = ? WHERE ${r.where} = ?`).run(legacyEncrypt(plain), r.id)
      n++
    }
  })()
  return n
}
