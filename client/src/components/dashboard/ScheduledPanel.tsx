import { useEffect, useState, useCallback } from 'react'
import type { ScheduleConfig } from '@shared/types'
import { formatNextRun, scheduleTypeLabel } from '@shared/scheduler-utils'
import { rest } from '../../api/rest'

interface ScheduledEntry {
  id: string
  title: string
  skill?: string
  schedule: ScheduleConfig | null
  nextRunAt?: number
  withinHorizon: boolean
  currentlyRunning: boolean
}

interface ScheduledPanelProps {
  projectId: string
}

export function ScheduledPanel({ projectId }: ScheduledPanelProps) {
  const [entries, setEntries] = useState<ScheduledEntry[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const data = await rest.getScheduledUpcoming(projectId, 30)
      setEntries(data)
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  const now = Date.now()
  const todayEnd = new Date()
  todayEnd.setHours(23, 59, 59, 999)
  const todayEndMs = todayEnd.getTime()
  const in7Days = now + 7 * 24 * 60 * 60 * 1000

  const running = entries.filter(e => e.currentlyRunning)
  const today   = entries.filter(e => !e.currentlyRunning && e.nextRunAt != null && e.nextRunAt <= todayEndMs)
  const next7   = entries.filter(e => !e.currentlyRunning && e.nextRunAt != null && e.nextRunAt > todayEndMs && e.nextRunAt <= in7Days)
  const next30  = entries.filter(e => !e.currentlyRunning && e.nextRunAt != null && e.nextRunAt > in7Days && e.withinHorizon)

  if (!loading && entries.length === 0) return null

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--col-scheduled)', fontFamily: 'var(--font-mono)', marginBottom: 8, letterSpacing: '0.05em' }}>
        SCHEDULED TASKS
      </div>

      {loading && <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Loading...</div>}

      {running.length > 0 && (
        <Section label="Running Now" accent="var(--col-build)" entries={running} now={now} showElapsed />
      )}
      {today.length > 0 && (
        <Section label="Today" accent="var(--col-scheduled)" entries={today} now={now} />
      )}
      {next7.length > 0 && (
        <Section label="Next 7 Days" accent="var(--col-spec)" entries={next7} now={now} />
      )}
      {next30.length > 0 && (
        <Section label="Next 30 Days" accent="var(--text-muted)" entries={next30} now={now} compact />
      )}
    </div>
  )
}

function Section({ label, accent, entries, now, showElapsed, compact }: {
  label: string
  accent: string
  entries: ScheduledEntry[]
  now: number
  showElapsed?: boolean
  compact?: boolean
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: accent, fontFamily: 'var(--font-mono)', fontWeight: 600, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {entries.map(e => (
          <ScheduledRow key={e.id} entry={e} now={now} showElapsed={showElapsed} compact={compact} />
        ))}
      </div>
    </div>
  )
}

function ScheduledRow({ entry, now, showElapsed, compact }: {
  entry: ScheduledEntry
  now: number
  showElapsed?: boolean
  compact?: boolean
}) {
  const schedule = entry.schedule
  const typeLabel = schedule ? scheduleTypeLabel(schedule) : ''
  const nextLabel = schedule && entry.nextRunAt
    ? formatNextRun({ ...schedule, nextRunAt: entry.nextRunAt }, now)
    : ''

  if (compact) {
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, fontFamily: 'var(--font-mono)', padding: '2px 0' }}>
        <span style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{entry.title}</span>
        <span style={{ color: 'var(--text-muted)' }}>{nextLabel}</span>
      </div>
    )
  }

  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: '6px 10px',
      fontSize: 11,
      fontFamily: 'var(--font-mono)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
          {entry.title}
        </span>
        {showElapsed && entry.schedule?.currentlyRunning && (
          <span style={{ color: 'var(--col-build)', fontSize: 10 }}>RUNNING</span>
        )}
        {!showElapsed && nextLabel && (
          <span style={{ color: 'var(--col-scheduled)', fontSize: 10 }}>{nextLabel}</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, color: 'var(--text-muted)', fontSize: 10 }}>
        <span>{typeLabel}</span>
        {entry.skill && <span style={{ color: 'var(--col-scheduled)' }}>{entry.skill}</span>}
      </div>
    </div>
  )
}
