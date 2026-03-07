import { Container, Text } from 'pixi.js'
import type { InstanceConfig } from '@shared/types'
import { IDLE_ZONE, ACTIVE_ZONE, GAME_H } from './constants'
import { createCharSprite } from './CharacterSprite'

const PADDING = 10
const HEADER_H = 10
const COLS = 2

export const IDLE_CHAR_SIZE   = 96
export const ACTIVE_CHAR_SIZE = 112
export const IDLE_ROW_H       = 120
export const ACTIVE_ROW_H     = 120

function clearContainer(container: Container) {
  while (container.children.length > 0) {
    const child = container.removeChildAt(0)
    child.destroy({ children: true })
  }
}

function gridLayout(
  zone: { x: number; w: number },
  charSize: number,
  rowH: number,
  idx: number,
): { x: number; y: number } {
  const colW = (zone.w - PADDING * 2) / COLS
  const col = idx % COLS
  const row = Math.floor(idx / COLS)
  return {
    x: zone.x + PADDING + col * colW + (colW - charSize) / 2,
    y: HEADER_H + PADDING + row * rowH,
  }
}

/**
 * Build the idle agents panel.
 * Shows agents not currently locked to any task in a 3-column grid.
 */
export function buildIdlePanel(
  container: Container,
  instances: InstanceConfig[],
  onClick: (instanceId: string) => void,
): void {
  clearContainer(container)

  const maxRows = Math.floor((GAME_H - HEADER_H - PADDING) / IDLE_ROW_H)
  const maxVisible = maxRows * COLS
  const visible = instances.slice(0, maxVisible)

  visible.forEach((instance, idx) => {
    const { x, y } = gridLayout(IDLE_ZONE, IDLE_CHAR_SIZE, IDLE_ROW_H, idx)
    createCharSprite(container, instance, x, y, IDLE_CHAR_SIZE, onClick)
  })

  if (instances.length > maxVisible) {
    const more = new Text({
      text: `+${instances.length - maxVisible} more`,
      style: { fontFamily: 'monospace', fontSize: 9, fill: 0x6688aa },
    })
    more.x = IDLE_ZONE.x + PADDING
    more.y = GAME_H - 20
    container.addChild(more)
  }
}

/**
 * Build the active agents panel.
 * Shows agents currently locked to a task in a 3-column grid.
 */
export function buildActivePanel(
  container: Container,
  instances: InstanceConfig[],
  onClick: (instanceId: string) => void,
): void {
  clearContainer(container)

  const maxRows = Math.floor((GAME_H - HEADER_H - PADDING) / ACTIVE_ROW_H)
  const maxVisible = maxRows * COLS
  const visible = instances.slice(0, maxVisible)

  visible.forEach((instance, idx) => {
    const { x, y } = gridLayout(ACTIVE_ZONE, ACTIVE_CHAR_SIZE, ACTIVE_ROW_H, idx)
    createCharSprite(container, instance, x, y, ACTIVE_CHAR_SIZE, onClick)
  })
}
