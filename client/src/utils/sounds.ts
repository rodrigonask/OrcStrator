let audioCtx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  if (audioCtx.state === 'suspended') audioCtx.resume()
  return audioCtx
}

function osc(ctx: AudioContext, type: OscillatorType, freq: number, start: number, end: number, duration: number, gain = 0.25): void {
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.connect(g)
  g.connect(ctx.destination)
  o.type = type
  o.frequency.setValueAtTime(freq, ctx.currentTime)
  o.frequency.exponentialRampToValueAtTime(end, ctx.currentTime + duration * 0.8)
  g.gain.setValueAtTime(gain, ctx.currentTime)
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)
  o.start(ctx.currentTime + start)
  o.stop(ctx.currentTime + start + duration)
}

export const sounds = {
  spawn(): void {
    const ctx = getCtx()
    // Rising blue teleport: sawtooth sweep up + chime
    osc(ctx, 'sawtooth', 80, 0, 600, 0.4, 0.15)
    osc(ctx, 'sine', 600, 0.25, 1200, 0.25, 0.2)
    osc(ctx, 'sine', 1200, 0.4, 2000, 0.15, 0.12)
  },

  activate(): void {
    const ctx = getCtx()
    // Water fill: bubble + rising chime chord
    osc(ctx, 'sine', 200, 0, 300, 0.3, 0.12)
    osc(ctx, 'sine', 400, 0.1, 600, 0.25, 0.18)
    osc(ctx, 'sine', 523, 0.2, 784, 0.35, 0.2)
    osc(ctx, 'sine', 784, 0.25, 1046, 0.3, 0.15)
  },

  heal(): void {
    const ctx = getCtx()
    // WoW sparkle: high staccato chimes
    const notes = [1046, 1318, 1568, 2093]
    notes.forEach((f, i) => osc(ctx, 'sine', f, i * 0.06, f * 1.05, 0.18, 0.12))
  },

  sleep(): void {
    const ctx = getCtx()
    // Descending soft zzz hum
    osc(ctx, 'sine', 440, 0, 220, 0.5, 0.15)
    osc(ctx, 'sine', 330, 0.3, 165, 0.4, 0.1)
    osc(ctx, 'sine', 220, 0.6, 110, 0.35, 0.08)
  },

  remove(): void {
    const ctx = getCtx()
    // Impact thud + dark descend
    osc(ctx, 'sawtooth', 120, 0, 40, 0.25, 0.3)
    osc(ctx, 'square', 80, 0.05, 30, 0.3, 0.2)
    osc(ctx, 'sine', 300, 0.1, 50, 0.5, 0.15)
  },

  taskComplete(): void {
    const ctx = getCtx()
    // Triumphant 4-note fanfare: C5-E5-G5-C6
    const notes = [523, 659, 784, 1046]
    notes.forEach((f, i) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.connect(g)
      g.connect(ctx.destination)
      o.type = 'square'
      o.frequency.value = f
      const t = ctx.currentTime + i * 0.09
      g.gain.setValueAtTime(0.18, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
      o.start(t)
      o.stop(t + 0.4)
    })
  },

  errorBuzz(): void {
    const ctx = getCtx()
    // Low sawtooth + dissonant minor-second beating (80Hz + 85Hz)
    osc(ctx, 'sawtooth', 80, 0, 80, 0.3, 0.15)
    osc(ctx, 'sawtooth', 85, 0, 85, 0.3, 0.12)
  },

  taskCreated(): void {
    const ctx = getCtx()
    // Soft two-tone rising plonk
    osc(ctx, 'sine', 440, 0, 660, 0.15, 0.08)
  },

  xpGained(): void {
    const ctx = getCtx()
    // Quick sparkle: 4 ascending tones
    const notes = [880, 1100, 1320, 1760]
    notes.forEach((f, i) => osc(ctx, 'sine', f, i * 0.04, f * 1.02, 0.12, 0.07))
  },

  messageSent(): void {
    const ctx = getCtx()
    // Brief soft swoosh
    osc(ctx, 'sawtooth', 300, 0, 600, 0.12, 0.06)
  },

  messageReceived(): void {
    const ctx = getCtx()
    // Soft bell ping
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.connect(g)
    g.connect(ctx.destination)
    o.type = 'sine'
    o.frequency.value = 880
    g.gain.setValueAtTime(0.1, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
    o.start()
    o.stop(ctx.currentTime + 0.3)
  },

  commentPosted(): void {
    const ctx = getCtx()
    // Bubble pop
    osc(ctx, 'sine', 600, 0, 900, 0.08, 0.08)
  },

  taskStuck(): void {
    const ctx = getCtx()
    // Warning dissonance: triangle 220Hz + 233Hz minor 2nd beating
    osc(ctx, 'triangle', 220, 0, 220, 0.4, 0.12)
    osc(ctx, 'triangle', 233, 0, 233, 0.4, 0.1)
  },

  attack(role: string): void {
    const ctx = getCtx()
    switch (role) {
      case 'planner':
        // Magic whoosh: rising sine sweep + shimmer
        osc(ctx, 'sine', 300, 0, 1200, 0.25, 0.1)
        osc(ctx, 'sine', 800, 0.05, 1600, 0.2, 0.07)
        break
      case 'builder':
        // Arrow twang: sharp triangle snap + decay
        osc(ctx, 'triangle', 600, 0, 150, 0.12, 0.15)
        osc(ctx, 'sawtooth', 200, 0.02, 80, 0.1, 0.08)
        break
      case 'tester':
        // Sword clash: noise-like square burst + ring
        osc(ctx, 'square', 800, 0, 200, 0.08, 0.12)
        osc(ctx, 'sine', 1200, 0.02, 600, 0.15, 0.08)
        break
      case 'promoter':
        // Lute strum: warm sine chord pluck
        osc(ctx, 'sine', 330, 0, 320, 0.2, 0.1)
        osc(ctx, 'sine', 440, 0.02, 430, 0.18, 0.08)
        osc(ctx, 'sine', 550, 0.04, 540, 0.16, 0.06)
        break
      default:
        // Generic pew
        osc(ctx, 'sine', 500, 0, 300, 0.15, 0.1)
        break
    }
  },
}
