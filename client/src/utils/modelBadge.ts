/**
 * Compact model/effort badge formatting for dense grid tiles.
 *   claude-opus-4-8            → O4.8
 *   claude-sonnet-4-6          → S4.6
 *   claude-haiku-4-5-20251001  → H4.5
 *   claude-fable-5-1           → F5.1
 * Effort: max→max, xhigh→xhi, high→hi, medium→med, low→lo
 * Combined: `O4.8·max`
 */

const EFFORT_ABBREV: Record<string, string> = {
  max: 'max',
  xhigh: 'xhi',
  high: 'hi',
  medium: 'med',
  low: 'lo',
}

export function abbrevModel(modelId: string): string {
  const parts = modelId.split('-')
  // Drop the leading "claude"
  const rest = parts[0] === 'claude' ? parts.slice(1) : parts
  const family = rest[0] ?? modelId
  // Version components are small numbers; date suffixes (20251001) are not
  const nums = rest.slice(1).filter(p => /^\d{1,2}$/.test(p))
  const version = nums.join('.')
  const letter = family.charAt(0).toUpperCase()
  return version ? `${letter}${version}` : letter
}

export function abbrevEffort(effort: string): string {
  return EFFORT_ABBREV[effort] ?? effort.slice(0, 3)
}

export function formatModelBadge(modelId: string, effort: string): string {
  return `${abbrevModel(modelId)}·${abbrevEffort(effort)}`
}

/** Permission-mode dot color for the compact badge (title carries the label) */
export function permModeColor(mode: string): string {
  switch (mode) {
    case 'bypassPermissions': return '#ef4444'
    case 'plan': return '#3b82f6'
    case 'acceptEdits': return '#22c55e'
    case 'auto': return '#a855f7'
    case 'dontAsk': return '#f97316'
    default: return '#9ca3af'
  }
}
