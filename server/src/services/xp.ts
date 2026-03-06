import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { AGENT_XP_TABLE, LEVELS } from '@nasklaude/shared'

export function awardInstanceXp(instanceId: string, eventType: string): void {
  const xp = AGENT_XP_TABLE[eventType]
  if (!xp) return

  const row = db.prepare('SELECT xp_total, level FROM instances WHERE id = ?').get(instanceId) as
    { xp_total: number; level: number } | undefined
  if (!row) return

  const newXp = (row.xp_total ?? 0) + xp
  const oldLevel = row.level ?? 1

  // Compute new level from LEVELS table
  let newLevel = 1
  for (const l of LEVELS) {
    if (newXp >= l.xpRequired) newLevel = l.level
    else break
  }

  db.prepare('UPDATE instances SET xp_total = ?, level = ? WHERE id = ?')
    .run(newXp, newLevel, instanceId)

  broadcastEvent({
    type: 'instance:xp',
    payload: { instanceId, xpTotal: newXp, level: newLevel, xpAwarded: xp, eventType },
  })

  if (newLevel > oldLevel) {
    const levelInfo = LEVELS.find(l => l.level === newLevel)
    broadcastEvent({
      type: 'instance:levelup',
      payload: { instanceId, level: newLevel, name: levelInfo?.name, tier: levelInfo?.tier },
    })
  }
}
