export const GAME_W = 1400
export const GAME_H = 700

export type GameDisplayMode = 'code' | 'name' | 'both' | 'bars' | 'immersive'

const ZONE_W = GAME_W / 4  // 350px each, equal size

/** Idle agents (not working on tasks) */
export const IDLE_ZONE    = { x: 0,          w: ZONE_W }
/** Active agents (currently tackling tasks) */
export const ACTIVE_ZONE  = { x: ZONE_W,     w: ZONE_W }
/** Tasks being worked on (mirrors active agents) */
export const BATTLE_ZONE  = { x: ZONE_W * 2, w: ZONE_W }
/** Task queue (all pipeline tasks not locked and not done/backlog) */
export const QUEUE_ZONE   = { x: ZONE_W * 3, w: ZONE_W }
