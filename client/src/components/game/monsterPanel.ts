import { Container, Graphics, Text, Application } from 'pixi.js'
import { MonsterSprite, MONSTER_SIZES } from './MonsterSprite'
import type { PipelineTask } from '@shared/types'
import { BATTLE_ZONE, QUEUE_ZONE, GAME_H } from './constants'
import type { GameDisplayMode } from './constants'
import { ROLE_COLOR } from './projectile'
import type { ProjectileRole } from './projectile'
import { burst } from './particles'

const PADDING  = 10
const HEADER_H = 24

function idHash(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff
  return h
}

function getHp(task: PipelineTask): number {
  const h = idHash(task.id)
  switch (task.column) {
    case 'spec':    return 100
    case 'build':   return 50 + (h % 26)
    case 'qa':      return 15 + (h % 35)
    case 'ship':    return 1  + (h % 14)
    case 'scheduled': return 25 + (h % 25)
    default:        return 50
  }
}

export class MonsterPanel {
  private stage: Container
  private app: Application
  private frontContainer: Container
  private backContainer: Container
  private frontSprites = new Map<string, MonsterSprite>()
  private backSprites = new Map<string, MonsterSprite>()
  private dying = new Set<string>()
  private prevTaskIds = new Set<string>()
  private frontCountText: Text
  private backCountText: Text
  private frontCountBg: Graphics
  private backCountBg: Graphics

  constructor(stage: Container, app: Application) {
    this.stage = stage
    this.app = app

    // Battle zone (yellow) — active tasks being worked on
    this.frontContainer = new Container()
    this.frontContainer.x = BATTLE_ZONE.x + 8
    this.frontContainer.y = HEADER_H + PADDING
    stage.addChild(this.frontContainer)

    // Queue zone (red) — pipeline tasks waiting
    this.backContainer = new Container()
    this.backContainer.x = QUEUE_ZONE.x + 8
    this.backContainer.y = HEADER_H + PADDING
    stage.addChild(this.backContainer)

    // Zone counter badge backgrounds (pill behind text, hidden initially)
    const BADGE_W = 120
    const BADGE_H = 20
    const BADGE_Y = HEADER_H - 17

    this.frontCountBg = new Graphics()
    this.frontCountBg.roundRect(BATTLE_ZONE.x + BATTLE_ZONE.w / 2 - BADGE_W / 2, BADGE_Y, BADGE_W, BADGE_H, 5)
    this.frontCountBg.fill({ color: 0x000000, alpha: 0.88 })
    this.frontCountBg.alpha = 0
    stage.addChild(this.frontCountBg)

    this.backCountBg = new Graphics()
    this.backCountBg.roundRect(QUEUE_ZONE.x + QUEUE_ZONE.w / 2 - BADGE_W / 2, BADGE_Y, BADGE_W, BADGE_H, 5)
    this.backCountBg.fill({ color: 0x000000, alpha: 0.88 })
    this.backCountBg.alpha = 0
    stage.addChild(this.backCountBg)

    // Zone counter text (on top of pill)
    this.frontCountText = new Text({
      text: '',
      style: { fontFamily: 'monospace', fontSize: 13, fill: 0xffe566, fontWeight: 'bold' },
    })
    this.frontCountText.x = BATTLE_ZONE.x + BATTLE_ZONE.w / 2
    this.frontCountText.y = HEADER_H - 14
    this.frontCountText.anchor.set(0.5, 0)
    stage.addChild(this.frontCountText)

    this.backCountText = new Text({
      text: '',
      style: { fontFamily: 'monospace', fontSize: 13, fill: 0xddaaff, fontWeight: 'bold' },
    })
    this.backCountText.x = QUEUE_ZONE.x + QUEUE_ZONE.w / 2
    this.backCountText.y = HEADER_H - 14
    this.backCountText.anchor.set(0.5, 0)
    stage.addChild(this.backCountText)

    // Floor lines
    const floorFront = new Graphics()
    floorFront.moveTo(BATTLE_ZONE.x + 8, GAME_H - 20).lineTo(BATTLE_ZONE.x + BATTLE_ZONE.w - 8, GAME_H - 20)
    floorFront.stroke({ color: 0xffcc44, alpha: 0.25, width: 1 })
    stage.addChild(floorFront)

    const floorBack = new Graphics()
    floorBack.moveTo(QUEUE_ZONE.x + 8, GAME_H - 20).lineTo(QUEUE_ZONE.x + QUEUE_ZONE.w - 8, GAME_H - 20)
    floorBack.stroke({ color: 0xcc88ff, alpha: 0.25, width: 1 })
    stage.addChild(floorBack)
  }

  update(tasks: PipelineTask[]) {
    const ACTIVE_COLS = new Set(['spec', 'build', 'qa', 'ship'])
    const frontRow = tasks.filter(t => ACTIVE_COLS.has(t.column)).slice(0, 6)
    const backRow  = tasks.filter(t => !ACTIVE_COLS.has(t.column) && t.column !== 'done' && t.column !== 'backlog' && t.column !== 'on_ice')

    // Update zone counter badges — always visible, bright with count, dim without
    this.frontCountText.text       = frontRow.length > 0 ? `${frontRow.length} FIGHTING` : 'FIGHTING'
    this.backCountText.text        = backRow.length  > 0 ? `${backRow.length} QUEUED`    : 'QUEUED'
    this.frontCountText.style.fill = frontRow.length > 0 ? 0xffe566 : 0x886644
    this.backCountText.style.fill  = backRow.length  > 0 ? 0xddaaff : 0x664488
    this.frontCountBg.alpha        = frontRow.length > 0 ? 1 : 0.55
    this.backCountBg.alpha         = backRow.length  > 0 ? 1 : 0.55

    // Death animations: tasks that were present before but are now done
    const nowDone = tasks.filter(t => t.column === 'done' && this.prevTaskIds.has(t.id))
    for (const task of nowDone) {
      const sprite = this.frontSprites.get(task.id)
      if (sprite && !this.dying.has(task.id)) {
        this.dying.add(task.id)
        this._playDeathAnim(task.id, sprite)
      }
    }

    this.prevTaskIds = new Set(tasks.map(t => t.id))

    // Remove front sprites not in new front row (not dying)
    for (const [id, sprite] of this.frontSprites) {
      if (!frontRow.find(t => t.id === id) && !this.dying.has(id)) {
        this.frontContainer.removeChild(sprite.container)
        sprite.destroy()
        this.frontSprites.delete(id)
      }
    }

    // Front row: vertical stack in battle zone
    const FRONT_ROW_H = 140
    frontRow.forEach((task, i) => {
      const size = MONSTER_SIZES[task.priority] ?? 44
      const x = (BATTLE_ZONE.w - 16 - size) / 2
      const y = i * FRONT_ROW_H
      const hp = getHp(task)

      if (this.frontSprites.has(task.id)) {
        const s = this.frontSprites.get(task.id)!
        s.updateHp(hp)
        s.container.x = x
        s.container.y = y
      } else {
        const sprite = new MonsterSprite(task, x, y, hp, this.app.ticker)
        this.frontSprites.set(task.id, sprite)
        this.frontContainer.addChild(sprite.container)
      }
    })

    this._renderBackRow(backRow)
  }

  private _renderBackRow(tasks: PipelineTask[]) {
    const BACK_COLS  = 3
    const BACK_SCALE = 0.6   // smaller sprites in queue to prevent overlap
    const BACK_ROW_H = 130   // enough room for nameplate + scaled body
    const taskIds = new Set(tasks.map(t => t.id))

    // Remove sprites no longer in queue
    for (const [id, sprite] of this.backSprites) {
      if (!taskIds.has(id)) {
        this.backContainer.removeChild(sprite.container)
        sprite.destroy()
        this.backSprites.delete(id)
      }
    }

    // Remove any leftover non-sprite children (old labels, overflow text)
    const spriteContainers = new Set([...this.backSprites.values()].map(s => s.container))
    for (let i = this.backContainer.children.length - 1; i >= 0; i--) {
      const child = this.backContainer.children[i]
      if (!spriteContainers.has(child)) {
        this.backContainer.removeChild(child)
        child.destroy()
      }
    }

    if (tasks.length === 0) return

    const visible = tasks.slice(0, 18)
    const colW = (QUEUE_ZONE.w - 16) / BACK_COLS

    visible.forEach((task, i) => {
      const col  = i % BACK_COLS
      const row  = Math.floor(i / BACK_COLS)
      const size = Math.round((MONSTER_SIZES[task.priority] ?? 44) * BACK_SCALE)
      const x    = col * colW + (colW - size) / 2
      const y    = row * BACK_ROW_H
      const hp   = getHp(task)

      if (this.backSprites.has(task.id)) {
        const s = this.backSprites.get(task.id)!
        s.updateHp(hp)
        s.container.x = x
        s.container.y = y
      } else {
        const sprite = new MonsterSprite(task, x, y, hp, this.app.ticker, BACK_SCALE)
        this.backSprites.set(task.id, sprite)
        this.backContainer.addChild(sprite.container)
      }
    })

    if (tasks.length > 18) {
      const maxRow = Math.ceil(18 / BACK_COLS)
      const more = new Text({
        text: `+${tasks.length - 18} more`,
        style: { fontFamily: 'monospace', fontSize: 9, fill: 0x885555 },
      })
      more.x = 0
      more.y = maxRow * BACK_ROW_H + 4
      this.backContainer.addChild(more)
    }
  }

  private _playDeathAnim(taskId: string, sprite: MonsterSprite) {
    sprite.playHurt()

    const c = sprite.container
    const startTime = Date.now()
    const DURATION = 500

    const tick = () => {
      const elapsed = Date.now() - startTime
      const t = Math.min(elapsed / DURATION, 1)
      c.scale.set(1 + t * 0.5)
      c.alpha = 1 - t

      if (t >= 1) {
        this.app.ticker.remove(tick)
        this.frontContainer.removeChild(c)
        sprite.destroy()
        this.frontSprites.delete(taskId)
        this.dying.delete(taskId)
      }
    }
    this.app.ticker.add(tick)
  }

  /**
   * Returns the stage-space center of the monster for the given taskId,
   * or null if not currently in the front row.
   */
  getMonsterCenter(taskId: string): { x: number; y: number } | null {
    const sprite = this.frontSprites.get(taskId)
    if (!sprite) return null
    const size = MONSTER_SIZES[sprite.priority] ?? 28
    return {
      x: this.frontContainer.x + sprite.container.x + size / 2,
      y: this.frontContainer.y + sprite.container.y + size / 2,
    }
  }

  /**
   * Plays a white flash + horizontal shake on the monster for the given taskId.
   */
  triggerHit(taskId: string, app: Application, role?: string, onDone?: () => void): void {
    const sprite = this.frontSprites.get(taskId)
    if (!sprite) { onDone?.(); return }

    sprite.playHurt()

    const c = sprite.container
    const body = c.getChildAt(1)
    const origTint = body.tint
    body.tint = 0xffffff

    const center = this.getMonsterCenter(taskId)
    if (center) {
      const r = (role as ProjectileRole) || 'default'
      const color = ROLE_COLOR[r] ?? 0xaaaaaa
      burst(this.stage, center.x, center.y, color, 5, app)
    }

    const origX = c.x
    const startTime = Date.now()
    const FLASH_MS = 80
    const TOTAL_MS = 280

    const tick = () => {
      const elapsed = Date.now() - startTime

      if (elapsed >= FLASH_MS && body.tint === 0xffffff) {
        body.tint = origTint
      }

      if (elapsed >= FLASH_MS && elapsed < TOTAL_MS) {
        const shakeT = (elapsed - FLASH_MS) / 200
        c.x = origX + Math.sin(shakeT * Math.PI * 5) * 3
      }

      if (elapsed >= TOTAL_MS) {
        app.ticker.remove(tick)
        c.x = origX
        body.tint = origTint
        onDone?.()
      }
    }
    app.ticker.add(tick)
  }

  applyDisplayMode(mode: GameDisplayMode) {
    for (const sprite of this.frontSprites.values()) sprite.applyDisplayMode(mode)
    for (const sprite of this.backSprites.values())  sprite.applyDisplayMode(mode)
    // Zone UI: hide badges in immersive mode
    const hideUI = mode === 'immersive'
    this.frontCountBg.visible   = !hideUI
    this.frontCountText.visible = !hideUI
    this.backCountBg.visible    = !hideUI
    this.backCountText.visible  = !hideUI
  }

  /** Force re-creation of all monster sprites (e.g. after sprite sheets load). */
  rebuild() {
    for (const sprite of this.frontSprites.values()) {
      this.frontContainer.removeChild(sprite.container)
      sprite.destroy()
    }
    this.frontSprites.clear()
    for (const sprite of this.backSprites.values()) {
      this.backContainer.removeChild(sprite.container)
      sprite.destroy()
    }
    this.backSprites.clear()
  }

  destroy() {
    for (const sprite of this.frontSprites.values()) sprite.destroy()
    this.frontSprites.clear()
    for (const sprite of this.backSprites.values()) sprite.destroy()
    this.backSprites.clear()
    this.stage.removeChild(this.frontContainer)
    this.stage.removeChild(this.backContainer)
    this.frontContainer.destroy()
    this.backContainer.destroy()
    this.stage.removeChild(this.frontCountBg)
    this.frontCountBg.destroy()
    this.stage.removeChild(this.backCountBg)
    this.backCountBg.destroy()
    this.stage.removeChild(this.frontCountText)
    this.frontCountText.destroy()
    this.stage.removeChild(this.backCountText)
    this.backCountText.destroy()
  }
}
