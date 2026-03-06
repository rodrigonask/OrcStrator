import { AnimatedSprite, Container, Graphics, Text, Texture, Ticker } from 'pixi.js'
import { HealthBar } from './HealthBar'
import { SpriteManager } from './SpriteManager'
import type { PipelineTask } from '@shared/types'

const MONSTER_COLORS: Record<number, number> = {
  1: 0xcc2222,
  2: 0x448833,
  3: 0x88bb22,
  4: 0x4488cc,
}
export const MONSTER_SIZES: Record<number, number> = {
  1: 48, 2: 36, 3: 28, 4: 24,
}

export class MonsterSprite {
  readonly container: Container
  readonly priority: number
  private _hp: HealthBar
  private _taskId: string
  private _ticker: Ticker | null
  private _lastHp: number
  private _animSprite: AnimatedSprite | null = null
  private _idleTextures: Texture[] = []
  private _hurtTextures: Texture[] = []
  private _hurtTimer: ReturnType<typeof setTimeout> | null = null

  constructor(task: PipelineTask, x: number, y: number, hp: number, ticker?: Ticker) {
    this._taskId = task.id
    this.priority = task.priority
    this._ticker = ticker ?? null
    this._lastHp = hp
    this.container = new Container()
    this.container.x = x
    this.container.y = y

    const size = MONSTER_SIZES[task.priority] ?? 28
    const color = MONSTER_COLORS[task.priority] ?? 0x888888

    // Task title above monster
    const label = new Text({
      text: task.title.slice(0, 20),
      style: { fontFamily: 'monospace', fontSize: 9, fill: 0xaaaaaa },
    })
    label.anchor.set(0.5, 1)
    label.x = size / 2
    label.y = 14
    this.container.addChild(label)

    // Body: AnimatedSprite if available, fallback to Graphics
    this._idleTextures = SpriteManager.getMonsterFrames(task.priority, 'idle')
    this._hurtTextures = SpriteManager.getMonsterFrames(task.priority, 'hurt')

    if (this._idleTextures.length > 0) {
      const sprite = new AnimatedSprite(this._idleTextures)
      sprite.animationSpeed = 6 / 60 // ~6fps at 60fps ticker
      sprite.play()
      // Scale 32px sprite frames to fit MONSTER_SIZES
      const scale = size / 32
      sprite.scale.set(scale)
      sprite.x = 0
      sprite.y = 16
      this._animSprite = sprite
      this.container.addChild(sprite)
    } else {
      // Fallback: geometric Graphics
      const body = new Graphics()
      this._drawMonster(body, task.priority, size, color)
      body.x = 0
      body.y = 16
      this.container.addChild(body)
    }

    // Health bar below monster
    const barW = Math.max(size, 32)
    this._hp = new HealthBar(0, 16 + size + 4, barW, ticker ?? new Ticker())
    this._hp.update(hp)
    this.container.addChild(this._hp.container)
  }

  get taskId() { return this._taskId }

  updateHp(hp: number) {
    const dmg = this._lastHp - hp
    if (dmg > 0 && this._ticker) {
      this._spawnDmgText(dmg)
    }
    this._lastHp = hp
    this._hp.update(hp)
  }

  /** Swap to hurt animation for 300ms, then return to idle. */
  playHurt() {
    if (!this._animSprite || this._hurtTextures.length === 0) return
    if (this._hurtTimer) clearTimeout(this._hurtTimer)

    this._animSprite.textures = this._hurtTextures
    this._animSprite.animationSpeed = 6 / 60
    this._animSprite.play()

    this._hurtTimer = setTimeout(() => {
      if (this._animSprite && this._idleTextures.length > 0) {
        this._animSprite.textures = this._idleTextures
        this._animSprite.animationSpeed = 6 / 60
        this._animSprite.play()
      }
      this._hurtTimer = null
    }, 300)
  }

  /** Whether this monster uses an animated sprite (vs fallback graphics). */
  get hasSprite(): boolean {
    return this._animSprite !== null
  }

  private _spawnDmgText(dmg: number) {
    const size = MONSTER_SIZES[this.priority] ?? 28
    const txt = new Text({
      text: `-${dmg}`,
      style: { fontFamily: 'monospace', fontSize: 10, fill: 0xdd4422 },
    })
    txt.anchor.set(0.5, 0.5)
    txt.x = size / 2
    txt.y = 16 + size / 2
    this.container.addChild(txt)

    const startTime = Date.now()
    const tick = () => {
      const t = Math.min((Date.now() - startTime) / 600, 1)
      txt.y = (16 + size / 2) - t * 20
      txt.alpha = 1 - t
      if (t >= 1) {
        this._ticker!.remove(tick)
        this.container.removeChild(txt)
        txt.destroy()
      }
    }
    this._ticker!.add(tick)
  }

  private _drawMonster(g: Graphics, priority: number, size: number, color: number) {
    switch (priority) {
      case 1: // Dragon — large body + wings + crown
        g.rect(size * 0.2, size * 0.2, size * 0.6, size * 0.6).fill({ color })
        g.poly([0, size * 0.5, size * 0.25, size * 0.1, size * 0.25, size * 0.7]).fill({ color: color - 0x220000 })
        g.poly([size, size * 0.5, size * 0.75, size * 0.1, size * 0.75, size * 0.7]).fill({ color: color - 0x220000 })
        for (let i = 0; i < 3; i++) {
          const sx = size * 0.25 + i * size * 0.25
          g.poly([sx, 0, sx + size * 0.1, size * 0.25, sx - size * 0.05, size * 0.25]).fill({ color: 0xffaa00 })
        }
        break
      case 2: // Orc — blocky + horns
        g.roundRect(size * 0.1, size * 0.2, size * 0.8, size * 0.75, 4).fill({ color })
        g.poly([size * 0.2, size * 0.2, size * 0.1, 0, size * 0.3, size * 0.2]).fill({ color: 0xaaaaaa })
        g.poly([size * 0.8, size * 0.2, size * 0.9, 0, size * 0.7, size * 0.2]).fill({ color: 0xaaaaaa })
        break
      case 3: // Goblin — triangular + ears
        g.poly([size * 0.5, size * 0.1, size * 0.9, size, size * 0.1, size]).fill({ color })
        g.poly([size * 0.15, size * 0.3, 0, 0, size * 0.35, size * 0.3]).fill({ color })
        g.poly([size * 0.85, size * 0.3, size, 0, size * 0.65, size * 0.3]).fill({ color })
        break
      default: // Slime — blob + bumps
        g.circle(size / 2, size * 0.6, size * 0.4).fill({ color })
        g.ellipse(size / 2, size * 0.45, size * 0.35, size * 0.3).fill({ color })
        break
    }
    // Eyes
    const eyeY = priority === 4 ? size * 0.45 : size * (priority === 3 ? 0.55 : 0.5)
    const eyeR = size * 0.07
    g.circle(size * 0.35, eyeY, eyeR).fill({ color: 0xffffff })
    g.circle(size * 0.65, eyeY, eyeR).fill({ color: 0xffffff })
  }

  destroy() {
    if (this._hurtTimer) clearTimeout(this._hurtTimer)
    this._hp.destroy()
    this.container.destroy()
  }
}
