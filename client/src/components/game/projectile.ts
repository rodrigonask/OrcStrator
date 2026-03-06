import { Graphics } from 'pixi.js'
import type { Container } from 'pixi.js'

export type ProjectileRole = 'planner' | 'builder' | 'tester' | 'promoter' | 'default'

export const ROLE_COLOR: Record<ProjectileRole, number> = {
  planner:  0x4fc3f7,  // cyan-blue
  builder:  0x8d6e63,  // brown
  tester:   0xe0e0e0,  // white
  promoter: 0xffd54f,  // gold
  default:  0xaaaaaa,
}

export class Projectile {
  readonly gfx: Graphics
  active = false
  role: ProjectileRole = 'default'

  constructor() {
    this.gfx = new Graphics()
    this.gfx.visible = false
  }

  fire(role: ProjectileRole) {
    const color = ROLE_COLOR[role]
    const g = this.gfx
    g.clear()
    this.role = role

    switch (role) {
      case 'planner':
        // Glowing orb: outer glow + inner filled circle
        g.circle(0, 0, 12)
        g.fill({ color, alpha: 0.2 })
        g.circle(0, 0, 7)
        g.fill({ color, alpha: 0.5 })
        g.circle(0, 0, 4)
        g.fill({ color, alpha: 1.0 })
        break
      case 'builder':
        // Larger arrow/sword shape
        g.poly([0, -5, 14, 0, 0, 5]).fill({ color })
        g.moveTo(-12, 0).lineTo(0, 0).stroke({ color, width: 3 })
        // Cross-guard
        g.moveTo(-2, -4).lineTo(-2, 4).stroke({ color: 0x555555, width: 2 })
        break
      case 'tester':
        // Sleek arrow with fletching
        g.poly([0, -3, 10, 0, 0, 3]).fill({ color })
        g.moveTo(-14, 0).lineTo(0, 0).stroke({ color, width: 2 })
        // Fletching
        g.moveTo(-14, 0).lineTo(-18, -4).stroke({ color, width: 1.5 })
        g.moveTo(-14, 0).lineTo(-18, 4).stroke({ color, width: 1.5 })
        break
      case 'promoter':
        // Golden beam / light column
        g.rect(-3, -10, 6, 20).fill({ color, alpha: 0.9 })
        g.rect(-6, -8, 12, 16).fill({ color, alpha: 0.3 })
        // Diamond accent at center
        g.poly([0, -6, 4, 0, 0, 6, -4, 0]).fill({ color: 0xffffff, alpha: 0.7 })
        break
      default:
        g.circle(0, 0, 5).fill({ color })
    }
    this.gfx.visible = true
    this.active = true
  }

  reset() {
    this.gfx.visible = false
    this.active = false
    this.role = 'default'
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
