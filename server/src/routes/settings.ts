import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { startPolling } from '../services/usage-monitor.js'
import { setMaxConcurrentProcesses } from '../services/process-registry.js'
import { cloudSync } from '../services/cloud-sync.js'
import { hasAnthropicKey, setAnthropicKey } from '../services/instance-namer.js'
import { dedupeRules, survivesAutoMode } from '@orcstrator/shared'

function readAllSettings(): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
  const settings: Record<string, unknown> = {}
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value)
    } catch {
      settings[row.key] = row.value
    }
  }
  return settings
}

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * "Allow always", from the permission banner or a refusal card: add allow rules to
   * the app-wide list, so every chat gets them from its next spawn.
   *
   * A route of its own rather than the PUT below, for two reasons. The PUT stores whatever list the
   * client sends, so a card in a tab that loaded settings an hour ago would quietly wipe every rule
   * added since; this appends on the server in one synchronous read-modify-write instead. And it
   * refuses any rule auto mode drops. Saving one of those is precisely the loop this was built to
   * end: the rule is stored, the CLI ignores it, the retry is refused again, and the operator clicks
   * Allow always a second time for nothing. The buttons never offer such a rule; this is the backstop.
   */
  app.post('/settings/permission-allow-rules', async (request, reply) => {
    const body = request.body as { rules?: unknown } | undefined
    const incoming = Array.isArray(body?.rules) ? dedupeRules(body.rules) : []
    if (incoming.length === 0) { reply.code(400); return { ok: false, error: 'Missing rules' } }
    const refused = incoming.filter(rule => !survivesAutoMode(rule))
    if (refused.length > 0) { reply.code(422); return { ok: false, error: 'auto-mode-would-drop', refused } }

    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('permissionAllowRules') as { value: string } | undefined
    let stored: unknown = []
    try { stored = row ? JSON.parse(row.value) : [] } catch { stored = [] }
    const existing = Array.isArray(stored) ? dedupeRules(stored) : []
    const next = dedupeRules([...existing, ...incoming])
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('permissionAllowRules', JSON.stringify(next))

    broadcastEvent({ type: 'settings:updated', payload: readAllSettings() })
    return { ok: true, added: next.length - existing.length, permissionAllowRules: next }
  })

  // Get all settings
  app.get('/settings', async () => {
    const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
    const settings: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value)
      } catch {
        settings[row.key] = row.value
      }
    }
    return settings
  })

  // Partial merge update settings
  app.put('/settings', async (request) => {
    const body = request.body as Record<string, unknown>
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    const remove = db.prepare('DELETE FROM settings WHERE key = ?')

    // null means "back to the app default": delete the row. undefined never arrives (JSON
    // drops it), so without this a setting could be pinned once and never unpinned again.
    const transaction = db.transaction(() => {
      for (const [key, value] of Object.entries(body)) {
        if (value === null) remove.run(key)
        else upsert.run(key, JSON.stringify(value))
      }
    })
    transaction()

    // Read back all settings
    const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
    const settings: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value)
      } catch {
        settings[row.key] = row.value
      }
    }

    broadcastEvent({ type: 'settings:updated', payload: settings })

    // If poll interval changed, restart polling with the new interval
    if ('usagePollMinutes' in body && typeof body.usagePollMinutes === 'number') {
      startPolling(body.usagePollMinutes)
    }

    // If max concurrent processes changed, update the registry limit
    if ('maxConcurrentProcesses' in body && typeof body.maxConcurrentProcesses === 'number') {
      setMaxConcurrentProcesses(body.maxConcurrentProcesses)
    }

    // If cloud sync settings changed, re-initialize the sync client
    if ('cloudSyncUrl' in body || 'cloudSyncKey' in body || 'machineName' in body) {
      cloudSync.initialize()
    }

    return settings
  })

  // Anthropic API key for AI session naming. Stored encrypted in the `secrets` table
  // (never the client-visible `settings` bag) - so it is write-only over the API:
  // we report whether a key is set, never the key itself.
  app.get('/settings/anthropic-key', async () => ({ set: hasAnthropicKey() }))

  app.put('/settings/anthropic-key', async (request) => {
    const body = request.body as { key?: unknown }
    setAnthropicKey(typeof body?.key === 'string' ? body.key : '')
    return { set: hasAnthropicKey() }
  })

  // Custom output styles the user (or a project) has written, so the picker shows the same
  // list /config would. Built-ins live in shared/constants; only the custom ones need disk.
  // `cwd` is optional and scopes the project-level lookup to one chat's folder.
  app.get('/settings/output-styles', async (request) => {
    const { cwd } = request.query as { cwd?: string }
    const dirs = [path.join(os.homedir(), '.claude', 'output-styles')]
    if (cwd) dirs.push(path.join(cwd, '.claude', 'output-styles'))

    const styles: Array<{ value: string; name: string; description: string; source: 'user' | 'project' }> = []
    const seen = new Set<string>()

    for (const [i, dir] of dirs.entries()) {
      let files: string[]
      try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.md'))
      } catch {
        continue // directory absent is the normal case, not an error
      }
      for (const file of files) {
        try {
          // Only the frontmatter is needed, and these files can be long, so read the head.
          const head = fs.readFileSync(path.join(dir, file), 'utf8').slice(0, 2000)
          const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1] ?? ''
          const field = (key: string) =>
            (new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fm)?.[1] ?? '').trim().replace(/^['"]|['"]$/g, '')
          // The CLI's rule: frontmatter `name` wins, else the file name.
          const name = field('name') || file.replace(/\.md$/, '')
          if (!name || seen.has(name)) continue
          seen.add(name)
          styles.push({
            value: name,
            name,
            description: field('description') || 'Custom output style',
            source: i === 0 ? 'user' : 'project',
          })
        } catch { /* unreadable file: skip it rather than fail the list */ }
      }
    }

    return { styles: styles.sort((a, b) => a.name.localeCompare(b.name)) }
  })
}
