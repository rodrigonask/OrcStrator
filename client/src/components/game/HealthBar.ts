import { Graphics } from 'pixi.js'

export class HealthBar {
  readonly container: Graphics
  private _width: number
  private _hp = 100

  constructor(x: number, y: number, width: number) {
    this.container = new Graphics()
    this.container.x = x
    this.container.y = y
    this._width = width
    this._draw(100)
  }

  update(hp: number) {
    if (this._hp === hp) return
    this._hp = hp
    this._draw(hp)
  }

  private _draw(hp: number) {
    const g = this.container
    g.clear()
    g.rect(0, 0, this._width, 4).fill({ color: 0x222222 })
    const color = hp > 66 ? 0x44cc66 : hp > 33 ? 0xddaa22 : 0xdd4422
    const fillW = Math.max(1, (hp / 100) * this._width)
    g.rect(0, 0, fillW, 4).fill({ color })
  }

  destroy() { this.container.destroy() }
}
