import { Container, Application } from 'pixi.js'
import type { InstanceConfig, FolderConfig } from '@shared/types'
import { ProjectilePool } from './projectile'
import type { ProjectileRole } from './projectile'
import { LEFT_ZONE, GAME_H } from './constants'

const SILO_PADDING  = 8
const CHAR_SIZE     = 48
const CHAR_GAP      = 6
const SILO_HEADER_H = 20
const SILO_GAP      = 16
const MAX_SPRITES   = 6

const ROLE_TRAVEL_MS: Record<string, number> = {
  planner: 600, builder: 400, tester: 500, promoter: 700,
}

/**
 * Compute stage-space center of an instance's character sprite.
 * Replicates buildAgentPanel's layout math without modifying AgentPanel.ts.
 */
export function getCharacterCenter(
  instanceId: string,
  instances: InstanceConfig[],
  folders: FolderConfig[],
): { x: number; y: number } | null {
  let currentY = 20
  for (const folder of folders) {
    const folderInstances = instances.filter(i => i.folderId === folder.id)
    if (folderInstances.length === 0) continue
    const visible = folderInstances.slice(0, MAX_SPRITES)
    const spritesStartY = currentY + SILO_HEADER_H + SILO_PADDING
    const idx = visible.findIndex(i => i.id === instanceId)
    if (idx !== -1) {
      const spriteX = LEFT_ZONE.x + SILO_PADDING + idx * (CHAR_SIZE + CHAR_GAP) + 4
      return { x: spriteX + CHAR_SIZE / 2, y: spritesStartY + CHAR_SIZE / 2 }
    }
    const siloH = SILO_HEADER_H + CHAR_SIZE + SILO_PADDING * 2
    currentY += siloH + SILO_GAP
    if (currentY > GAME_H - 60) break
  }
  return null
}

export class AttackAnimator {
  private app: Application
  private pool: ProjectilePool
  private queue: Array<() => void> = []
  private activeCount = 0
  private readonly MAX_CONCURRENT = 6

  constructor(stage: Container, app: Application) {
    this.app = app
    this.pool = new ProjectilePool(10, stage)
  }

  /**
   * Fire a projectile from `from` to `to` position.
   * Calls onHit() when the projectile arrives at the target.
   */
  fire(
    from: { x: number; y: number },
    to:   { x: number; y: number },
    role: string,
    onHit: () => void,
  ) {
    const doFire = () => {
      const projectile = this.pool.acquire()
      if (!projectile) {
        // Pool exhausted — skip animation but still call onHit
        onHit()
        return
      }

      const r = (role as ProjectileRole) || 'default'
      projectile.fire(r)
      projectile.gfx.x = from.x
      projectile.gfx.y = from.y

      const travelMs = ROLE_TRAVEL_MS[role] ?? 500
      const startTime = Date.now()
      this.activeCount++

      const tick = () => {
        const elapsed = Date.now() - startTime
        const t = Math.min(elapsed / travelMs, 1)
        projectile.gfx.x = from.x + (to.x - from.x) * t
        projectile.gfx.y = from.y + (to.y - from.y) * t

        if (t >= 1) {
          this.app.ticker.remove(tick)
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
