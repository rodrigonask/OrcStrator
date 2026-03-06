import { Graphics, Container, AnimatedSprite } from 'pixi.js'
import type { Texture } from 'pixi.js'
import { SpriteManager } from './SpriteManager'

export type ProjectileRole = 'planner' | 'builder' | 'tester' | 'promoter' | 'default'

export const ROLE_COLOR: Record<ProjectileRole, number> = {
  planner:  0x4fc3f7,  // cyan-blue
  builder:  0x8d6e63,  // brown
  tester:   0xe0e0e0,  // white
  promoter: 0xffd54f,  // gold
  default:  0xaaaaaa,
}

export class Projectile {
  readonly gfx: Container
  active = false
  role: ProjectileRole = 'default'
  private sprite: AnimatedSprite | null = null
  private graphics: Graphics | null = null

  constructor() {
    this.gfx = new Container()
    this.gfx.visible = false
  }

  fire(role: ProjectileRole) {
    this.role = role
    this._cleanup()

    // Try sprite-based projectile first
    const frames = SpriteManager.getProjectileFrames(role)
    if (frames.length > 0) {
      this._fireSprite(frames)
    } else {
      this._fireGraphics(role)
    }

    this.gfx.visible = true
    this.active = true
  }

  private _fireSprite(frames: Texture[]) {
    const sprite = new AnimatedSprite(frames)
    sprite.anchor.set(0.5)
    sprite.animationSpeed = 0.15
    sprite.scale.set(2) // 16px frames scaled up to ~32px for visibility
    sprite.play()
    this.sprite = sprite
    this.gfx.addChild(sprite)
  }

  private _fireGraphics(role: ProjectileRole) {
    const color = ROLE_COLOR[role]
    const g = new Graphics()

    switch (role) {
      case 'planner':
        g.circle(0, 0, 12)
        g.fill({ color, alpha: 0.2 })
        g.circle(0, 0, 7)
        g.fill({ color, alpha: 0.5 })
        g.circle(0, 0, 4)
        g.fill({ color, alpha: 1.0 })
        break
      case 'builder':
        g.poly([0, -5, 14, 0, 0, 5]).fill({ color })
        g.moveTo(-12, 0).lineTo(0, 0).stroke({ color, width: 3 })
        g.moveTo(-2, -4).lineTo(-2, 4).stroke({ color: 0x555555, width: 2 })
        break
      case 'tester':
        g.poly([0, -3, 10, 0, 0, 3]).fill({ color })
        g.moveTo(-14, 0).lineTo(0, 0).stroke({ color, width: 2 })
        g.moveTo(-14, 0).lineTo(-18, -4).stroke({ color, width: 1.5 })
        g.moveTo(-14, 0).lineTo(-18, 4).stroke({ color, width: 1.5 })
        break
      case 'promoter':
        g.rect(-3, -10, 6, 20).fill({ color, alpha: 0.9 })
        g.rect(-6, -8, 12, 16).fill({ color, alpha: 0.3 })
        g.poly([0, -6, 4, 0, 0, 6, -4, 0]).fill({ color: 0xffffff, alpha: 0.7 })
        break
      default:
        g.circle(0, 0, 5).fill({ color })
    }

    this.graphics = g
    this.gfx.addChild(g)
  }

  private _cleanup() {
    if (this.sprite) {
      this.sprite.stop()
      this.gfx.removeChild(this.sprite)
      this.sprite.destroy()
      this.sprite = null
    }
    if (this.graphics) {
      this.gfx.removeChild(this.graphics)
      this.graphics.destroy()
      this.graphics = null
    }
  }

  reset() {
    this.gfx.visible = false
    this.active = false
    this.role = 'default'
    this._cleanup()
  }

  destroy() {
    this._cleanup()
    this.gfx.destroy()
  }
}

/** Simple object pool for reuse -- pre-allocates projectiles, adds them to the parent container. */
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
