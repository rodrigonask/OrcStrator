import { Container, Graphics, Text, Application } from 'pixi.js'
import { MonsterSprite, MONSTER_SIZES } from './MonsterSprite'
import type { PipelineTask } from '@shared/types'
import { RIGHT_ZONE } from './constants'
import { ROLE_COLOR } from './projectile'
import type { ProjectileRole } from './projectile'
import { burst } from './particles'

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
    case 'staging': return 25 + (h % 25)
    default:        return 50
  }
}

export class MonsterPanel {
  private stage: Container
  private app: Application
  private zone: { x: number; w: number }
  private frontContainer: Container
  private backContainer: Container
  private frontSprites = new Map<string, MonsterSprite>()
  private dying = new Set<string>()
  private prevTaskIds = new Set<string>()

  constructor(stage: Container, app: Application, zone: { x: number; w: number }) {
    this.stage = stage
    this.app = app
    this.zone = zone

    this.frontContainer = new Container()
    this.frontContainer.x = zone.x + 8
    this.frontContainer.y = 20
    stage.addChild(this.frontContainer)

    this.backContainer = new Container()
    this.backContainer.x = zone.x + 8
    this.backContainer.y = 340
    stage.addChild(this.backContainer)
  }

  update(tasks: PipelineTask[]) {
    const frontRow = tasks.filter(t => t.lockedBy && t.column !== 'done').slice(0, 6)
    const backRow  = tasks.filter(t => !t.lockedBy && t.column !== 'done' && t.column !== 'backlog')

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

    // Add / update front row sprites
    const COL_W = (this.zone.w - 16) / 3
    const ROW_H = 110
    frontRow.forEach((task, i) => {
      const col = i % 3
      const row = Math.floor(i / 3)
      const x = col * COL_W
      const y = row * ROW_H
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
    this.backContainer.removeChildren()

    const count = tasks.length
    const visible = tasks.slice(0, 50)

    const labelText = count > 50 ? `${count}+ in queue` : count === 0 ? 'queue empty' : `${count} in queue`
    const label = new Text({
      text: labelText,
      style: { fontFamily: 'monospace', fontSize: 10, fill: 0x667788 },
    })
    label.x = 0
    label.y = 0
    this.backContainer.addChild(label)

    const SZ = 14
    const GAP = 3
    const PER_ROW = 8
    visible.forEach((task, i) => {
      const col = i % PER_ROW
      const row = Math.floor(i / PER_ROW)
      const color = [0xcc2222, 0x448833, 0x88bb22, 0x4488cc][task.priority - 1] ?? 0x888888
      const sq = new Graphics()
      sq.rect(0, 0, SZ, SZ).fill({ color, alpha: 0.7 })
      sq.x = col * (SZ + GAP)
      sq.y = 18 + row * (SZ + GAP)
      this.backContainer.addChild(sq)
    })

    if (count > 50) {
      const more = new Text({
        text: `+${count - 50} more`,
        style: { fontFamily: 'monospace', fontSize: 9, fill: 0x445566 },
      })
      more.x = 0
      more.y = 18 + Math.ceil(50 / PER_ROW) * (SZ + GAP) + 4
      this.backContainer.addChild(more)
    }
  }

  private _playDeathAnim(taskId: string, sprite: MonsterSprite) {
    // Play hurt animation during death sequence
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
      x: (RIGHT_ZONE.x + 8) + sprite.container.x + size / 2,
      y: 20 + sprite.container.y + 16 + size / 2,
    }
  }

  /**
   * Plays a white flash + horizontal shake on the monster for the given taskId.
   * Calls onDone() when the animation finishes.
   */
  triggerHit(taskId: string, app: Application, role?: string, onDone?: () => void): void {
    const sprite = this.frontSprites.get(taskId)
    if (!sprite) { onDone?.(); return }

    // Play hurt sprite animation if available
    sprite.playHurt()

    const c = sprite.container
    // container children order: 0=label(Text), 1=body(Graphics|AnimatedSprite), 2=healthbar(Container)
    const body = c.getChildAt(1)
    const origTint = body.tint
    body.tint = 0xffffff

    // Spawn impact burst particles at monster center
    const center = this.getMonsterCenter(taskId)
    if (center) {
      const r = (role as ProjectileRole) || 'default'
      const color = ROLE_COLOR[r] ?? 0xaaaaaa
      burst(this.stage, center.x, center.y, color, 5, app)
    }

    const origX = c.x
    const startTime = Date.now()
    const FLASH_MS = 80
    const TOTAL_MS = 280   // FLASH_MS + 200ms shake

    const tick = () => {
      const elapsed = Date.now() - startTime

      // Restore tint at end of flash phase
      if (elapsed >= FLASH_MS && body.tint === 0xffffff) {
        body.tint = origTint
      }

      // Shake phase
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

  destroy() {
    for (const sprite of this.frontSprites.values()) sprite.destroy()
    this.frontSprites.clear()
    this.stage.removeChild(this.frontContainer)
    this.stage.removeChild(this.backContainer)
    this.frontContainer.destroy()
    this.backContainer.destroy()
  }
}
