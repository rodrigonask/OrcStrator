import { Container, Graphics, Text } from 'pixi.js'
import type { InstanceConfig } from '@shared/types'

const ROLE_COLORS: Record<string, number> = {
  planner:  0x7c3aed, // purple – wizard
  builder:  0x2563eb, // blue – archer
  tester:   0xdc2626, // red – paladin
  promoter: 0xd97706, // amber – bard
}

/**
 * Creates a PixiJS Container representing one agent instance.
 * Uses colored Graphics placeholders (real LPC sprites can replace these later).
 */
export function createCharSprite(
  parent: Container,
  instance: InstanceConfig,
  x: number,
  y: number,
  size: number,
  onClick: (instanceId: string) => void,
): void {
  const roleColor = ROLE_COLORS[instance.agentRole ?? ''] ?? 0x6b7280
  const isRunning = instance.state === 'running'
  const isPaused  = instance.state === 'paused'
  const bodyAlpha = isPaused ? 0.30 : 0.85

  const charContainer = new Container()
  charContainer.x = x
  charContainer.y = y

  // Main body square
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

  // Running state: green activity dot top-right
  if (isRunning) {
    const dot = new Graphics()
    dot.circle(size - 5, 5, 4)
    dot.fill({ color: 0x22c55e })
    charContainer.addChild(dot)
  }

  // Role initial letter centered in the square
  const roleInitial = (instance.agentRole ?? '?')[0].toUpperCase()
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

  // Name label below sprite
  const label = new Text({
    text: instance.name.slice(0, 8),
    style: { fontFamily: 'monospace', fontSize: 8, fill: 0x8899aa },
  })
  label.x = 0
  label.y = size + 2

  // Click area — covers the whole char square
  body.eventMode = 'static'
  body.cursor = 'pointer'
  body.on('pointerdown', () => onClick(instance.id))

  charContainer.addChild(body)
  charContainer.addChild(letter)
  charContainer.addChild(label)
  parent.addChild(charContainer)
}
