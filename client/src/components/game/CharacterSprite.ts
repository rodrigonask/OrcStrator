import { AnimatedSprite, Container, Graphics, Text } from 'pixi.js'
import { SpriteManager } from './SpriteManager'
import { LEVELS } from '@shared/constants'
import type { InstanceConfig } from '@shared/types'

const ROLE_COLORS: Record<string, number> = {
  planner:  0x7c3aed, // purple – wizard
  builder:  0x2563eb, // blue – archer
  tester:   0xdc2626, // red – paladin
  promoter: 0xd97706, // amber – bard
}

/**
 * Creates a PixiJS Container representing one agent instance.
 * Uses AnimatedSprite from SpriteManager when available, falls back to colored Graphics.
 */
export function createCharSprite(
  parent: Container,
  instance: InstanceConfig,
  x: number,
  y: number,
  size: number,
  onClick: (instanceId: string) => void,
): void {
  const role = instance.agentRole ?? ''
  const roleColor = ROLE_COLORS[role] ?? 0x6b7280
  const isRunning = instance.state === 'running'
  const isPaused  = instance.state === 'paused'
  const bodyAlpha = isPaused ? 0.30 : 0.85

  const charContainer = new Container()
  charContainer.x = x
  charContainer.y = y

  // Try sprite-based rendering first
  const idleFrames = SpriteManager.isReady() ? SpriteManager.getIdleFrames(role) : []

  if (idleFrames.length > 0) {
    const sprite = new AnimatedSprite(idleFrames)
    sprite.animationSpeed = 0.12 // ~8fps at 60fps ticker
    sprite.play()
    sprite.width = size
    sprite.height = size
    sprite.alpha = bodyAlpha

    if (isRunning) {
      // Green border effect via a Graphics underlay
      const border = new Graphics()
      border.roundRect(-1, -1, size + 2, size + 2, 4)
      border.stroke({ color: 0x22c55e, width: 2 })
      charContainer.addChild(border)
    }

    sprite.eventMode = 'static'
    sprite.cursor = 'pointer'
    sprite.on('pointerdown', () => onClick(instance.id))
    charContainer.addChild(sprite)
  } else {
    // Fallback: colored square
    const body = new Graphics()
    body.roundRect(0, 0, size, size, 6)
    body.fill({ color: roleColor, alpha: bodyAlpha })

    if (isRunning) {
      body.stroke({ color: 0x22c55e, width: 2 })
    } else if (isPaused) {
      body.stroke({ color: 0x4a4a6a, width: 1 })
    } else {
      body.stroke({ color: 0xffffff, alpha: 0.15, width: 1 })
    }

    body.eventMode = 'static'
    body.cursor = 'pointer'
    body.on('pointerdown', () => onClick(instance.id))
    charContainer.addChild(body)

    // Role initial letter centered in the square (only for fallback)
    const roleInitial = (role || '?')[0].toUpperCase()
    const letter = new Text({
      text: roleInitial,
      style: {
        fontFamily: 'monospace',
        fontSize: Math.round(size * 0.35),
        fill: isPaused ? 0x555566 : 0xffffff,
        fontWeight: 'bold',
      },
    })
    letter.anchor.set(0.5, 0.5)
    letter.x = size / 2
    letter.y = size / 2
    charContainer.addChild(letter)
  }

  // Role initial badge (top-left, small) — for sprites only
  if (idleFrames.length > 0) {
    const badgeBg = new Graphics()
    badgeBg.roundRect(0, 0, 14, 14, 3)
    badgeBg.fill({ color: roleColor, alpha: 0.85 })
    charContainer.addChild(badgeBg)

    const badge = new Text({
      text: (role || '?')[0].toUpperCase(),
      style: { fontFamily: 'monospace', fontSize: 9, fill: 0xffffff, fontWeight: 'bold' },
    })
    badge.anchor.set(0.5, 0.5)
    badge.x = 7
    badge.y = 7
    charContainer.addChild(badge)
  }

  // Running state: green activity dot top-right
  if (isRunning) {
    const dot = new Graphics()
    dot.circle(size - 5, 5, 4)
    dot.fill({ color: 0x22c55e })
    charContainer.addChild(dot)
  }

  // Name label below sprite
  const label = new Text({
    text: instance.name.slice(0, 8),
    style: { fontFamily: 'monospace', fontSize: 8, fill: 0x8899aa },
  })
  label.x = 0
  label.y = size + 2
  charContainer.addChild(label)

  // Level label below name (only for level > 1)
  const instLevel = instance.level ?? 1
  if (instLevel > 1) {
    const TIER_COLORS_HEX: Record<string, number> = {
      Beginner: 0x10b981, Intermediate: 0x3b82f6, Advanced: 0x8b5cf6,
      Elite: 0xf59e0b, Mythic: 0xef4444, Cosmic: 0xec4899,
    }
    const instTier = [...LEVELS].reverse().find(l => (instance.xpTotal ?? 0) >= l.xpRequired)
    const lvlColor = TIER_COLORS_HEX[instTier?.tier ?? 'Beginner'] ?? 0x10b981

    const levelLabel = new Text({
      text: `Lv.${instLevel}`,
      style: { fontFamily: 'monospace', fontSize: 7, fill: lvlColor },
    })
    levelLabel.x = 0
    levelLabel.y = size + 12
    charContainer.addChild(levelLabel)
  }

  parent.addChild(charContainer)
}
