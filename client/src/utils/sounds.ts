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
  activate(): void {
    const ctx = getCtx()
    // Water fill: bubble + rising chime chord
    osc(ctx, 'sine', 200, 0, 300, 0.3, 0.12)
    osc(ctx, 'sine', 400, 0.1, 600, 0.25, 0.18)
    osc(ctx, 'sine', 523, 0.2, 784, 0.35, 0.2)
    osc(ctx, 'sine', 784, 0.25, 1046, 0.3, 0.15)
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
}
