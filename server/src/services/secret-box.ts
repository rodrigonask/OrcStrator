// Machine-specific symmetric encryption (AES-256-GCM), key derived from hostname+username.
// Used to encrypt at-rest secrets in the local SQLite DB (Claude OAuth tokens, the user's
// Anthropic API key). The derived key never leaves this machine, so a DB file copied to
// another machine can't be decrypted.
//
// NOTE: the salt string below is load-bearing — changing it would make every previously
// encrypted value (oauth_tokens, secrets) undecryptable. Keep it stable.
import crypto from 'crypto'
import os from 'os'

function getMachineKey(): Buffer {
  const raw = `${os.hostname()}:${os.userInfo().username}:orcstrator-token-key`
  return crypto.createHash('sha256').update(raw).digest()
}

export function encrypt(text: string): string {
  if (!text) return ''
  const key = getMachineKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex')
}

export function decrypt(data: string): string {
  if (!data) return ''
  try {
    const parts = data.split(':')
    if (parts.length !== 3) return ''
    const iv = Buffer.from(parts[0], 'hex')
    const tag = Buffer.from(parts[1], 'hex')
    const encrypted = Buffer.from(parts[2], 'hex')
    const key = getMachineKey()
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return decipher.update(encrypted) + decipher.final('utf8')
  } catch {
    return ''
  }
}
