import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { broadcastEvent } from '../ws/handler.js'
import { XP_TABLE, LEVELS } from '@nasklaude/shared'
import type { AccountProfile, TourState, XpEventType } from '@nasklaude/shared'

export default async function profileRoutes(app: FastifyInstance): Promise<void> {
  // Get profile
  app.get('/profile', async () => {
    const row = db.prepare('SELECT * FROM profile WHERE id = 1').get() as Record<string, unknown>
    return rowToProfile(row)
  })

  // Update profile
  app.put('/profile', async (request) => {
    const body = request.body as Partial<AccountProfile>
    const sets: string[] = []
    const params: unknown[] = []

    const fieldMap: Record<string, string> = {
      accountLevel: 'account_level',
      totalXp: 'total_xp',
      messagesSent: 'messages_sent',
      tokensSent: 'tokens_sent',
      tokensReceived: 'tokens_received'
    }

    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      const value = (body as Record<string, unknown>)[jsKey]
      if (value !== undefined) {
        sets.push(`${dbKey} = ?`)
        params.push(value)
      }
    }

    if (sets.length > 0) {
      params.push(1)
      db.prepare(`UPDATE profile SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    }

    const row = db.prepare('SELECT * FROM profile WHERE id = 1').get() as Record<string, unknown>
    const profile = rowToProfile(row)
    broadcastEvent({ type: 'profile:updated', payload: profile })
    return profile
  })

  // Add XP
  app.post('/profile/xp', async (request) => {
    const { eventType, multiplier } = request.body as { eventType: XpEventType; multiplier?: number }
    const xpAmount = (XP_TABLE[eventType] || 0) * (multiplier || 1)

    if (xpAmount <= 0) return { xpAdded: 0 }

    const current = db.prepare('SELECT total_xp, account_level FROM profile WHERE id = 1').get() as { total_xp: number; account_level: number }
    const newXp = current.total_xp + xpAmount

    // Calculate new level
    let newLevel = current.account_level
    for (const level of LEVELS) {
      if (newXp >= level.xpRequired) {
        newLevel = level.level
      }
    }

    // Update stat counter based on event type
    let statUpdate = ''
    if (eventType === 'message-sent') {
      statUpdate = ', messages_sent = messages_sent + 1'
    }

    db.prepare(`UPDATE profile SET total_xp = ?, account_level = ?${statUpdate} WHERE id = 1`).run(newXp, newLevel)

    const leveledUp = newLevel > current.account_level
    const profile = rowToProfile(db.prepare('SELECT * FROM profile WHERE id = 1').get() as Record<string, unknown>)

    if (leveledUp) {
      broadcastEvent({ type: 'profile:level-up', payload: { level: newLevel, name: LEVELS.find(l => l.level === newLevel)?.name } })
    }
    broadcastEvent({ type: 'profile:updated', payload: profile })

    return { xpAdded: xpAmount, leveledUp, profile }
  })

  // Get tour state
  app.get('/tour', async () => {
    const row = db.prepare('SELECT * FROM tour_state WHERE id = 1').get() as Record<string, unknown>
    return rowToTourState(row)
  })

  // Update tour state
  app.put('/tour', async (request) => {
    const body = request.body as Partial<TourState>
    const sets: string[] = []
    const params: unknown[] = []

    if (body.completedSteps !== undefined) { sets.push('completed_steps = ?'); params.push(JSON.stringify(body.completedSteps)) }
    if (body.currentLevel !== undefined) { sets.push('current_level = ?'); params.push(body.currentLevel) }
    if (body.levelChallengesCompleted !== undefined) { sets.push('level_challenges_completed = ?'); params.push(JSON.stringify(body.levelChallengesCompleted)) }
    if (body.dismissedHints !== undefined) { sets.push('dismissed_hints = ?'); params.push(JSON.stringify(body.dismissedHints)) }
    if (body.onboardingComplete !== undefined) { sets.push('onboarding_complete = ?'); params.push(body.onboardingComplete ? 1 : 0) }

    if (sets.length > 0) {
      params.push(1)
      db.prepare(`UPDATE tour_state SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    }

    const row = db.prepare('SELECT * FROM tour_state WHERE id = 1').get() as Record<string, unknown>
    const tour = rowToTourState(row)
    broadcastEvent({ type: 'tour:updated', payload: tour })
    return tour
  })

  // Complete a tour step
  app.post('/tour/complete-step', async (request) => {
    const { step } = request.body as { step: string }
    const row = db.prepare('SELECT completed_steps FROM tour_state WHERE id = 1').get() as { completed_steps: string }
    const steps: string[] = JSON.parse(row.completed_steps || '[]')

    if (!steps.includes(step)) {
      steps.push(step)
      db.prepare('UPDATE tour_state SET completed_steps = ? WHERE id = 1').run(JSON.stringify(steps))
    }

    const updated = db.prepare('SELECT * FROM tour_state WHERE id = 1').get() as Record<string, unknown>
    const tour = rowToTourState(updated)
    broadcastEvent({ type: 'tour:updated', payload: tour })
    return tour
  })

  // Dismiss a hint
  app.post('/tour/dismiss-hint', async (request) => {
    const { hint } = request.body as { hint: string }
    const row = db.prepare('SELECT dismissed_hints FROM tour_state WHERE id = 1').get() as { dismissed_hints: string }
    const hints: string[] = JSON.parse(row.dismissed_hints || '[]')

    if (!hints.includes(hint)) {
      hints.push(hint)
      db.prepare('UPDATE tour_state SET dismissed_hints = ? WHERE id = 1').run(JSON.stringify(hints))
    }

    const updated = db.prepare('SELECT * FROM tour_state WHERE id = 1').get() as Record<string, unknown>
    const tour = rowToTourState(updated)
    broadcastEvent({ type: 'tour:updated', payload: tour })
    return tour
  })
}

function rowToProfile(row: Record<string, unknown>): AccountProfile {
  return {
    accountLevel: row.account_level as number,
    totalXp: row.total_xp as number,
    messagesSent: row.messages_sent as number,
    tokensSent: row.tokens_sent as number,
    tokensReceived: row.tokens_received as number
  }
}

function rowToTourState(row: Record<string, unknown>): TourState {
  return {
    completedSteps: safeJsonParse(row.completed_steps as string, []),
    currentLevel: row.current_level as number,
    levelChallengesCompleted: safeJsonParse(row.level_challenges_completed as string, []),
    dismissedHints: safeJsonParse(row.dismissed_hints as string, []),
    onboardingComplete: Boolean(row.onboarding_complete)
  }
}

function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback
  try { return JSON.parse(str) as T } catch { return fallback }
}
