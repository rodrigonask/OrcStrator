// Tier 4: Mouse trail particles — hue-cycling, short life

import type { ParticleSystem } from './particles'

export class CursorTrail {
  private active = false
  private mouseX = 0
  private mouseY = 0
  private hue = 0
  private elapsed = 0
  private handler: ((e: MouseEvent) => void) | null = null

  start(): void {
    if (this.active) return
    this.active = true
    this.handler = (e: MouseEvent) => {
      this.mouseX = e.clientX
      this.mouseY = e.clientY
    }
    window.addEventListener('mousemove', this.handler)
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    if (this.handler) {
      window.removeEventListener('mousemove', this.handler)
      this.handler = null
    }
  }

  update(dtSec: number, particles: ParticleSystem): void {
    if (!this.active) return
    this.elapsed += dtSec
    this.hue = (this.hue + dtSec * 180) % 360 // cycle hue
    // Emit ~60 particles/sec
    if (this.elapsed > 1 / 60) {
      this.elapsed = 0
      particles.trail(this.mouseX, this.mouseY, this.hue, 30, 150, 2)
    }
  }

  get isActive(): boolean {
    return this.active
  }
}
