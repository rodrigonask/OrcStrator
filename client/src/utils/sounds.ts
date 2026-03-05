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
    osc(ctx, 'sine', 523, 0.2, 784, 0.3, 0.35, 0.2)
    osc(ctx, 'sine', 784, 0.25, 1046, 0.2, 0.3, 0.15)
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
}
