// Tiered sound wrapper over existing sounds.ts
// Each sound has a minimum tier; below that tier it's silenced

import { sounds } from '../utils/sounds'

type SoundFn = (...args: any[]) => void

interface TieredSound {
  minTier: number
  play: SoundFn
}

let audioCtx: AudioContext | null = null
function getCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  if (audioCtx.state === 'suspended') audioCtx.resume()
  return audioCtx
}

// Ambient drone state
let droneOscs: OscillatorNode[] = []
let droneGain: GainNode | null = null

const SOUNDS: Record<string, TieredSound> = {
  // Tier 1: UI feedback
  uiClick:  { minTier: 1, play: () => { const c = getCtx(); const o = c.createOscillator(); const g = c.createGain(); o.connect(g).connect(c.destination); o.type = 'sine'; o.frequency.value = 800; g.gain.setValueAtTime(0.05, c.currentTime); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.05); o.start(); o.stop(c.currentTime + 0.05) } },
  uiHover:  { minTier: 1, play: () => { const c = getCtx(); const o = c.createOscillator(); const g = c.createGain(); o.connect(g).connect(c.destination); o.type = 'sine'; o.frequency.value = 600; g.gain.setValueAtTime(0.03, c.currentTime); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.03); o.start(); o.stop(c.currentTime + 0.03) } },

  // Tier 2: Instance lifecycle
  spawn:    { minTier: 2, play: () => sounds.spawn() },
  activate: { minTier: 2, play: () => sounds.activate() },
  sleep:    { minTier: 2, play: () => sounds.sleep() },
  remove:   { minTier: 2, play: () => sounds.remove() },
  heal:     { minTier: 2, play: () => sounds.heal() },
  taskMove: { minTier: 2, play: () => { const c = getCtx(); const o = c.createOscillator(); const g = c.createGain(); o.connect(g).connect(c.destination); o.type = 'sine'; o.frequency.setValueAtTime(400, c.currentTime); o.frequency.linearRampToValueAtTime(600, c.currentTime + 0.15); g.gain.setValueAtTime(0.08, c.currentTime); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.2); o.start(); o.stop(c.currentTime + 0.2) } },
  taskComplete: { minTier: 2, play: () => sounds.taskComplete() },

  // Tier 3: Combat & celebrations
  attack:   { minTier: 3, play: (role: string) => sounds.attack(role) },
  levelUpFanfare: { minTier: 3, play: () => { const c = getCtx(); const notes = [523, 659, 784, 1046]; notes.forEach((f, i) => { const o = c.createOscillator(); const g = c.createGain(); o.connect(g).connect(c.destination); o.type = 'square'; o.frequency.value = f; const t = c.currentTime + i * 0.1; g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3); o.start(t); o.stop(t + 0.3) }) } },
  errorBuzz: { minTier: 3, play: () => sounds.errorBuzz() },

  // New action sounds
  taskCreated:     { minTier: 1, play: () => sounds.taskCreated() },
  messageSent:     { minTier: 1, play: () => sounds.messageSent() },
  commentPosted:   { minTier: 1, play: () => sounds.commentPosted() },
  xpGained:        { minTier: 2, play: () => sounds.xpGained() },
  messageReceived: { minTier: 2, play: () => sounds.messageReceived() },
  taskStuck:       { minTier: 2, play: () => sounds.taskStuck() },
}

let currentTier = 2

export const soundEngine = {
  setTier(tier: number): void {
    currentTier = tier
    // Stop ambient drone if tier drops below 4
    if (tier < 4) this.stopDrone()
  },

  play(name: string, ...args: any[]): void {
    const sound = SOUNDS[name]
    if (!sound || currentTier < sound.minTier) return
    try { sound.play(...args) } catch { /* audio unavailable */ }
  },

  startDrone(): void {
    if (droneOscs.length > 0) return
    try {
      const c = getCtx()
      droneGain = c.createGain()
      droneGain.gain.value = 0.05
      droneGain.connect(c.destination)

      // Multiple detuned sine oscillators for ambient pad
      const freqs = [55, 55.5, 82, 82.7, 110]
      for (const freq of freqs) {
        const o = c.createOscillator()
        o.type = 'sine'
        o.frequency.value = freq
        o.connect(droneGain)
        o.start()
        droneOscs.push(o)
      }
    } catch { /* audio unavailable */ }
  },

  stopDrone(): void {
    for (const o of droneOscs) {
      try { o.stop() } catch { /* already stopped */ }
    }
    droneOscs = []
    if (droneGain) {
      try { droneGain.disconnect() } catch { /* ignore */ }
      droneGain = null
    }
  },

  /** Play a preview sample for a given tier (bypasses tier gate) */
  playTierPreview(tier: number): void {
    if (tier <= 0) return
    const saved = currentTier
    currentTier = 4 // temporarily bypass gate
    try {
      if (tier === 1) this.play('uiClick')
      else if (tier === 2) { this.play('spawn'); setTimeout(() => this.play('taskComplete'), 300) }
      else if (tier === 3) this.play('levelUpFanfare')
      else if (tier >= 4) {
        this.play('levelUpFanfare')
        this.startDrone()
        setTimeout(() => { if (currentTier < 4) this.stopDrone() }, 2000)
      }
    } finally {
      currentTier = saved
    }
  },

  get tier(): number {
    return currentTier
  },
}
