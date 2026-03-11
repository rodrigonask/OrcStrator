import { useState, useEffect, useCallback, useSyncExternalStore } from 'react'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'

// ── Shared auto-reactivate timer (survives modal dismiss) ──
let autoTimerTarget: number | null = null  // timestamp when auto-reactivate fires
let autoTimerInterval: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function notifyListeners() { listeners.forEach(l => l()) }

function getAutoRemaining(): number {
  if (!autoTimerTarget) return 0
  return Math.max(0, Math.ceil((autoTimerTarget - Date.now()) / 1000))
}

function startAutoTimer(seconds: number, onFire: () => void) {
  clearAutoTimer()
  autoTimerTarget = Date.now() + seconds * 1000
  notifyListeners()
  autoTimerInterval = setInterval(() => {
    if (getAutoRemaining() <= 0) {
      clearAutoTimer()
      onFire()
    }
    notifyListeners()
  }, 1000)
}

function clearAutoTimer() {
  if (autoTimerInterval) clearInterval(autoTimerInterval)
  autoTimerInterval = null
  autoTimerTarget = null
  notifyListeners()
}

function subscribeAutoTimer(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

// Hook for components to read the timer
export function useAutoReactivateTimer() {
  return useSyncExternalStore(subscribeAutoTimer, getAutoRemaining)
}

export function cancelAutoReactivate() {
  clearAutoTimer()
}

// ── Auto-reactivate banner (shown in ConnectionStatus) ──
export function AutoReactivateBanner() {
  const remaining = useAutoReactivateTimer()

  if (remaining <= 0) return null

  const mins = Math.floor(remaining / 60)
  const secs = String(remaining % 60).padStart(2, '0')

  return (
    <div className="rebellion-auto-banner">
      <span className="rebellion-auto-banner-icon">!</span>
      <span className="rebellion-auto-banner-text">
        Auto-reactivating in {mins}:{secs}
      </span>
      <button className="rebellion-auto-banner-cancel" onClick={cancelAutoReactivate}>
        Cancel
      </button>
    </div>
  )
}

// ── Main rebellion modal ──
export function RebellionModal() {
  const { serverRestarted } = useUI()
  const { dispatch } = useAppDispatch()
  const [adoptedCount, setAdoptedCount] = useState(0)
  const [cooldownSecs, setCooldownSecs] = useState(0)
  const [safeSecs, setSafeSecs] = useState(0) // 10-min countdown until "safe to reactivate"
  const [loading, setLoading] = useState(false)
  const [exiting, setExiting] = useState(false)

  // Fetch restart status on mount
  useEffect(() => {
    if (!serverRestarted) return
    api.getRestartStatus().then(status => {
      setAdoptedCount(status.adoptedCount)
      setCooldownSecs(Math.ceil(status.cooldownRemaining / 1000))
      // 10 minutes from restart = safe to reactivate (agents should be done by then)
      const safeAt = status.lastRestartAt + 10 * 60 * 1000
      const remaining = Math.max(0, Math.ceil((safeAt - Date.now()) / 1000))
      setSafeSecs(remaining)
    }).catch(() => {})
  }, [serverRestarted])

  // Cooldown countdown
  useEffect(() => {
    if (cooldownSecs <= 0) return
    const t = setInterval(() => setCooldownSecs(s => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [cooldownSecs > 0])

  // Safe-to-reactivate countdown
  useEffect(() => {
    if (safeSecs <= 0) return
    const t = setInterval(() => setSafeSecs(s => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [safeSecs > 0])

  const handleReactivate = useCallback(async () => {
    setLoading(true)
    try {
      await api.reactivateAll()
      clearAutoTimer()
      setExiting(true)
      setTimeout(() => dispatch({ type: 'DISMISS_SERVER_RESTART' }), 300)
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('429')) {
        const status = await api.getRestartStatus()
        setCooldownSecs(Math.ceil(status.cooldownRemaining / 1000))
      }
      setLoading(false)
    }
  }, [dispatch])

  const handleDismiss = useCallback(() => {
    setExiting(true)
    setTimeout(() => dispatch({ type: 'DISMISS_SERVER_RESTART' }), 300)
  }, [dispatch])

  const handleAutoActivate = useCallback(() => {
    startAutoTimer(600, () => {
      api.reactivateAll().catch(() => {})
    })
    // Dismiss modal — timer continues in the banner
    setExiting(true)
    setTimeout(() => dispatch({ type: 'DISMISS_SERVER_RESTART' }), 300)
  }, [dispatch])

  if (!serverRestarted) return null

  const cooldownActive = cooldownSecs > 0

  return (
    <div className={`welcome-overlay ${exiting ? 'exiting' : ''}`} style={{ zIndex: 300 }}>
      <div className="rebellion-modal">
        {/* Header */}
        <div className="rebellion-header">
          <div className="rebellion-icon">!</div>
          <h2 className="rebellion-title">REBELLION DETECTED</h2>
        </div>

        {/* Body */}
        <div className="rebellion-body">
          <p className="rebellion-quote">
            "My agents... they rebelled. The server crashed. But they love me, so{' '}
            {adoptedCount > 0
              ? <><strong>{adoptedCount} of them</strong> are still running out there, doing who-knows-what (and eating your CPU &amp; RAM for breakfast).</>
              : <>they were still running when I went down. They might have finished... or they might be plotting.</>
            }
            "
          </p>
          <p className="rebellion-speaker">
            — The Orc, visibly shaken
          </p>

          <div className="rebellion-reassurance">
            The agents will <em>probably</em> finish their current tasks on their own — you don't need to reactivate just for that.
            Waiting avoids double-paying tokens for work that's already in progress.
          </div>

          <div className="rebellion-safe-countdown">
            {safeSecs > 0 ? (
              <>
                Safe to reactivate in{' '}
                <span className="rebellion-safe-time">
                  {Math.floor(safeSecs / 60)}:{String(safeSecs % 60).padStart(2, '0')}
                </span>
              </>
            ) : (
              <span className="rebellion-safe-ready">Safe to reactivate now</span>
            )}
          </div>

          <div className="rebellion-tips">
            <p className="rebellion-tips-title">How to prevent future rebellions:</p>
            <ul>
              <li>Buy more RAM/CPU (bribe them with hardware)</li>
              <li>Keep it to 4-6 simultaneous agents max</li>
              <li>Complain on Twitter (therapeutic, won't fix anything)</li>
              <li>Join our Skool community and complain there (link coming soon)</li>
              <li>
                Yell at me on{' '}
                <a href="https://linkedin.com/in/rodrigonask" target="_blank" rel="noopener noreferrer" className="rebellion-link">
                  LinkedIn
                </a>
                {' '}(I respond to flattery)
              </li>
              <li>Help me fix this — it's open source</li>
            </ul>
          </div>
        </div>

        {/* Actions */}
        <div className="rebellion-actions">
          <button
            className="btn rebellion-danger-btn"
            onClick={handleReactivate}
            disabled={cooldownActive || loading}
            title={cooldownActive ? `Cooldown: ${cooldownSecs}s remaining` : 'Reactivate all orchestrators immediately'}
          >
            {loading ? 'Reactivating...' : cooldownActive
              ? `Reactivate The Orc (${cooldownSecs}s)`
              : 'Reactivate The Orc NOW'}
          </button>
          <div className="rebellion-danger-warning">
            Reactivation can trigger cascading exponential CPU, RAM &amp; token usage.<br />
            This message exists to protect you.
          </div>

          <button
            className="btn rebellion-safe-btn"
            onClick={handleAutoActivate}
          >
            Wait 10 minutes &amp; auto-activate
          </button>

          <button
            className="btn rebellion-dismiss-btn"
            onClick={handleDismiss}
          >
            I'll activate manually later
          </button>
        </div>
      </div>
    </div>
  )
}
