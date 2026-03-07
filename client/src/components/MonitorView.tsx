import { useState, useEffect, useCallback } from 'react'
import { useInstances } from '../context/InstancesContext'
import { api } from '../api'

interface HealthData {
  status: string
  uptime: number
  clients: number
  processes: number
  totalInstances: number
  runningInstances: number
  memoryMb: number
  heapMb: number
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

const STATE_COLORS: Record<string, string> = {
  running: 'var(--success)',
  idle: 'var(--text-tertiary)',
  paused: 'var(--warning)',
}

const STATE_BG: Record<string, string> = {
  running: 'var(--success-muted)',
  idle: 'rgba(136,136,168,0.1)',
  paused: 'var(--warning-muted)',
}

const ROLE_COLORS: Record<string, string> = {
  planner: 'var(--role-planner)',
  builder: 'var(--role-builder)',
  tester: 'var(--role-tester)',
  promoter: 'var(--role-promoter)',
}

export function MonitorView() {
  const { instances, folders } = useInstances()
  const [health, setHealth] = useState<HealthData | null>(null)
  const [killing, setKilling] = useState<Set<string>>(new Set())
  const [killAllPending, setKillAllPending] = useState(false)
  const [killAllConfirm, setKillAllConfirm] = useState(false)

  const fetchHealth = useCallback(async () => {
    try {
      const data = await api.getHealth()
      setHealth(data)
    } catch {
      // ignore transient errors
    }
  }, [])

  useEffect(() => {
    fetchHealth()
    const t = setInterval(fetchHealth, 2000)
    return () => clearInterval(t)
  }, [fetchHealth])

  const killInstance = useCallback(async (id: string) => {
    setKilling(prev => new Set(prev).add(id))
    try {
      await api.killInstance(id)
    } catch (e) {
      console.error('Kill instance failed:', e)
    } finally {
      setKilling(prev => { const s = new Set(prev); s.delete(id); return s })
    }
  }, [])

  const killAll = useCallback(async () => {
    if (!killAllConfirm) { setKillAllConfirm(true); return }
    setKillAllPending(true)
    setKillAllConfirm(false)
    try {
      await api.shutdownAll()
    } catch (e) {
      console.error('Kill all failed:', e)
    } finally {
      setKillAllPending(false)
    }
  }, [killAllConfirm])

  const folderMap = new Map(folders.map(f => [f.id, f]))
  const runningInstances = instances.filter(i => i.state === 'running')
  const sortedInstances = [...instances].sort((a, b) => {
    const order = { running: 0, paused: 1, idle: 2 }
    return (order[a.state] ?? 3) - (order[b.state] ?? 3)
  })

  return (
    <div style={{
      height: '100%',
      overflow: 'auto',
      padding: '24px',
      background: 'var(--bg-primary)',
      fontFamily: 'var(--font-mono)',
    }}>
      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}>
          <span style={{ color: 'var(--success)', fontSize: '10px', letterSpacing: '2px' }}>■</span>
          <h1 style={{ margin: 0, fontSize: '14px', letterSpacing: '3px', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
            PROCESS MONITOR
          </h1>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', letterSpacing: '1px' }}>
            {health ? `SERVER ${health.status.toUpperCase()}` : 'CONNECTING...'}
          </span>
        </div>
        <div style={{ height: '1px', background: 'var(--border)', marginTop: '12px' }} />
      </div>

      {/* Stats Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '24px' }}>
        {[
          { label: 'UPTIME', value: health ? fmtUptime(health.uptime) : '—' },
          { label: 'RUNNING', value: health ? String(health.processes) : '—', color: health && health.processes > 0 ? 'var(--success)' : undefined },
          { label: 'INSTANCES', value: health ? `${health.runningInstances} / ${health.totalInstances}` : '—' },
          { label: 'TERMINALS', value: health ? String(health.clients) : '—' },
          { label: 'MEMORY', value: health ? `${health.memoryMb}MB` : '—' },
          { label: 'HEAP', value: health ? `${health.heapMb}MB` : '—' },
        ].map(stat => (
          <div key={stat.label} style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '12px 14px',
          }}>
            <div style={{ fontSize: '9px', color: 'var(--text-muted)', letterSpacing: '1.5px', marginBottom: '6px' }}>{stat.label}</div>
            <div style={{ fontSize: '16px', color: stat.color || 'var(--text-primary)', fontWeight: 700 }}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Kill Switch */}
      <div style={{
        background: 'var(--error-muted)',
        border: '1px solid rgba(239,68,68,0.3)',
        borderRadius: 'var(--radius-md)',
        padding: '16px 20px',
        marginBottom: '24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
      }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--error)', letterSpacing: '1.5px', fontWeight: 700, marginBottom: '2px' }}>KILL SWITCH</div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            Terminates all {runningInstances.length} active Claude process{runningInstances.length !== 1 ? 'es' : ''} immediately
          </div>
        </div>
        <button
          onClick={killAll}
          disabled={killAllPending || runningInstances.length === 0}
          onMouseLeave={() => setKillAllConfirm(false)}
          style={{
            background: killAllConfirm ? 'var(--error)' : 'rgba(239,68,68,0.2)',
            border: '1px solid var(--error)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--error)',
            padding: '8px 20px',
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '1px',
            cursor: runningInstances.length === 0 ? 'not-allowed' : 'pointer',
            opacity: runningInstances.length === 0 ? 0.4 : 1,
            transition: 'all var(--transition-fast)',
            whiteSpace: 'nowrap',
            ...(killAllConfirm ? { color: '#fff' } : {}),
          }}
        >
          {killAllPending ? 'KILLING...' : killAllConfirm ? 'CONFIRM KILL ALL' : 'KILL ALL'}
        </button>
      </div>

      {/* Instance Table */}
      <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '9px', color: 'var(--text-muted)', letterSpacing: '1.5px' }}>
          INSTANCES ({sortedInstances.length})
        </span>
        <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
          {runningInstances.length > 0 ? `${runningInstances.length} RUNNING` : 'ALL IDLE'}
        </span>
      </div>

      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}>
        {/* Table header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '160px 120px 90px 80px 1fr 100px',
          padding: '8px 16px',
          borderBottom: '1px solid var(--border)',
          fontSize: '9px',
          color: 'var(--text-muted)',
          letterSpacing: '1.5px',
          gap: '8px',
        }}>
          <span>INSTANCE</span>
          <span>FOLDER</span>
          <span>ROLE</span>
          <span>STATE</span>
          <span>ACTIVE TASK</span>
          <span style={{ textAlign: 'right' }}>ACTION</span>
        </div>

        {sortedInstances.length === 0 && (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
            No instances
          </div>
        )}

        {sortedInstances.map((instance, idx) => {
          const folder = folderMap.get(instance.folderId)
          const isKilling = killing.has(instance.id)
          const canKill = instance.state === 'running'
          const canResume = instance.state === 'paused'

          return (
            <div
              key={instance.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '160px 120px 90px 80px 1fr 100px',
                padding: '10px 16px',
                gap: '8px',
                alignItems: 'center',
                borderBottom: idx < sortedInstances.length - 1 ? '1px solid var(--border)' : 'none',
                background: instance.state === 'running' ? 'rgba(16,185,129,0.03)' : 'transparent',
                transition: 'background var(--transition-fast)',
              }}
            >
              {/* Instance name */}
              <div style={{ fontSize: '12px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {instance.name}
              </div>

              {/* Folder */}
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {folder?.displayName || folder?.name || '—'}
              </div>

              {/* Role */}
              <div>
                {instance.agentRole ? (
                  <span style={{
                    fontSize: '9px',
                    color: ROLE_COLORS[instance.agentRole] || 'var(--text-secondary)',
                    letterSpacing: '1px',
                    fontWeight: 700,
                  }}>
                    {instance.agentRole.toUpperCase()}
                  </span>
                ) : (
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>—</span>
                )}
              </div>

              {/* State badge */}
              <div>
                <span style={{
                  display: 'inline-block',
                  padding: '2px 7px',
                  borderRadius: '3px',
                  fontSize: '9px',
                  fontWeight: 700,
                  letterSpacing: '1px',
                  color: STATE_COLORS[instance.state] || 'var(--text-muted)',
                  background: STATE_BG[instance.state] || 'transparent',
                }}>
                  {instance.state.toUpperCase()}
                </span>
              </div>

              {/* Active task */}
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {instance.activeTaskTitle || <span style={{ color: 'var(--text-muted)' }}>—</span>}
              </div>

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                {canKill && (
                  <button
                    onClick={() => killInstance(instance.id)}
                    disabled={isKilling}
                    style={{
                      background: 'var(--error-muted)',
                      border: '1px solid rgba(239,68,68,0.4)',
                      borderRadius: '3px',
                      color: 'var(--error)',
                      padding: '3px 10px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '9px',
                      fontWeight: 700,
                      cursor: 'pointer',
                      letterSpacing: '0.5px',
                    }}
                  >
                    {isKilling ? '...' : 'KILL'}
                  </button>
                )}
                {canResume && (
                  <button
                    onClick={() => api.resumeInstance(instance.id)}
                    style={{
                      background: 'var(--success-muted)',
                      border: '1px solid rgba(16,185,129,0.4)',
                      borderRadius: '3px',
                      color: 'var(--success)',
                      padding: '3px 8px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '9px',
                      fontWeight: 700,
                      cursor: 'pointer',
                      letterSpacing: '0.5px',
                    }}
                  >
                    RESUME
                  </button>
                )}
                {instance.state === 'idle' && (
                  <span style={{ fontSize: '9px', color: 'var(--text-muted)', alignSelf: 'center' }}>IDLE</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div style={{ marginTop: '16px', fontSize: '9px', color: 'var(--text-muted)', letterSpacing: '1px', textAlign: 'right' }}>
        AUTO-REFRESH 2s · SERVER :3333
      </div>
    </div>
  )
}
