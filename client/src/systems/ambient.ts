// Tier 4: Persistent ambient particles — fire embers, floating orbs, energy sparkles

import type { ParticleSystem } from './particles'

export class AmbientEmitter {
  private active = false
  private elapsed = 0
  private w = 0
  private h = 0

  start(w: number, h: number): void {
    this.active = true
    this.w = w
    this.h = h
  }

  stop(): void {
    this.active = false
  }

  resize(w: number, h: number): void {
    this.w = w
    this.h = h
  }

  update(dtSec: number, particles: ParticleSystem): void {
    if (!this.active || this.w === 0) return
    this.elapsed += dtSec
    // Emit ~15 particles/sec for 50-80 active at any time
    const rate = 1 / 15
    while (this.elapsed >= rate) {
      this.elapsed -= rate
      const x = Math.random() * this.w
      const y = this.h + 5 // spawn at bottom
      const kind = Math.random()
      if (kind < 0.4) {
        // Fire ember — orange/red, rises
        particles.trail(x, y, 15 + Math.random() * 25, 20 + Math.random() * 40, 2000 + Math.random() * 2000, 1.5 + Math.random() * 2)
      } else if (kind < 0.7) {
        // Floating orb — blue/purple, slow drift
        particles.trail(
          Math.random() * this.w,
          Math.random() * this.h,
          220 + Math.random() * 60,
          5 + Math.random() * 15,
          3000 + Math.random() * 2000,
          2 + Math.random() * 3
        )
      } else {
        // Energy sparkle — white/gold, fast
        particles.trail(
          Math.random() * this.w,
          Math.random() * this.h,
          45 + Math.random() * 15,
          40 + Math.random() * 60,
          500 + Math.random() * 800,
          1 + Math.random() * 1.5
        )
      }
    }
  }

  get isActive(): boolean {
    return this.active
  }
}
