import { Container, Application } from 'pixi.js'
import type { InstanceConfig } from '@shared/types'
import { ProjectilePool, ROLE_COLOR } from './projectile'
import type { ProjectileRole } from './projectile'
import { trail } from './particles'
import { IDLE_ZONE, ACTIVE_ZONE, GAME_H } from './constants'

const PADDING     = 10
const HEADER_H    = 10
const IDLE_CHAR   = 80
const ACTIVE_CHAR = 80
const IDLE_ROW    = 100
const ACTIVE_ROW  = 100
const COLS        = 3

const ROLE_TRAVEL_MS: Record<string, number> = {
  planner: 700, builder: 300, tester: 500, promoter: 600,
}

const TRAIL_INTERVAL_MS = 40

/**
 * Compute stage-space center of an instance's character sprite.
 * Checks the active zone first (green), then idle zone (blue).
 */
export function getCharacterCenter(
  instanceId: string,
  activeInstanceIds: Set<string>,
  allInstances: InstanceConfig[],
): { x: number; y: number } | null {
  const activeList = allInstances.filter(i => activeInstanceIds.has(i.id))
  const idleList   = allInstances.filter(i => !activeInstanceIds.has(i.id))

  // Check active zone (3-column grid)
  const activeIdx = activeList.findIndex(i => i.id === instanceId)
  if (activeIdx !== -1) {
    const maxRows = Math.floor((GAME_H - HEADER_H - PADDING) / ACTIVE_ROW)
    if (activeIdx >= maxRows * COLS) return null
    const colW = (ACTIVE_ZONE.w - PADDING * 2) / COLS
    const col = activeIdx % COLS
    const row = Math.floor(activeIdx / COLS)
    const x = ACTIVE_ZONE.x + PADDING + col * colW + (colW - ACTIVE_CHAR) / 2
    const y = HEADER_H + PADDING + row * ACTIVE_ROW
    return { x: x + ACTIVE_CHAR / 2, y: y + ACTIVE_CHAR / 2 }
  }

  // Check idle zone (3-column grid)
  const idleIdx = idleList.findIndex(i => i.id === instanceId)
  if (idleIdx !== -1) {
    const maxRows = Math.floor((GAME_H - HEADER_H - PADDING) / IDLE_ROW)
    if (idleIdx >= maxRows * COLS) return null
    const colW = (IDLE_ZONE.w - PADDING * 2) / COLS
    const col = idleIdx % COLS
    const row = Math.floor(idleIdx / COLS)
    const x = IDLE_ZONE.x + PADDING + col * colW + (colW - IDLE_CHAR) / 2
    const y = HEADER_H + PADDING + row * IDLE_ROW
    return { x: x + IDLE_CHAR / 2, y: y + IDLE_CHAR / 2 }
  }

  return null
}

export class AttackAnimator {
  private app: Application
  private stage: Container
  private pool: ProjectilePool
  private queue: Array<() => void> = []
  private activeCount = 0
  private readonly MAX_CONCURRENT = 6

  constructor(stage: Container, app: Application) {
    this.app = app
    this.stage = stage
    this.pool = new ProjectilePool(10, stage)
  }

  fire(
    from: { x: number; y: number },
    to:   { x: number; y: number },
    role: string,
    onHit: () => void,
  ) {
    const doFire = () => {
      const projectile = this.pool.acquire()
      if (!projectile) {
        onHit()
        return
      }

      const r = (role as ProjectileRole) || 'default'
      projectile.fire(r)
      projectile.gfx.x = from.x
      projectile.gfx.y = from.y

      const travelMs = ROLE_TRAVEL_MS[role] ?? 500
      const startTime = Date.now()
      let lastTrailTime = startTime
      this.activeCount++

      const color = ROLE_COLOR[r] ?? 0xaaaaaa

      const tick = () => {
        const elapsed = Date.now() - startTime
        const t = Math.min(elapsed / travelMs, 1)

        const baseX = from.x + (to.x - from.x) * t
        const baseY = from.y + (to.y - from.y) * t

        let yOffset = 0
        switch (r) {
          case 'tester':
            yOffset = -Math.sin(t * Math.PI) * 40
            break
          case 'promoter':
            yOffset = -Math.sin(t * Math.PI) * 15
            break
        }

        projectile.gfx.x = baseX
        projectile.gfx.y = baseY + yOffset

        if (r === 'builder' || r === 'tester') {
          const dx = to.x - from.x
          const dy = (to.y - from.y) + (r === 'tester' ? -Math.cos(t * Math.PI) * 40 * Math.PI / travelMs : 0)
          projectile.gfx.rotation = Math.atan2(dy, dx)
        }

        const now = Date.now()
        if (now - lastTrailTime >= TRAIL_INTERVAL_MS && t < 0.95) {
          trail(this.stage, projectile.gfx.x, projectile.gfx.y, color, this.app)
          lastTrailTime = now
        }

        if (t >= 1) {
          this.app.ticker.remove(tick)
          projectile.gfx.rotation = 0
          projectile.reset()
          this.activeCount--
          onHit()
          this._dequeue()
        }
      }
      this.app.ticker.add(tick)
    }

    if (this.activeCount < this.MAX_CONCURRENT) {
      doFire()
    } else {
      this.queue.push(doFire)
    }
  }

  private _dequeue() {
    const next = this.queue.shift()
    if (next) next()
  }

  destroy() {
    this.pool.destroyAll()
    this.queue = []
  }
}
