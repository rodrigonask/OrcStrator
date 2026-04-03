import { getScheduledTasksDue, getAllProjectIds } from './task-manager.js'
import { orchestrator } from './orchestrator.js'

const POLL_INTERVAL_MS = 60_000
const MIN_RUN_GAP_MS   = 60 * 60 * 1000 // 1 hour safety lock

class SchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch(err => console.error('[scheduler] tick error:', err))
    }, POLL_INTERVAL_MS)
    // Run once immediately after a short startup delay
    setTimeout(() => {
      this.tick().catch(err => console.error('[scheduler] initial tick error:', err))
    }, 5_000)
    console.log('[scheduler] SchedulerService started — polling every 60s')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<void> {
    try {
      const now = Date.now()
      const projectIds = getAllProjectIds()
      for (const projectId of projectIds) {
        const due = getScheduledTasksDue(projectId, now)
        for (const task of due) {
          const s = task.schedule!
          // Safety: skip if already running
          if (s.currentlyRunning) continue
          // Safety: skip if run within last hour
          if (s.lastRunAt && now - s.lastRunAt < MIN_RUN_GAP_MS) continue
          console.log(`[scheduler] Task "${task.title}" is due — dispatching`)
          await orchestrator.triggerScheduledTask(task)
        }
      }
    } catch (err) {
      console.error('[scheduler] tick error:', err)
    }
  }
}

export const schedulerService = new SchedulerService()
