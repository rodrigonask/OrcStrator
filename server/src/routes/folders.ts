import type { FastifyInstance } from 'fastify'
import type { FolderConfig } from '@nasklaude/shared'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import crypto from 'crypto'

function rowToFolder(r: Record<string, unknown>): FolderConfig {
  return {
    id: r.id as string,
    path: r.path as string,
    name: r.name as string,
    displayName: r.display_name as string | undefined,
    emoji: r.emoji as string | undefined,
    client: r.client as string | undefined,
    projectType: r.project_type as FolderConfig['projectType'],
    color: r.color as string | undefined,
    status: (r.status as FolderConfig['status']) || 'active',
    repoUrl: r.repo_url as string | undefined,
    notes: r.notes as string | undefined,
    expanded: Boolean(r.expanded),
    sortOrder: r.sort_order as number,
    createdAt: r.created_at as number,
  }
}

export default async function folderRoutes(app: FastifyInstance): Promise<void> {
  // Create folder
  app.post('/folders', async (request, reply) => {
    const body = request.body as Record<string, unknown>
    const id = crypto.randomUUID()
    const now = Date.now()

    db.prepare(`
      INSERT INTO folders (id, path, name, display_name, emoji, client, project_type, color, status, repo_url, notes, expanded, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.path as string,
      body.name as string || '',
      body.displayName as string || null,
      body.emoji as string || null,
      body.client as string || null,
      body.projectType as string || 'other',
      body.color as string || null,
      body.status as string || 'active',
      body.repoUrl as string || null,
      body.notes as string || null,
      body.expanded !== undefined ? (body.expanded ? 1 : 0) : 1,
      body.sortOrder as number ?? 0,
      now
    )

    const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Record<string, unknown>
    const folder = rowToFolder(row)
    broadcastEvent({ type: 'folder:created', payload: folder })
    reply.code(201)
    return folder
  })

  // Update folder
  app.put('/folders/:id', async (request) => {
    const { id } = request.params as { id: string }
    const body = request.body as Record<string, unknown>

    const sets: string[] = []
    const params: unknown[] = []

    const fieldMap: Record<string, string> = {
      path: 'path', name: 'name', displayName: 'display_name',
      emoji: 'emoji', client: 'client', projectType: 'project_type',
      color: 'color', status: 'status', repoUrl: 'repo_url',
      notes: 'notes', expanded: 'expanded', sortOrder: 'sort_order'
    }

    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (body[jsKey] !== undefined) {
        sets.push(`${dbKey} = ?`)
        if (jsKey === 'expanded') {
          params.push(body[jsKey] ? 1 : 0)
        } else {
          params.push(body[jsKey])
        }
      }
    }

    if (sets.length === 0) return { ok: true }

    params.push(id)
    db.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).run(...params)

    const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Record<string, unknown>
    const folder = rowToFolder(row)
    broadcastEvent({ type: 'folder:updated', payload: folder })
    return folder
  })

  // Delete folder
  app.delete('/folders/:id', async (request) => {
    const { id } = request.params as { id: string }
    db.prepare('DELETE FROM folders WHERE id = ?').run(id)
    broadcastEvent({ type: 'folder:deleted', payload: { id } })
    return { ok: true }
  })

  // Reorder folders
  app.put('/folders/reorder', async (request) => {
    const { ids } = request.body as { ids: string[] }
    const stmt = db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?')
    const transaction = db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        stmt.run(i, ids[i])
      }
    })
    transaction()
    broadcastEvent({ type: 'folders:reordered', payload: { ids } })
    return { ok: true }
  })
}
