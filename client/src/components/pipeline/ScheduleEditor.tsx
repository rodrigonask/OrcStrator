import { useState, useCallback, useEffect } from 'react'
import type { PipelineTask, ScheduleConfig, ScheduleExecution } from '@shared/types'
import { computeNextRun, formatNextRun, scheduleTypeLabel } from '@shared/scheduler-utils'
import { rest } from '../../api/rest'

interface ScheduleEditorProps {
  task: PipelineTask
  projectId: string
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const DEFAULT_SCHEDULE: ScheduleConfig = {
  type: 'daily',
  enabled: false,
  hours: [9],
}

export function ScheduleEditor({ task, projectId }: ScheduleEditorProps) {
  const [cfg, setCfg] = useState<ScheduleConfig>(task.schedule ?? { ...DEFAULT_SCHEDULE })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setCfg(task.schedule ?? { ...DEFAULT_SCHEDULE })
  }, [task.schedule])

  const nextPreview = computeNextRun(cfg)
  const nextLabel = nextPreview ? formatNextRun({ ...cfg, nextRunAt: nextPreview }) : 'Not scheduled'

  const save = useCallback(async () => {
    setSaving(true)
    try {
      await rest.updateTaskSchedule(projectId, task.id, cfg)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      console.error('Failed to save schedule:', err)
    } finally {
      setSaving(false)
    }
  }, [cfg, projectId, task.id])

  const executions: ScheduleExecution[] = task.executions ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="task-detail-section-label">Schedule</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={e => setCfg(c => ({ ...c, enabled: e.target.checked }))}
          />
          <span style={{ fontFamily: 'var(--font-mono)', color: cfg.enabled ? 'var(--col-scheduled)' : 'var(--text-muted)' }}>
            {cfg.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>
      </div>

      {/* Type selector */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {(['once', 'daily', 'weekly', 'interval', 'monthly'] as const).map(t => (
          <button
            key={t}
            className={`btn btn-sm${cfg.type === t ? ' btn-primary' : ''}`}
            style={{ fontSize: 11, padding: '3px 10px' }}
            onClick={() => setCfg(c => ({ ...c, type: t }))}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Type-specific config */}
      {cfg.type === 'once' && (
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Run at</label>
          <input
            type="datetime-local"
            className="form-input"
            value={cfg.runAt ? new Date(cfg.runAt).toISOString().slice(0, 16) : ''}
            onChange={e => setCfg(c => ({ ...c, runAt: e.target.value ? new Date(e.target.value).getTime() : undefined }))}
          />
        </div>
      )}

      {cfg.type === 'daily' && (
        <div>
          <div className="form-label" style={{ marginBottom: 6 }}>Hours (click to toggle)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {HOURS.map(h => {
              const active = (cfg.hours ?? [9]).includes(h)
              return (
                <button
                  key={h}
                  className={`btn btn-sm${active ? ' btn-primary' : ''}`}
                  style={{ fontSize: 10, padding: '2px 6px', minWidth: 28 }}
                  onClick={() => {
                    const hours = cfg.hours ?? [9]
                    setCfg(c => ({ ...c, hours: active ? hours.filter(x => x !== h) : [...hours, h].sort((a, b) => a - b) }))
                  }}
                >
                  {h}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {cfg.type === 'weekly' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <div className="form-label" style={{ marginBottom: 6 }}>Days</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {DAYS_OF_WEEK.map((d, i) => {
                const active = (cfg.days ?? [1]).includes(i)
                return (
                  <button
                    key={d}
                    className={`btn btn-sm${active ? ' btn-primary' : ''}`}
                    style={{ fontSize: 11, padding: '3px 8px' }}
                    onClick={() => {
                      const days = cfg.days ?? [1]
                      setCfg(c => ({ ...c, days: active ? days.filter(x => x !== i) : [...days, i].sort() }))
                    }}
                  >
                    {d}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Hour</label>
            <select
              className="form-select"
              style={{ maxWidth: 100 }}
              value={cfg.weeklyHour ?? 9}
              onChange={e => setCfg(c => ({ ...c, weeklyHour: Number(e.target.value) }))}
            >
              {HOURS.map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </div>
        </div>
      )}

      {cfg.type === 'interval' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Every</label>
            <input
              type="number"
              className="form-input"
              style={{ maxWidth: 70 }}
              min={1}
              value={cfg.intervalValue ?? 1}
              onChange={e => setCfg(c => ({ ...c, intervalValue: Math.max(1, Number(e.target.value)) }))}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Unit</label>
            <select
              className="form-select"
              style={{ maxWidth: 100 }}
              value={cfg.intervalUnit ?? 'days'}
              onChange={e => setCfg(c => ({ ...c, intervalUnit: e.target.value as 'hours' | 'days' | 'weeks' }))}
            >
              <option value="hours">Hours</option>
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
            </select>
          </div>
        </div>
      )}

      {cfg.type === 'monthly' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Day of month</label>
            <input
              type="number"
              className="form-input"
              style={{ maxWidth: 70 }}
              min={1}
              max={28}
              value={cfg.dayOfMonth ?? 1}
              onChange={e => setCfg(c => ({ ...c, dayOfMonth: Math.min(28, Math.max(1, Number(e.target.value))) }))}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Hour</label>
            <select
              className="form-select"
              style={{ maxWidth: 100 }}
              value={cfg.monthlyHour ?? 9}
              onChange={e => setCfg(c => ({ ...c, monthlyHour: Number(e.target.value) }))}
            >
              {HOURS.map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Next run preview */}
      <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: cfg.enabled ? 'var(--col-scheduled)' : 'var(--text-muted)', padding: '6px 0' }}>
        Next run: {cfg.enabled ? nextLabel : 'Schedule disabled'}
        {cfg.fireCount != null && cfg.fireCount > 0 && (
          <span style={{ marginLeft: 12, color: 'var(--text-muted)' }}>({cfg.fireCount} run{cfg.fireCount !== 1 ? 's' : ''} total)</span>
        )}
      </div>

      {/* Save button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Schedule'}
        </button>
        {task.schedule?.currentlyRunning && (
          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--col-build)' }}>
            Running now...
          </span>
        )}
      </div>

      {/* Execution trail */}
      {executions.length > 0 && (
        <div>
          <div className="task-detail-section-label" style={{ marginBottom: 8 }}>Execution History</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[...executions].reverse().slice(0, 10).map(ex => (
              <ExecutionRow key={ex.runId} exec={ex} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ExecutionRow({ exec }: { exec: ScheduleExecution }) {
  const started = new Date(exec.startedAt)
  const duration = exec.endedAt ? Math.round((exec.endedAt - exec.startedAt) / 1000) : null
  const statusColor = exec.status === 'completed' ? 'var(--col-ship)' : exec.status === 'failed' ? '#ef4444' : 'var(--col-build)'

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '70px 80px 1fr auto',
      gap: 8,
      fontSize: 11,
      fontFamily: 'var(--font-mono)',
      padding: '4px 8px',
      background: 'var(--bg-secondary)',
      borderRadius: 4,
      alignItems: 'center',
    }}>
      <span style={{ color: statusColor, fontWeight: 600 }}>{exec.status}</span>
      <span style={{ color: 'var(--text-muted)' }}>{started.toLocaleDateString()}</span>
      <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {exec.summary || exec.instanceId.slice(0, 8)}
      </span>
      <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {duration != null ? `${duration}s` : ''}
        {exec.costUsd != null ? ` $${exec.costUsd.toFixed(3)}` : ''}
      </span>
    </div>
  )
}
