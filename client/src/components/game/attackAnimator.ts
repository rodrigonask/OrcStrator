import { Container, Application } from 'pixi.js'
import type { InstanceConfig, FolderConfig } from '@shared/types'
import { ProjectilePool, ROLE_COLOR } from './projectile'
import type { ProjectileRole } from './projectile'
import { trail } from './particles'
import { LEFT_ZONE, GAME_H } from './constants'

const SILO_PADDING  = 10
const CHAR_SIZE     = 80
const CHAR_GAP      = 8
const SILO_HEADER_H = 22
const SILO_GAP      = 14
const MAX_SPRITES   = 5

const ROLE_TRAVEL_MS: Record<string, number> = {
  planner: 700, builder: 300, tester: 500, promoter: 600,
}

// Trail spawn interval (ms) — spawn a trail particle every N ms during travel
const TRAIL_INTERVAL_MS = 40

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
      let lastTrailTime = startTime
      this.activeCount++

      const color = ROLE_COLOR[r] ?? 0xaaaaaa

      const tick = () => {
        const elapsed = Date.now() - startTime
        const t = Math.min(elapsed / travelMs, 1)

        // Base linear interpolation
        const baseX = from.x + (to.x - from.x) * t
        const baseY = from.y + (to.y - from.y) * t

        // Per-role trajectory offset
        let yOffset = 0
        switch (r) {
          case 'tester':
            // Arc trajectory — parabolic y offset
            yOffset = -Math.sin(t * Math.PI) * 40
            break
          case 'promoter':
            // Slight upward curve
            yOffset = -Math.sin(t * Math.PI) * 15
            break
        }

        projectile.gfx.x = baseX
        projectile.gfx.y = baseY + yOffset

        // Rotation for arrow-type projectiles
        if (r === 'builder' || r === 'tester') {
          const dx = to.x - from.x
          const dy = (to.y - from.y) + (r === 'tester' ? -Math.cos(t * Math.PI) * 40 * Math.PI / travelMs : 0)
          projectile.gfx.rotation = Math.atan2(dy, dx)
        }

        // Spawn trail particles
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
