// Global VFX overlay — canvas for particles + DOM layer for floating text
// Position: fixed, inset:0, pointer-events:none, z-index:9999
// Single RAF loop. Auto-pauses when no effects are active.

import { useEffect, useRef, useCallback } from 'react'
import { useUI } from '../context/UIContext'
import { resolveAnimTier, resolveSoundTier } from '../hooks/useVFX'
import { vfxBus, type VFXEvent } from '../systems/vfx-bus'
import { ParticleSystem, BURST_CONFIGS } from '../systems/particles'
import { FloatingNumbers } from '../systems/floating-numbers'
import { ScreenEffects } from '../systems/screen-effects'
import { CursorTrail } from '../systems/cursor-trail'
import { AmbientEmitter } from '../systems/ambient'
import { soundEngine } from '../systems/sound-engine'

export function VFXOverlay() {
  const { settings } = useUI()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const floatRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)
  const activeRef = useRef(false)

  // Systems
  const particlesRef = useRef<ParticleSystem | null>(null)
  const floatingRef = useRef<FloatingNumbers | null>(null)
  const screenFxRef = useRef<ScreenEffects | null>(null)
  const cursorTrailRef = useRef<CursorTrail | null>(null)
  const ambientRef = useRef<AmbientEmitter | null>(null)

  const animTier = resolveAnimTier(settings)
  const soundTier = resolveSoundTier(settings)

  // Initialize systems
  useEffect(() => {
    particlesRef.current = new ParticleSystem(animTier)
    floatingRef.current = new FloatingNumbers()
    screenFxRef.current = new ScreenEffects()
    cursorTrailRef.current = new CursorTrail()
    ambientRef.current = new AmbientEmitter()

    return () => {
      cursorTrailRef.current?.stop()
      ambientRef.current?.stop()
      soundEngine.stopDrone()
      cancelAnimationFrame(rafRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Mount float layer
  useEffect(() => {
    if (floatRef.current && floatingRef.current) {
      floatingRef.current.mount(floatRef.current)
    }
    return () => { floatingRef.current?.unmount() }
  }, [])

  // Mount screen effects on .app element
  useEffect(() => {
    const appEl = document.querySelector('.app') as HTMLElement | null
    if (appEl && screenFxRef.current) {
      screenFxRef.current.mount(appEl)
    }
    return () => { screenFxRef.current?.unmount() }
  }, [])

  // Update tier on systems
  useEffect(() => {
    particlesRef.current?.setTier(animTier)
    soundEngine.setTier(soundTier)

    // Tier 4: start ambient + cursor trail + drone
    if (animTier >= 4) {
      const w = window.innerWidth
      const h = window.innerHeight
      ambientRef.current?.start(w, h)
      cursorTrailRef.current?.start()
    } else {
      ambientRef.current?.stop()
      cursorTrailRef.current?.stop()
    }

    if (soundTier >= 4) {
      soundEngine.startDrone()
    } else {
      soundEngine.stopDrone()
    }
  }, [animTier, soundTier])

  // RAF loop
  const tick = useCallback((time: number) => {
    const dt = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 : 0.016
    lastTimeRef.current = time

    const canvas = canvasRef.current
    if (!canvas) { rafRef.current = requestAnimationFrame(tick); return }
    const ctx = canvas.getContext('2d')
    if (!ctx) { rafRef.current = requestAnimationFrame(tick); return }

    // Resize canvas to viewport
    const w = window.innerWidth
    const h = window.innerHeight
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      ctx.scale(dpr, dpr)
      ambientRef.current?.resize(w, h)
    }

    ctx.clearRect(0, 0, w, h)

    // Update all systems
    const particles = particlesRef.current!
    const screenFx = screenFxRef.current!

    // Ambient emitter (tier 4)
    ambientRef.current?.update(dt, particles)

    // Cursor trail (tier 4)
    cursorTrailRef.current?.update(dt, particles)

    // Particles
    particles.update(dt, ctx)

    // Screen effects
    const fxActive = screenFx.update(dt * 1000, ctx, w, h)

    // Auto-pause when nothing is active
    const hasActivity = particles.active > 0 || fxActive ||
      cursorTrailRef.current?.isActive || ambientRef.current?.isActive

    if (hasActivity) {
      rafRef.current = requestAnimationFrame(tick)
    } else {
      activeRef.current = false
    }
  }, [])

  const ensureRunning = useCallback(() => {
    if (!activeRef.current) {
      activeRef.current = true
      lastTimeRef.current = 0
      rafRef.current = requestAnimationFrame(tick)
    }
  }, [tick])

  // Subscribe to VFX events
  useEffect(() => {
    const unsub = vfxBus.on((event: VFXEvent) => {
      const tier = resolveAnimTier(settings)
      const sTier = resolveSoundTier(settings)
      const particles = particlesRef.current
      const floating = floatingRef.current
      const screenFx = screenFxRef.current

      if (!particles) return

      const cx = event.x ?? window.innerWidth / 2
      const cy = event.y ?? window.innerHeight / 2
      const intensify = tier >= 4

      switch (event.type) {
        case 'task:completed':
          if (tier >= 3) {
            particles.burst(cx, cy, BURST_CONFIGS.taskComplete, intensify)
            floating?.spawn({ text: event.text || '+XP', x: cx, y: cy - 20, color: '#ffd700', size: 18 })
            if (tier >= 4) screenFx?.shake(3, 200)
          }
          if (sTier >= 2) soundEngine.play('taskComplete')
          ensureRunning()
          break

        case 'task:moved':
          if (tier >= 3) {
            particles.burst(cx, cy, BURST_CONFIGS.taskMove, intensify)
          }
          if (sTier >= 2) soundEngine.play('taskMove')
          ensureRunning()
          break

        case 'task:created':
          if (tier >= 3) {
            particles.burst(cx, cy, BURST_CONFIGS.lootDrop, intensify)
          }
          if (sTier >= 1) soundEngine.play('taskCreated')
          ensureRunning()
          break

        case 'instance:spawn':
          if (sTier >= 2) soundEngine.play('spawn')
          if (tier >= 3) {
            particles.burst(cx, cy, BURST_CONFIGS.taskMove, intensify)
            if (tier >= 4) floating?.spawn({ text: event.text || 'SPAWN', x: cx, y: cy - 20, color: '#60a5fa', size: 14 })
          }
          ensureRunning()
          break

        case 'instance:activate':
          if (sTier >= 2) soundEngine.play('activate')
          break

        case 'instance:sleep':
          if (sTier >= 2) soundEngine.play('sleep')
          break

        case 'instance:remove':
          if (sTier >= 2) soundEngine.play('remove')
          break

        case 'xp:gained':
          if (tier >= 3) {
            floating?.spawn({ text: `+${event.amount || 0} XP`, x: cx, y: cy - 20, color: '#ffd700' })
          }
          if (sTier >= 2) soundEngine.play('xpGained')
          ensureRunning()
          break

        case 'level:up':
          if (tier >= 3) {
            particles.burst(cx, cy, BURST_CONFIGS.levelUp, intensify)
            floating?.spawn({ text: 'LEVEL UP!', x: cx, y: cy - 30, color: '#ffd700', size: 24, duration: 2000 })
            if (tier >= 4) {
              screenFx?.flash(canvasRef.current?.getContext('2d')!, window.innerWidth, window.innerHeight)
              screenFx?.shake(6, 400)
            }
          }
          if (sTier >= 3) soundEngine.play('levelUpFanfare')
          ensureRunning()
          break

        case 'error:occurred':
          if (tier >= 4) {
            screenFx?.chromatic(500)
            particles.burst(cx, cy, BURST_CONFIGS.error)
          }
          if (sTier >= 3) soundEngine.play('errorBuzz')
          ensureRunning()
          break

        case 'milestone:reached':
          if (tier >= 3) {
            particles.burst(cx, cy, BURST_CONFIGS.milestone, true)
            floating?.spawn({ text: event.text || 'MILESTONE!', x: cx, y: cy - 40, color: '#e879f9', size: 28, duration: 2500 })
          }
          if (tier >= 4) {
            screenFx?.shake(8, 500)
            screenFx?.slowmo(2000)
            screenFx?.flash(canvasRef.current?.getContext('2d')!, window.innerWidth, window.innerHeight)
          }
          if (sTier >= 3) soundEngine.play('levelUpFanfare')
          ensureRunning()
          break

        case 'message:sent':
          if (sTier >= 1) soundEngine.play('messageSent')
          break

        case 'message:received':
          if (sTier >= 2) soundEngine.play('messageReceived')
          break

        case 'comment:posted':
          if (sTier >= 1) soundEngine.play('commentPosted')
          break

        case 'task:stuck':
          if (sTier >= 2) soundEngine.play('taskStuck')
          break

        case 'tier:preview': {
          // Preview animation effects regardless of current tier gate
          const previewTier = event.tier ?? 0
          if (event.previewType === 'animation' && previewTier > 0) {
            const pcx = window.innerWidth - 140
            const pcy = window.innerHeight - 30
            if (previewTier >= 1) {
              // Gentle glow burst
              particles.burst(pcx, pcy, BURST_CONFIGS.taskMove, false)
            }
            if (previewTier >= 3) {
              particles.burst(pcx, pcy, BURST_CONFIGS.taskComplete, previewTier >= 4)
              floating?.spawn({ text: '+VFX', x: pcx, y: pcy - 20, color: '#a78bfa', size: 14 })
            }
            if (previewTier >= 4) {
              particles.burst(pcx, pcy, BURST_CONFIGS.milestone, true)
              screenFx?.shake(4, 300)
              screenFx?.chromatic(400)
            }
            ensureRunning()
          }
          break
        }
      }
    })

    return unsub
  }, [settings, ensureRunning]) // eslint-disable-line react-hooks/exhaustive-deps

  if (animTier === 0 && soundTier === 0) return null

  return (
    <>
      <canvas
        ref={canvasRef}
        className="vfx-canvas"
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 9999,
        }}
      />
      <div
        ref={floatRef}
        className="vfx-float-layer"
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 9999,
          overflow: 'hidden',
        }}
      />
    </>
  )
}
