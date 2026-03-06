import { Graphics } from 'pixi.js'
import type { Container } from 'pixi.js'

export type ProjectileRole = 'planner' | 'builder' | 'tester' | 'promoter' | 'default'

const ROLE_COLOR: Record<ProjectileRole, number> = {
  planner:  0x4fc3f7,  // cyan-blue lightning
  builder:  0x8d6e63,  // brown arrow
  tester:   0xe0e0e0,  // white slash
  promoter: 0xffd54f,  // gold sparkles
  default:  0xaaaaaa,
}

export class Projectile {
  readonly gfx: Graphics
  active = false

  constructor() {
    this.gfx = new Graphics()
    this.gfx.visible = false
  }

  fire(role: ProjectileRole) {
    const color = ROLE_COLOR[role]
    const g = this.gfx
    g.clear()
    switch (role) {
      case 'planner':
        // zigzag lightning bolt
        g.moveTo(0, 0).lineTo(6, 8).lineTo(2, 8).lineTo(8, 18)
        g.stroke({ color, width: 2 })
        break
      case 'builder':
        // arrow: triangle head + line tail
        g.poly([0, -3, 6, 0, 0, 3]).fill({ color })
        g.moveTo(-8, 0).lineTo(0, 0).stroke({ color, width: 2 })
        break
      case 'tester':
        // arc slash
        g.arc(0, 0, 8, -Math.PI * 0.6, Math.PI * 0.6)
        g.stroke({ color, width: 3 })
        break
      case 'promoter':
        // 4 small diamonds (sparkles)
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2
          const px = Math.cos(a) * 6
          const py = Math.sin(a) * 6
          g.poly([px, py - 3, px + 2, py, px, py + 3, px - 2, py]).fill({ color })
        }
        break
      default:
        g.circle(0, 0, 4).fill({ color })
    }
    this.gfx.visible = true
    this.active = true
  }

  reset() {
    this.gfx.visible = false
    this.active = false
  }

  destroy() {
    this.gfx.destroy()
  }
}

/** Simple object pool for reuse — pre-allocates projectiles, adds them to the parent container. */
export class ProjectilePool {
  private pool: Projectile[]

  constructor(size: number, parent: Container) {
    this.pool = Array.from({ length: size }, () => {
      const p = new Projectile()
      parent.addChild(p.gfx)
      return p
    })
  }

  acquire(): Projectile | null {
    return this.pool.find(p => !p.active) ?? null
  }

  destroyAll() {
    this.pool.forEach(p => p.destroy())
    this.pool = []
  }
}
