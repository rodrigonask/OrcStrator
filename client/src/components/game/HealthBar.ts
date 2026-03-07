import { Container, Graphics, Ticker } from 'pixi.js'

const SQ   = 8   // square size px
const GAP  = 3   // gap between squares
const STEP = SQ + GAP  // 11px per slot
const MARGIN = 3  // px from right/bottom edge of body

function litCount(hp: number): number {
  return Math.ceil((Math.max(0, Math.min(100, hp)) / 100) * 5)
}

function squareColor(count: number): number {
  if (count >= 4) return 0x22cc44   // green
  if (count === 3) return 0xddaa22  // yellow
  if (count === 2) return 0xee6622  // orange
  return 0xcc0011                   // blood red
}

export class HealthBar {
  readonly container: Container
  private _bodyX: number
  private _bodyY: number
  private _bodySize: number
  private _hp = 100
  private _displayHp = 100
  private _ticker: Ticker
  private _gfx: Graphics
  private _animating = false

  /** bodyX/Y are the top-left of the sprite body within the monster container */
  constructor(bodyX: number, bodyY: number, bodySize: number, ticker: Ticker) {
    this._bodyX    = bodyX
    this._bodyY    = bodyY
    this._bodySize = bodySize
    this._ticker   = ticker

    this.container = new Container()
    this._gfx = new Graphics()
    this.container.addChild(this._gfx)
    this._drawSquares(100)
  }

  update(hp: number) {
    if (this._hp === hp) return
    this._hp = hp
    if (!this._animating) {
      this._animating = true
      this._ticker.add(this._tick)
    }
  }

  private _tick = () => {
    const diff = this._hp - this._displayHp
    if (Math.abs(diff) < 0.5) {
      this._displayHp = this._hp
      this._drawSquares(this._hp)
      this._animating = false
      this._ticker.remove(this._tick)
      return
    }
    this._displayHp += diff * 0.1
    this._drawSquares(this._displayHp)
  }

  private _drawSquares(hp: number) {
    const g = this._gfx
    g.clear()
    const n = litCount(hp)
    if (n === 0) return
    const color = squareColor(n)
    const xBase = this._bodyX + this._bodySize - SQ - MARGIN
    const yBase = this._bodyY + this._bodySize - MARGIN

    for (let i = 0; i < n; i++) {
      const y = yBase - (i + 1) * STEP + GAP
      g.roundRect(xBase, y, SQ, SQ, 1)
      g.fill({ color })
    }
  }

  destroy() {
    if (this._animating) this._ticker.remove(this._tick)
    this.container.destroy()
  }
}
