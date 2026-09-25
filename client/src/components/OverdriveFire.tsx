import { useEffect, useRef } from 'react'
import { useUI } from '../context/UIContext'
import { resolveAnimTier } from '../hooks/useVFX'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  hue: number
}

interface OverdriveFireProps {
  intensity: number // 0 = off, 0.1–1.0 = fire intensity (maps from 5x–10x)
  width: number
  height: number
}

export function OverdriveFire({ intensity, width, height }: OverdriveFireProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const particlesRef = useRef<Particle[]>([])
  const rafRef = useRef<number>(0)
  const { settings } = useUI()
  const animTier = resolveAnimTier(settings)
  const MAX_PARTICLES = animTier >= 4 ? 120 : 60

  useEffect(() => {
    if (animTier < 2) return // Gate: need Heroic+ tier
    const canvas = canvasRef.current
    if (!canvas || intensity <= 0) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    ctx.scale(dpr, dpr)

    const particles = particlesRef.current

    function spawnParticle() {
      if (particles.length >= MAX_PARTICLES * intensity) return
      const baseX = width * 0.1 + Math.random() * width * 0.8
      particles.push({
        x: baseX,
        y: height - 2,
        vx: (Math.random() - 0.5) * 1.5,
        vy: -(1.5 + Math.random() * 3) * intensity,
        life: 0,
        maxLife: 30 + Math.random() * 40,
        size: 2 + Math.random() * 4 * intensity,
        hue: 15 + Math.random() * 30, // orange-red range
      })
    }

    function tick() {
      ctx!.clearRect(0, 0, width, height)

      // Spawn new particles
      const spawnRate = Math.ceil(3 * intensity)
      for (let i = 0; i < spawnRate; i++) spawnParticle()

      // Update + draw
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        p.life++
        const t = p.life / p.maxLife

        if (t >= 1) {
          particles.splice(i, 1)
          continue
        }

        // Movement with turbulence
        p.x += p.vx + Math.sin(p.life * 0.15) * 0.8
        p.y += p.vy
        p.vy *= 0.98

        // Color: bright yellow → orange → red → transparent
        const alpha = (1 - t) * (0.6 + 0.4 * intensity)
        const sat = 100
        const light = 60 - t * 30

        ctx!.beginPath()
        ctx!.arc(p.x, p.y, p.size * (1 - t * 0.5), 0, Math.PI * 2)
        ctx!.fillStyle = `hsla(${p.hue - t * 15}, ${sat}%, ${light}%, ${alpha})`
        ctx!.fill()

        // Inner glow
        if (t < 0.3) {
          ctx!.beginPath()
          ctx!.arc(p.x, p.y, p.size * 0.4, 0, Math.PI * 2)
          ctx!.fillStyle = `hsla(50, 100%, 85%, ${(0.3 - t) * 2 * intensity})`
          ctx!.fill()
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafRef.current)
      particles.length = 0
    }
  }, [intensity, width, height, animTier, MAX_PARTICLES])

  if (intensity <= 0 || animTier < 2) return null

  return (
    <canvas
      ref={canvasRef}
      className="overdrive-fire-canvas"
      style={{ width, height }}
    />
  )
}
