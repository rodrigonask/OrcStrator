import { Container, Graphics, Text, Ticker } from 'pixi.js'

export class HealthBar {
  readonly container: Container
  private _width: number
  private _hp = 100
  private _displayHp = 100
  private _ticker: Ticker
  private _bg: Graphics
  private _fill: Graphics
  private _text: Text
  private _animating = false

  constructor(x: number, y: number, width: number, ticker: Ticker) {
    this._width = width
    this._ticker = ticker

    this.container = new Container()
    this.container.x = x
    this.container.y = y

    // Dark background
    this._bg = new Graphics()
    this._bg.roundRect(0, 0, width, 8, 1).fill({ color: 0x1a1a1a })
    this._bg.roundRect(0, 0, width, 8, 1).stroke({ color: 0x111111, width: 1 })
    this.container.addChild(this._bg)

    // HP fill bar
    this._fill = new Graphics()
    this.container.addChild(this._fill)

    // HP text overlay
    this._text = new Text({
      text: '100/100',
      style: { fontFamily: 'monospace', fontSize: 7, fill: 0xffffff },
    })
    this._text.anchor.set(0.5, 0.5)
    this._text.x = width / 2
    this._text.y = 4
    this.container.addChild(this._text)

    this._drawFill(100)
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
      this._drawFill(this._hp)
      this._animating = false
      this._ticker.remove(this._tick)
      return
    }
    this._displayHp += diff * 0.1
    this._drawFill(this._displayHp)
  }

  private _drawFill(hp: number) {
    const g = this._fill
    g.clear()
    const color = hp > 66 ? 0x44cc66 : hp > 33 ? 0xddaa22 : 0xdd4422
    const fillW = Math.max(1, (hp / 100) * (this._width - 2))
    g.roundRect(1, 1, fillW, 6, 1).fill({ color })

    this._text.text = `${Math.round(hp)}/100`
  }

  destroy() {
    if (this._animating) {
      this._ticker.remove(this._tick)
    }
    this.container.destroy()
  }
}
