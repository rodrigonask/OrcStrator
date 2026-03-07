import { Assets, Spritesheet, Texture, type UnresolvedAsset } from 'pixi.js'

/**
 * Singleton sprite-sheet loader.
 * Registers JSON atlas files, loads them via PixiJS Assets, and
 * exposes frame textures for animations.
 */

interface SheetEntry {
  alias: string
  src: string
}

const SHEETS: SheetEntry[] = [
  { alias: 'dragon', src: '/spritesheets/dragon.json' },
  { alias: 'orc', src: '/spritesheets/orc.json' },
  { alias: 'goblin', src: '/spritesheets/goblin.json' },
  { alias: 'slime', src: '/spritesheets/slime.json' },
  { alias: 'mage', src: '/spritesheets/mage.json' },
  { alias: 'warrior', src: '/spritesheets/warrior.json' },
  { alias: 'archer', src: '/spritesheets/archer.json' },
  { alias: 'paladin', src: '/spritesheets/paladin.json' },
  { alias: 'mage-projectile', src: '/spritesheets/mage-projectile.json' },
  { alias: 'warrior-projectile', src: '/spritesheets/warrior-projectile.json' },
  { alias: 'archer-projectile', src: '/spritesheets/archer-projectile.json' },
  { alias: 'paladin-projectile', src: '/spritesheets/paladin-projectile.json' },
]

const PRIORITY_SHEET: Record<number, string> = {
  1: 'dragon',
  2: 'orc',
  3: 'goblin',
  4: 'slime',
}

const ROLE_SHEET: Record<string, string> = {
  planner: 'mage',
  builder: 'warrior',
  tester: 'archer',
  promoter: 'paladin',
}

const ROLE_PROJECTILE_SHEET: Record<string, string> = {
  planner: 'mage-projectile',
  builder: 'warrior-projectile',
  tester: 'archer-projectile',
  promoter: 'paladin-projectile',
}

const PLAIN_TEXTURES: SheetEntry[] = [
  { alias: 'battlefield', src: '/backgrounds/battlefield.png' },
]

let loaded = false
let loading: Promise<void> | null = null
const cache = new Map<string, Spritesheet>()
const textureCache = new Map<string, Texture>()

export const SpriteManager = {
  /** Load all registered sprite sheets. Subsequent calls are no-ops. */
  async load(): Promise<void> {
    if (loaded) return
    if (loading) return loading

    loading = (async () => {
      for (const { alias, src } of [...SHEETS, ...PLAIN_TEXTURES]) {
        if (!Assets.resolver.hasKey(alias)) {
          Assets.add({ alias, src } as UnresolvedAsset)
        }
      }
      // Load plain textures (backgrounds etc.)
      for (const { alias } of PLAIN_TEXTURES) {
        try {
          const tex = await Assets.load<Texture>(alias)
          textureCache.set(alias, tex)
        } catch {
          console.warn(`[SpriteManager] Failed to load texture: ${alias}`)
        }
      }
      const results = await Assets.load<Spritesheet>(SHEETS.map(s => s.alias))
      if (results && typeof results === 'object' && !Array.isArray(results)) {
        // Assets.load with multiple aliases returns Record<alias, Spritesheet>
        for (const { alias } of SHEETS) {
          const sheet = (results as Record<string, Spritesheet>)[alias]
          if (sheet) cache.set(alias, sheet)
        }
      }
      loaded = true
    })()

    return loading
  },

  /** Get frame textures for a named animation within a sheet. */
  getTextures(sheetAlias: string, animName: string): Texture[] {
    const sheet = cache.get(sheetAlias)
    if (!sheet) return []
    const anim = sheet.animations?.[animName]
    return anim ?? []
  },

  /** Get idle or hurt textures for a monster by priority. */
  getMonsterFrames(priority: number, anim: 'idle' | 'hurt'): Texture[] {
    const sheetName = PRIORITY_SHEET[priority] ?? PRIORITY_SHEET[3]
    const sheet = cache.get(sheetName)
    if (!sheet) return []
    const animKey = `${sheetName}-${anim}`
    return sheet.animations?.[animKey] ?? []
  },

  /** Get idle animation frames for a character role (planner/builder/tester/promoter). */
  getIdleFrames(role: string): Texture[] {
    const sheetName = ROLE_SHEET[role]
    if (!sheetName) return []
    const sheet = cache.get(sheetName)
    if (!sheet) return []
    return sheet.animations?.[`${sheetName}-idle`] ?? []
  },

  /** Get projectile animation frames for a character role. */
  getProjectileFrames(role: string): Texture[] {
    const sheetName = ROLE_PROJECTILE_SHEET[role]
    if (!sheetName) return []
    const sheet = cache.get(sheetName)
    if (!sheet) return []
    return sheet.animations?.[sheetName] ?? []
  },

  /** Get a single loaded texture by alias (e.g. 'battlefield'). */
  getTexture(alias: string): Texture | null {
    return textureCache.get(alias) ?? null
  },

  /** Whether all registered sheets have been loaded. */
  isReady(): boolean {
    return loaded
  },
}
