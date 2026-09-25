import { useUI } from '../context/UIContext'
import type { UsageBucket } from '@shared/types'

/**
 * Plan limits, rebuilt for a 32px column.
 *
 * The sidebar states each bucket as a label, a horizontal bar and a countdown on one
 * line. None of that survives a 22px-wide strip, so the bar becomes a ring: the arc is
 * the percentage used, the letter in the middle is which bucket, and the countdown keeps
 * its own line underneath at 7.5px.
 *
 * The countdown stays visible rather than moving to the tooltip because "78% used" and
 * "78% used, resets in 20 minutes" are different situations and only the second one
 * changes what you do next.
 */

/** Thresholds are about how much room you have left to change course. */
const WARN = 70
const CRIT = 85

/**
 * "3h 14m" -> "3h14", "2d 7h" -> "2d7h", "45m" -> "45m".
 *
 * 22px holds four characters of 7.5px mono, so the space always goes and the trailing
 * unit goes only when keeping it would cost a fifth. Dropping it unconditionally turned
 * the common weekly case into "2d7", which is a worse thing to read than one more
 * character is to fit. The full phrasing stays in the tooltip either way.
 */
function compactReset(reset: string): string {
  const tight = reset.replace(/\s+/g, '')
  if (tight.length <= 4) return tight
  const two = tight.match(/^(\d+[dhm])(\d+)[dhm]$/)
  return two ? `${two[1]}${two[2]}` : tight
}

function UsageRing({ bucket }: { bucket: UsageBucket }) {
  const pct = Math.max(0, Math.min(100, bucket.pct))
  const tone = pct >= CRIT ? ' is-crit' : pct >= WARN ? ' is-warn' : ''
  const reset = bucket.reset ? compactReset(bucket.reset) : ''
  return (
    <div
      className="usage-ring-row"
      title={`${bucket.label} ${Math.round(pct)}% used${bucket.reset ? ` · resets in ${bucket.reset}` : ''}`}
    >
      <div
        className={`usage-ring${tone}`}
        style={{ '--ring-pct': `${pct}%` } as React.CSSProperties}
        role="img"
        aria-label={`${bucket.label} ${Math.round(pct)} percent used`}
      >
        <b>{bucket.label.charAt(0).toUpperCase()}</b>
      </div>
      {reset && <span className="usage-ring-reset">{reset}</span>}
    </div>
  )
}

export function UsageRail() {
  const { usage, settings } = useUI()
  if (settings.showPlanLimits === false) return null
  if (!usage || !usage.connected || usage.buckets.length === 0) return null
  return (
    <div className="usage-rail">
      {usage.buckets.map(b => <UsageRing key={b.key} bucket={b} />)}
    </div>
  )
}
