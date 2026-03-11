import { OD_TIERS, ORC_LOG_LABELS } from '@shared/constants'
import type { OrcLogEntry } from '@shared/types'

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function fmtUsd(n: number): string {
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  if (n >= 100) return `$${Math.round(n)}`
  if (n >= 10) return `$${n.toFixed(1)}`
  return `$${n.toFixed(2)}`
}

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'now'
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h`
  return `${Math.floor(diffHr / 24)}d`
}

export function getOdTier(mult: number) {
  let tier = OD_TIERS[0]
  for (const t of OD_TIERS) {
    if (mult >= t.min) tier = t
    else break
  }
  return tier
}

export function fmtOrcLog(log: OrcLogEntry): string {
  const label = ORC_LOG_LABELS[log.type] || log.type
  if (log.taskTitle) {
    const title = log.taskTitle.length > 25 ? log.taskTitle.slice(0, 25) + '...' : log.taskTitle
    if (log.instanceName) return `${label}: "${title}" \u2192 ${log.instanceName}`
    return `${label}: "${title}"`
  }
  if (log.detail) {
    const detail = log.detail.length > 35 ? log.detail.slice(0, 35) + '...' : log.detail
    return `${label}: ${detail}`
  }
  return label
}
