import { Graphics, Application, Container } from 'pixi.js'

/**
 * Lightweight particle utilities for attack effects.
 * Uses plain Graphics objects — no external particle libraries.
 */

/** Spawn a radial burst of particles (used on monster hit). */
export function burst(
  parent: Container,
  x: number,
  y: number,
  color: number,
  count: number,
  app: Application,
): void {
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4
    const speed = 40 + Math.random() * 30
    const g = new Graphics()
    g.circle(0, 0, 2 + Math.random() * 2)
    g.fill({ color, alpha: 0.9 })
    g.x = x
    g.y = y
    parent.addChild(g)

    const startTime = Date.now()
    const DURATION = 250 + Math.random() * 100

    const tick = () => {
      const elapsed = Date.now() - startTime
      const t = Math.min(elapsed / DURATION, 1)
      g.x = x + Math.cos(angle) * speed * t
      g.y = y + Math.sin(angle) * speed * t
      g.alpha = 0.9 * (1 - t)
      g.scale.set(1 - t * 0.6)

      if (t >= 1) {
        app.ticker.remove(tick)
        parent.removeChild(g)
        g.destroy()
      }
    }
    app.ticker.add(tick)
  }
}

/** Spawn a single fading trail dot (used behind projectiles). */
export function trail(
  parent: Container,
  x: number,
  y: number,
  color: number,
  app: Application,
): void {
  const g = new Graphics()
  g.circle(0, 0, 1.5 + Math.random() * 1.5)
  g.fill({ color, alpha: 0.6 })
  g.x = x + (Math.random() - 0.5) * 3
  g.y = y + (Math.random() - 0.5) * 3
  parent.addChild(g)

  const startTime = Date.now()
  const DURATION = 180

  const tick = () => {
    const elapsed = Date.now() - startTime
    const t = Math.min(elapsed / DURATION, 1)
    g.alpha = 0.6 * (1 - t)
    g.scale.set(1 - t * 0.7)

    if (t >= 1) {
      app.ticker.remove(tick)
      parent.removeChild(g)
      g.destroy()
    }
  }
  app.ticker.add(tick)
}
