// Pooled Canvas2D particle system using Float32Array
// Zero-GC: dead particles recycled via swap-with-last

// Per-particle layout in Float32Array:
// [x, y, vx, vy, life, maxLife, size, hue, sat, alpha, gravity]
const STRIDE = 11

const POOL_LIMITS: Record<number, number> = { 0: 0, 1: 0, 2: 30, 3: 150, 4: 500 }

export interface BurstConfig {
  count: number
  hueMin: number
  hueMax: number
  speedMin: number
  speedMax: number
  lifeMin: number
  lifeMax: number
  sizeMin: number
  sizeMax: number
  gravity?: number
  sat?: number
}

export const BURST_CONFIGS = {
  taskComplete: { count: 20, hueMin: 40, hueMax: 55, speedMin: 80, speedMax: 150, lifeMin: 400, lifeMax: 800, sizeMin: 2, sizeMax: 5, sat: 100 } satisfies BurstConfig,
  taskMove:     { count: 8,  hueMin: 200, hueMax: 230, speedMin: 40, speedMax: 80,  lifeMin: 300, lifeMax: 500, sizeMin: 2, sizeMax: 4, sat: 80 } satisfies BurstConfig,
  levelUp:      { count: 40, hueMin: 0, hueMax: 360, speedMin: 100, speedMax: 200, lifeMin: 600, lifeMax: 1200, sizeMin: 2, sizeMax: 6, sat: 100 } satisfies BurstConfig,
  lootDrop:     { count: 15, hueMin: 80, hueMax: 140, speedMin: 60, speedMax: 120, lifeMin: 500, lifeMax: 900, sizeMin: 2, sizeMax: 5, gravity: 120, sat: 90 } satisfies BurstConfig,
  error:        { count: 12, hueMin: 0, hueMax: 15, speedMin: 50, speedMax: 100, lifeMin: 300, lifeMax: 600, sizeMin: 2, sizeMax: 4, sat: 100 } satisfies BurstConfig,
  milestone:    { count: 60, hueMin: 0, hueMax: 360, speedMin: 120, speedMax: 250, lifeMin: 800, lifeMax: 1500, sizeMin: 3, sizeMax: 7, sat: 100 } satisfies BurstConfig,
} as const

export class ParticleSystem {
  private data: Float32Array
  private count = 0
  private maxPool: number

  constructor(tier: number) {
    this.maxPool = POOL_LIMITS[tier] ?? 0
    this.data = new Float32Array(this.maxPool * STRIDE)
  }

  setTier(tier: number): void {
    const newMax = POOL_LIMITS[tier] ?? 0
    if (newMax !== this.maxPool) {
      this.maxPool = newMax
      const newData = new Float32Array(newMax * STRIDE)
      const copyCount = Math.min(this.count, newMax)
      newData.set(this.data.subarray(0, copyCount * STRIDE))
      this.data = newData
      this.count = copyCount
    }
  }

  burst(x: number, y: number, config: BurstConfig, intensify = false): void {
    const n = intensify ? Math.ceil(config.count * 1.5) : config.count
    for (let i = 0; i < n; i++) {
      if (this.count >= this.maxPool) break
      const angle = Math.random() * Math.PI * 2
      const speed = config.speedMin + Math.random() * (config.speedMax - config.speedMin)
      const life = config.lifeMin + Math.random() * (config.lifeMax - config.lifeMin)
      const off = this.count * STRIDE
      this.data[off + 0] = x
      this.data[off + 1] = y
      this.data[off + 2] = Math.cos(angle) * speed
      this.data[off + 3] = Math.sin(angle) * speed
      this.data[off + 4] = 0        // life elapsed
      this.data[off + 5] = life      // maxLife
      this.data[off + 6] = config.sizeMin + Math.random() * (config.sizeMax - config.sizeMin)
      this.data[off + 7] = config.hueMin + Math.random() * (config.hueMax - config.hueMin)
      this.data[off + 8] = config.sat ?? 100
      this.data[off + 9] = 1         // alpha
      this.data[off + 10] = config.gravity ?? 0
      this.count++
    }
  }

  /** Emit a single particle at position (for trails/ambient) */
  trail(x: number, y: number, hue: number, speed = 30, life = 150, size = 2): void {
    if (this.count >= this.maxPool) return
    const angle = Math.random() * Math.PI * 2
    const off = this.count * STRIDE
    this.data[off + 0] = x
    this.data[off + 1] = y
    this.data[off + 2] = Math.cos(angle) * speed
    this.data[off + 3] = Math.sin(angle) * speed
    this.data[off + 4] = 0
    this.data[off + 5] = life
    this.data[off + 6] = size
    this.data[off + 7] = hue
    this.data[off + 8] = 100
    this.data[off + 9] = 1
    this.data[off + 10] = 0
    this.count++
  }

  update(dtSec: number, ctx: CanvasRenderingContext2D): void {
    const dtMs = dtSec * 1000
    let i = 0
    while (i < this.count) {
      const off = i * STRIDE
      this.data[off + 4] += dtMs // life elapsed
      const t = this.data[off + 4] / this.data[off + 5]

      if (t >= 1) {
        // Swap with last, zero-GC removal
        this.count--
        if (i < this.count) {
          const lastOff = this.count * STRIDE
          this.data.copyWithin(off, lastOff, lastOff + STRIDE)
        }
        continue
      }

      // Physics
      const gravity = this.data[off + 10]
      this.data[off + 3] += gravity * dtSec // vy += gravity
      this.data[off + 0] += this.data[off + 2] * dtSec
      this.data[off + 1] += this.data[off + 3] * dtSec

      // Draw
      const alpha = (1 - t) * this.data[off + 9]
      const size = this.data[off + 6] * (1 - t * 0.3)
      const hue = this.data[off + 7]
      const sat = this.data[off + 8]
      const light = 60 - t * 20

      ctx.beginPath()
      ctx.arc(this.data[off + 0], this.data[off + 1], size, 0, Math.PI * 2)
      ctx.fillStyle = `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`
      ctx.fill()

      i++
    }
  }

  get active(): number {
    return this.count
  }

  clear(): void {
    this.count = 0
  }
}
