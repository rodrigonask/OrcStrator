import type { ScheduleConfig } from './types.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS  = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

export function computeNextRun(cfg: ScheduleConfig, now = Date.now()): number | undefined {
  if (!cfg.enabled) return undefined

  switch (cfg.type) {
    case 'once':
      return cfg.runAt

    case 'daily': {
      const hours = cfg.hours ?? [9]
      const d = new Date(now)
      // Try today's remaining hours first
      for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
        const base = new Date(d)
        base.setUTCDate(base.getUTCDate() + dayOffset)
        for (const h of [...hours].sort((a, b) => a - b)) {
          base.setUTCHours(h, 0, 0, 0)
          if (base.getTime() > now) return base.getTime()
        }
      }
      // Fallback: first hour tomorrow
      const tomorrow = new Date(d)
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
      tomorrow.setUTCHours((hours.sort((a, b) => a - b))[0], 0, 0, 0)
      return tomorrow.getTime()
    }

    case 'weekly': {
      const days = cfg.days ?? [1] // default Monday
      const hour = cfg.weeklyHour ?? 9
      const d = new Date(now)
      // Look up to 8 days ahead
      for (let i = 0; i < 8; i++) {
        const candidate = new Date(d)
        candidate.setUTCDate(candidate.getUTCDate() + i)
        candidate.setUTCHours(hour, 0, 0, 0)
        if (days.includes(candidate.getUTCDay()) && candidate.getTime() > now) {
          return candidate.getTime()
        }
      }
      return undefined
    }

    case 'interval': {
      const value = cfg.intervalValue ?? 1
      const unit = cfg.intervalUnit ?? 'days'
      const unitMs = unit === 'hours' ? HOUR_MS : unit === 'weeks' ? WEEK_MS : DAY_MS
      const base = cfg.lastRunAt ?? now
      return base + value * unitMs
    }

    case 'monthly': {
      const dom = cfg.dayOfMonth ?? 1
      const hour = cfg.monthlyHour ?? 9
      const d = new Date(now)
      // Try this month and next
      for (let monthOffset = 0; monthOffset <= 2; monthOffset++) {
        const candidate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthOffset, dom, hour, 0, 0, 0))
        if (candidate.getTime() > now) return candidate.getTime()
      }
      return undefined
    }

    default:
      return undefined
  }
}

export function isDue(cfg: ScheduleConfig, now = Date.now()): boolean {
  if (!cfg.enabled || cfg.currentlyRunning) return false
  if (!cfg.nextRunAt) return false
  return cfg.nextRunAt <= now
}

export function formatNextRun(cfg: ScheduleConfig, now = Date.now()): string {
  const next = cfg.nextRunAt ?? computeNextRun(cfg, now)
  if (!next) return 'Not scheduled'
  const d = new Date(next)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const diffMs = next - now
  if (diffMs < 0) return 'Overdue'
  if (diffMs < HOUR_MS) return `In ${Math.round(diffMs / 60000)} min`
  if (diffMs < DAY_MS) return `Today at ${hh}:${mm}`
  if (diffMs < 2 * DAY_MS) return `Tomorrow at ${hh}:${mm}`
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} at ${hh}:${mm}`
}

export function scheduleTypeLabel(cfg: ScheduleConfig): string {
  switch (cfg.type) {
    case 'once':    return 'Once'
    case 'daily':   return `Daily at ${(cfg.hours ?? [9]).map(h => `${h}:00`).join(', ')}`
    case 'weekly': {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      const dayNames = (cfg.days ?? [1]).map(d => days[d]).join('/')
      return `Weekly ${dayNames} at ${cfg.weeklyHour ?? 9}:00`
    }
    case 'interval':
      return `Every ${cfg.intervalValue ?? 1} ${cfg.intervalUnit ?? 'days'}`
    case 'monthly':
      return `Monthly day ${cfg.dayOfMonth ?? 1} at ${cfg.monthlyHour ?? 9}:00`
    default:
      return 'Unknown'
  }
}
