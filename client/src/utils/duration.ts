/** Human turn durations, one implementation.
 *
 *  There were three copies of this shape before: the live composer timer (fmtElapsed in
 *  MessageInput.tsx) plus one each in MessageBubble and UsageReportPage. They had already
 *  drifted on rounding, so a turn could tick "59s" in the composer and settle to "1m 0s"
 *  in the footnote a moment later.
 *
 *  Two rules that keep it readable:
 *    - FLOOR, not round, so the settled number never exceeds the last number the user
 *      watched tick past on the live counter.
 *    - Drop a trailing zero unit. "1h" and "4h", never "1h 0m"; "2m", never "2m 0s".
 *      Nobody says "one hour zero minutes".
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`

  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60
    return seconds ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`
  }

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}
