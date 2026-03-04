/**
 * Generate a unique ID using crypto.randomUUID.
 */
export function generateId(): string {
  return crypto.randomUUID()
}

/**
 * Format a token count with K/M suffix.
 * e.g., 1500 -> "1.5K", 2300000 -> "2.3M"
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const val = n / 1_000_000
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}M`
  }
  if (n >= 1_000) {
    const val = n / 1_000
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}K`
  }
  return String(n)
}

/**
 * Format a USD cost as $X.XX (or $0.00XX for very small amounts).
 */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/**
 * Return a relative time string (e.g., "2m ago", "3h ago", "1d ago").
 */
export function timeAgo(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp

  const seconds = Math.floor(diff / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`

  const years = Math.floor(months / 12)
  return `${years}y ago`
}

/**
 * Truncate a string to max length, adding ellipsis if truncated.
 */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max - 1) + '\u2026'
}

/**
 * Join CSS class names, filtering out falsy values.
 * Supports strings, undefined, null, false, and conditionals.
 */
export function classNames(...args: Array<string | undefined | null | false | 0>): string {
  return args.filter(Boolean).join(' ')
}
