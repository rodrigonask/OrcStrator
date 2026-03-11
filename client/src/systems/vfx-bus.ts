// Global VFX event bus — decouples triggers from visual effects
// Components emit events, VFXOverlay subscribes

export type VFXEventType =
  | 'task:moved'
  | 'task:completed'
  | 'task:created'
  | 'instance:spawn'
  | 'instance:activate'
  | 'instance:sleep'
  | 'instance:remove'
  | 'xp:gained'
  | 'level:up'
  | 'error:occurred'
  | 'milestone:reached'
  | 'tier:preview'
  | 'message:sent'
  | 'message:received'
  | 'task:stuck'
  | 'comment:posted'

export interface VFXEvent {
  type: VFXEventType
  x?: number
  y?: number
  amount?: number
  text?: string
  color?: string
  role?: string
  milestoneType?: string
  tier?: number
  previewType?: 'animation' | 'sound'
}

type VFXListener = (event: VFXEvent) => void

const listeners = new Set<VFXListener>()

export const vfxBus = {
  emit(event: VFXEvent): void {
    for (const listener of listeners) {
      try { listener(event) } catch { /* swallow */ }
    }
  },

  on(listener: VFXListener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },

  /** Convenience: emit with just type + optional position */
  fire(type: VFXEventType, opts?: Partial<Omit<VFXEvent, 'type'>>): void {
    this.emit({ type, ...opts })
  },
}
