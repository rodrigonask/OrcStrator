// Screen-wide VFX: shake, flash, chromatic aberration, slowmo
// Uses CSS custom properties (--shake-x, --shake-y) to avoid overwriting
// the inline transform (which may contain zoom scale).

export class ScreenEffects {
  private appEl: HTMLElement | null = null
  private shakeTimer = 0
  private shakeMag = 0
  private flashAlpha = 0
  private chromaticTimer = 0
  private slowmoTimer = 0

  mount(appEl: HTMLElement): void {
    this.appEl = appEl
  }

  unmount(): void {
    if (this.appEl) {
      this.appEl.style.translate = ''
      this.appEl.style.filter = ''
    }
    this.appEl = null
  }

  shake(magnitude = 4, durationMs = 300): void {
    this.shakeMag = magnitude
    this.shakeTimer = durationMs
  }

  flash(canvas: CanvasRenderingContext2D, w: number, h: number): void {
    this.flashAlpha = 0.3
    // Draw white flash on canvas
    canvas.fillStyle = `rgba(255,255,255,${this.flashAlpha})`
    canvas.fillRect(0, 0, w, h)
  }

  chromatic(durationMs = 500): void {
    this.chromaticTimer = durationMs
  }

  slowmo(durationMs = 2000): void {
    this.slowmoTimer = durationMs
    document.documentElement.style.setProperty('--app-time-scale', '0.3')
  }

  update(dtMs: number, ctx?: CanvasRenderingContext2D, w?: number, h?: number): boolean {
    let active = false

    // Shake — uses CSS `translate` property (independent of `transform`)
    if (this.shakeTimer > 0 && this.appEl) {
      this.shakeTimer -= dtMs
      const t = Math.max(0, this.shakeTimer / 300)
      const dx = (Math.random() - 0.5) * 2 * this.shakeMag * t
      const dy = (Math.random() - 0.5) * 2 * this.shakeMag * t
      this.appEl.style.translate = `${dx}px ${dy}px`
      active = true
      if (this.shakeTimer <= 0) {
        this.appEl.style.translate = ''
      }
    }

    // Flash fade
    if (this.flashAlpha > 0 && ctx && w && h) {
      this.flashAlpha -= dtMs / 300
      if (this.flashAlpha > 0) {
        ctx.fillStyle = `rgba(255,255,255,${this.flashAlpha})`
        ctx.fillRect(0, 0, w, h)
        active = true
      }
    }

    // Chromatic aberration
    if (this.chromaticTimer > 0 && this.appEl) {
      this.chromaticTimer -= dtMs
      const t = Math.max(0, this.chromaticTimer / 500)
      const offset = 2 * t
      // Use CSS drop-shadow to simulate chromatic aberration
      this.appEl.style.filter = `
        drop-shadow(${offset}px 0 0 rgba(255,0,0,${t * 0.3}))
        drop-shadow(${-offset}px 0 0 rgba(0,0,255,${t * 0.3}))
      `.trim()
      active = true
      if (this.chromaticTimer <= 0) {
        this.appEl.style.filter = ''
      }
    }

    // Slowmo
    if (this.slowmoTimer > 0) {
      this.slowmoTimer -= dtMs
      if (this.slowmoTimer <= 0) {
        document.documentElement.style.removeProperty('--app-time-scale')
      }
      active = true
    }

    return active
  }
}
