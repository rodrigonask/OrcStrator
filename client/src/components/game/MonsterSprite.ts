import { AnimatedSprite, Container, Graphics, Text, Texture, Ticker } from 'pixi.js'
import { HealthBar } from './HealthBar'
import { SpriteManager } from './SpriteManager'
import type { PipelineTask } from '@shared/types'
import type { GameDisplayMode } from './constants'

const MONSTER_COLORS: Record<number, number> = {
  1: 0xcc2222,
  2: 0x448833,
  3: 0x88bb22,
  4: 0x4488cc,
}
export const MONSTER_SIZES: Record<number, number> = {
  1: 100, 2: 84, 3: 72, 4: 64,
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
  private _idleAnimTimer: ReturnType<typeof setTimeout> | null = null
  private _labelBg: Graphics | null = null
  private _idLabel: Text | null = null
  private _descLabel: Text | null = null
  private _pillCodeW = 0
  private _pillNameW = 0
  private _pillCenterX = 0
  private _nameplateY = 0

  constructor(task: PipelineTask, x: number, y: number, hp: number, ticker?: Ticker, scale = 1.0) {
    this._taskId = task.id
    this.priority = task.priority
    this._ticker = ticker ?? null
    this._lastHp = hp
    this.container = new Container()
    this.container.x = x
    this.container.y = y

    const size = Math.round((MONSTER_SIZES[task.priority] ?? 28) * scale)
    const color = MONSTER_COLORS[task.priority] ?? 0x888888

    // Two-line nameplate: ID (bright) + short description (dimmer)
    const actionNeeded = /^\[ACTION NEEDED\]/i.test(task.title)
    const raw = task.title.replace(/^\[ACTION NEEDED\]\s*/i, '')
    // Matches: "ID: desc", "ID - desc", "ID – desc", "ID — desc"
    const m       = raw.match(/^(.+?)(?:\s*:\s*|\s+[-–—]\s*)(.+)$/)
    const idPart  = (actionNeeded ? '⚠ ' : '') + (m ? m[1].trim() : raw.slice(0, 12).trim())
    const rawDesc = m ? m[2].trim() : ''
    const descPart = rawDesc.length > 15 ? rawDesc.slice(0, 15) + '…' : rawDesc

    const pillCodeW = Math.max(idPart.length * 9 + 16, 64)
    const pillNameW = descPart ? Math.max(descPart.length * 7.5 + 16, 64) : pillCodeW
    const pillW = Math.max(pillCodeW, pillNameW)
    const pillH = descPart ? 38 : 24

    this._pillCodeW   = pillCodeW
    this._pillNameW   = pillNameW
    this._pillCenterX = size / 2
    this._nameplateY  = size + 4   // below the body

    // Body: AnimatedSprite if available, fallback to Graphics
    this._idleTextures = SpriteManager.getMonsterFrames(task.priority, 'idle')
    this._hurtTextures = SpriteManager.getMonsterFrames(task.priority, 'hurt')

    if (this._idleTextures.length > 0) {
      const sprite = new AnimatedSprite(this._idleTextures)
      sprite.animationSpeed = 0.15
      sprite.loop = false
      sprite.gotoAndStop(0)
      const scale = size / 128
      sprite.scale.set(scale)
      sprite.x = 0
      sprite.y = 0
      this._animSprite = sprite
      this.container.addChild(sprite)

      // Random idle animation every 7-30 seconds
      const scheduleIdle = () => {
        const delayMs = 7000 + Math.random() * 23000
        this._idleAnimTimer = setTimeout(() => {
          if (this._animSprite && !this._animSprite.destroyed) {
            this._animSprite.gotoAndPlay(0)
          }
        }, delayMs)
      }
      sprite.onComplete = () => { scheduleIdle() }
      setTimeout(() => { if (sprite && !sprite.destroyed) sprite.gotoAndPlay(0) }, Math.random() * 5000)
    } else {
      // Fallback: geometric Graphics
      const body = new Graphics()
      this._drawMonster(body, task.priority, size, color)
      body.x = 0
      body.y = 0
      this.container.addChild(body)
    }

    // Health bar squares at bottom-right of body
    this._hp = new HealthBar(0, 0, size, ticker ?? new Ticker())
    this._hp.update(hp)
    this.container.addChild(this._hp.container)

    // Nameplate at the monster's feet (below body)
    const ny = this._nameplateY
    const labelBg = new Graphics()
    labelBg.roundRect(size / 2 - pillW / 2, ny, pillW, pillH, 4)
    labelBg.fill({ color: 0x000000, alpha: 0.88 })
    this.container.addChild(labelBg)
    this._labelBg = labelBg

    const idLabel = new Text({
      text: idPart,
      style: { fontFamily: 'monospace', fontSize: 14, fill: 0xffffff, fontWeight: 'bold' },
    })
    idLabel.anchor.set(0.5, 0)
    idLabel.x = size / 2
    idLabel.y = ny + 4
    this.container.addChild(idLabel)
    this._idLabel = idLabel

    if (descPart) {
      const descLabel = new Text({
        text: descPart,
        style: { fontFamily: 'monospace', fontSize: 11, fill: 0xddeeff },
      })
      descLabel.anchor.set(0.5, 0)
      descLabel.x = size / 2
      descLabel.y = ny + 22
      this.container.addChild(descLabel)
      this._descLabel = descLabel
    }
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
      style: { fontFamily: 'monospace', fontSize: 14, fill: 0xff5533, fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } },
    })
    txt.anchor.set(0.5, 0.5)
    txt.x = size / 2
    txt.y = size / 2
    this.container.addChild(txt)

    const startTime = Date.now()
    const tick = () => {
      const t = Math.min((Date.now() - startTime) / 600, 1)
      txt.y = size / 2 - t * 20
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

  applyDisplayMode(mode: GameDisplayMode) {
    const showCode    = mode === 'code' || mode === 'both'
    const showName    = mode === 'name' || mode === 'both'
    const showBars    = mode !== 'immersive'
    const showAnyText = showCode || showName
    if (this._idLabel)   this._idLabel.visible   = showCode
    if (this._descLabel) this._descLabel.visible  = showName
    this._hp.container.visible = showBars

    if (this._labelBg) {
      this._labelBg.visible = showAnyText
      if (showAnyText) {
        const ny      = this._nameplateY
        const hasDesc = this._descLabel !== null
        let w: number, h: number
        if (showCode && showName && hasDesc) {
          w = Math.max(this._pillCodeW, this._pillNameW); h = 38
          if (this._descLabel) this._descLabel.y = ny + 22
        } else if (showName && hasDesc) {
          w = this._pillNameW; h = 24
          if (this._descLabel) this._descLabel.y = ny + 4
        } else {
          w = this._pillCodeW; h = 24
          if (this._descLabel) this._descLabel.y = ny + 22
        }
        this._labelBg.clear()
        this._labelBg.roundRect(this._pillCenterX - w / 2, ny, w, h, 4)
        this._labelBg.fill({ color: 0x000000, alpha: 0.88 })
      }
    }
  }

  destroy() {
    if (this._hurtTimer) clearTimeout(this._hurtTimer)
    if (this._idleAnimTimer) clearTimeout(this._idleAnimTimer)
    this._hp.destroy()
    this.container.destroy()
  }
}
