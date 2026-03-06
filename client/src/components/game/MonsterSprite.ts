import { Container, Graphics, Text } from 'pixi.js'
import { HealthBar } from './HealthBar'
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

  constructor(task: PipelineTask, x: number, y: number, hp: number) {
    this._taskId = task.id
    this.priority = task.priority
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

    // Body graphic
    const body = new Graphics()
    this._drawMonster(body, task.priority, size, color)
    body.x = 0
    body.y = 16
    this.container.addChild(body)

    // Health bar below monster
    const barW = Math.max(size, 32)
    this._hp = new HealthBar(0, 16 + size + 4, barW)
    this._hp.update(hp)
    this.container.addChild(this._hp.container)
  }

  get taskId() { return this._taskId }

  updateHp(hp: number) { this._hp.update(hp) }

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
    this._hp.destroy()
    this.container.destroy()
  }
}
