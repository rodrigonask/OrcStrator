import { Container, Graphics, Text } from 'pixi.js'
import type { InstanceConfig, FolderConfig } from '@shared/types'
import { LEFT_ZONE, GAME_H } from './constants'
import { createCharSprite } from './CharacterSprite'

const SILO_PADDING  = 8
const CHAR_SIZE     = 48
const CHAR_GAP      = 6
const SILO_HEADER_H = 20
const SILO_GAP      = 16
const MAX_SPRITES   = 6

/**
 * Clears and rebuilds the LEFT_ZONE silo boxes inside the given container.
 * Safe to call repeatedly; tears down children on each call.
 */
export function buildAgentPanel(
  container: Container,
  instances: InstanceConfig[],
  folders: FolderConfig[],
  onClick: (instanceId: string) => void,
): void {
  // Destroy existing children cleanly
  while (container.children.length > 0) {
    const child = container.removeChildAt(0)
    child.destroy({ children: true })
  }

  let currentY = 20

  for (const folder of folders) {
    const folderInstances = instances.filter(i => i.folderId === folder.id)
    if (folderInstances.length === 0) continue

    const visible  = folderInstances.slice(0, MAX_SPRITES)
    const overflow = folderInstances.length - MAX_SPRITES

    const siloW = LEFT_ZONE.w - SILO_PADDING * 2
    const siloH = SILO_HEADER_H + CHAR_SIZE + SILO_PADDING * 2

    // Silo background
    const bg = new Graphics()
    bg.roundRect(LEFT_ZONE.x + SILO_PADDING, currentY, siloW, siloH, 4)
    bg.fill({ color: 0x16162a, alpha: 0.6 })
    container.addChild(bg)

    // Folder name header
    const folderName = (folder.displayName ?? folder.name).slice(0, 22)
    const header = new Text({
      text: folderName,
      style: { fontFamily: 'monospace', fontSize: 11, fill: 0x7c9fcc },
    })
    header.x = LEFT_ZONE.x + SILO_PADDING + 4
    header.y = currentY + 4
    container.addChild(header)

    // Character sprites
    const spritesStartY = currentY + SILO_HEADER_H + SILO_PADDING
    visible.forEach((instance, idx) => {
      const spriteX = LEFT_ZONE.x + SILO_PADDING + idx * (CHAR_SIZE + CHAR_GAP) + 4
      createCharSprite(container, instance, spriteX, spritesStartY, CHAR_SIZE, onClick)
    })

    // "+N more" overflow label
    if (overflow > 0) {
      const moreX = LEFT_ZONE.x + SILO_PADDING + MAX_SPRITES * (CHAR_SIZE + CHAR_GAP) + 4
      const more = new Text({
        text: `+${overflow}`,
        style: { fontFamily: 'monospace', fontSize: 10, fill: 0x7c9fcc },
      })
      more.x = moreX
      more.y = spritesStartY + CHAR_SIZE / 2 - 6
      container.addChild(more)
    }

    currentY += siloH + SILO_GAP
    if (currentY > GAME_H - 60) break
  }
}
