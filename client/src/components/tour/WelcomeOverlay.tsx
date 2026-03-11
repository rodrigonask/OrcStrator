import { useState, useEffect, useCallback } from 'react'
import { useGame } from '../../context/GameContext'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { FEATURE_GATES } from '@shared/constants'
import { api } from '../../api'

interface FolderEntry {
  name: string
  path: string
}

const isWindows = navigator.platform.startsWith('Win') || navigator.platform === 'Win32'
const ROOT_PATH = isWindows ? 'C:\\' : '/'

// Common project folders shown as quick-pick suggestions during onboarding
const SUGGESTED_FOLDERS = isWindows
  ? [
      { path: 'C:\\claude', label: 'C:\\claude', desc: 'Claude Code default' },
      { path: 'C:\\github', label: 'C:\\github', desc: 'Common GitHub folder' },
      { path: 'C:\\Projects', label: 'C:\\Projects', desc: 'General projects' },
    ]
  : [
      { path: '~/claude', label: '~/claude', desc: 'Claude Code default' },
      { path: '~/github', label: '~/github', desc: 'Common GitHub folder' },
      { path: '~/projects', label: '~/projects', desc: 'General projects' },
    ]

export function WelcomeOverlay() {
  const { tour, completeStep, addXp } = useGame()
  const { dispatch } = useAppDispatch()
  const [step, setStep] = useState(0)
  const [exiting, setExiting] = useState(false)
  const [selectedPath, setSelectedPath] = useState('')
  const [guidedMode, setGuidedMode] = useState<'guided' | 'god' | null>(null)
  const [showBrowser, setShowBrowser] = useState(false)

  // Folder browser state (mirrors FullBrowser pattern from FolderBrowserModal)
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState<FolderEntry[]>([])
  const [browserLoading, setBrowserLoading] = useState(false)
  const [browserError, setBrowserError] = useState<string | null>(null)

  const browseIsWindows = currentPath.includes('\\') || /^[A-Z]:/i.test(currentPath)
  const atRoot = browseIsWindows
    ? /^[A-Za-z]:\\?$/.test(currentPath)
    : currentPath === '/'
  const sep = browseIsWindows ? '\\' : '/'
  const breadcrumbs = currentPath.split(/[\\/]/).filter(Boolean)
  const buildPath = (index: number) => {
    if (browseIsWindows) return breadcrumbs.slice(0, index + 1).join('\\')
    return '/' + breadcrumbs.slice(0, index + 1).join('/')
  }

  const loadDirectory = useCallback(async (path?: string) => {
    setBrowserLoading(true)
    setBrowserError(null)
    try {
      const result = await api.getSubfolders(path)
      setEntries(result.folders)
      setCurrentPath(result.dir)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setBrowserError(msg.includes('403') ? 'No access to this folder. Try navigating from your home directory.' : msg)
    } finally {
      setBrowserLoading(false)
    }
  }, [])

  const openBrowser = useCallback(() => {
    setShowBrowser(true)
    loadDirectory(ROOT_PATH)
  }, [loadDirectory])

  const handleFinish = useCallback(async () => {
    setExiting(true)

    // Save selected path as rootFolder in settings
    if (selectedPath) {
      try {
        await api.updateSettings({ rootFolder: selectedPath })
        dispatch({ type: 'UPDATE_SETTINGS', payload: { rootFolder: selectedPath } })
      } catch (err) {
        console.error('Failed to save onboarding settings:', err)
      }

      // Also create it as a folder entry
      try {
        await api.createFolder({
          path: selectedPath,
          name: selectedPath.replace(/^.*[\\/]/, ''),
        })
      } catch (err) {
        console.error('Failed to create folder entry:', err)
      }
    }

    // Mark onboarding complete + save guided mode
    try {
      await api.updateTour({ onboardingComplete: true, guidedMode: guidedMode || 'guided' })
      await completeStep('onboarding')
    } catch (err) {
      console.error('Failed to complete onboarding step:', err)
    }

    try {
      await addXp('tour-step')
    } catch (err) {
      console.error('Failed to award onboarding XP:', err)
    }
  }, [selectedPath, guidedMode, completeStep, addXp, dispatch])

  if (!tour || tour.onboardingComplete) return null

  // Group feature gates by tier for the checklist
  const beginnerGates = FEATURE_GATES.filter(g => g.level <= 5)
  const intermediateGates = FEATURE_GATES.filter(g => g.level >= 6 && g.level <= 10)
  const advancedGates = FEATURE_GATES.filter(g => g.level >= 11 && g.level <= 15)

  const steps = [
    // Step 1: Welcome
    <div key="welcome" className="welcome-wizard-step">
      <div className="welcome-logo" style={{ fontFamily: 'var(--font-pixel)' }}>OrcStrator</div>
      <h2 className="welcome-wizard-title">Use Claude Code like a game.</h2>
      <p className="welcome-wizard-desc">
        Every message earns XP. Level up to unlock features.
      </p>
    </div>,

    // Step 2: Choose Your Path
    <div key="path" className="welcome-wizard-step">
      <h2 className="welcome-wizard-title">Choose Your Path</h2>
      <p className="welcome-wizard-desc">Pick how you want to start.</p>
      <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
        {([
          { key: 'guided' as const, icon: '\uD83D\uDEE1', label: 'Guided Mode', desc: 'Learn step by step. Features unlock as you level up.' },
          { key: 'god' as const, icon: '\uD83D\uDC79', label: 'God Mode', desc: 'Everything unlocked. XP still tracks. For experienced Claude users.' },
        ]).map(mode => (
          <button
            key={mode.key}
            onClick={() => setGuidedMode(mode.key)}
            style={{
              flex: 1, padding: '20px 14px', textAlign: 'center', cursor: 'pointer',
              border: guidedMode === mode.key ? '2px solid var(--accent)' : '2px solid var(--border)',
              borderRadius: 10, color: 'var(--text-primary)',
              background: guidedMode === mode.key ? 'var(--accent-muted)' : 'var(--bg-secondary)',
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 10 }}>{mode.icon}</div>
            <div style={{ fontFamily: 'var(--font-pixel)', fontSize: 10, marginBottom: 6, color: 'var(--text-primary)' }}>{mode.label}</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.4 }}>{mode.desc}</div>
          </button>
        ))}
      </div>
    </div>,

    // Step 3: Select Directory
    <div key="folder" className="welcome-wizard-step">
      <h2 className="welcome-wizard-title">Choose your projects folder</h2>
      <p className="welcome-wizard-desc">
        Where do your coding projects live?
      </p>

      {/* Card grid: 3 suggestions + Browse */}
      {!showBrowser && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 4 }}>
          {SUGGESTED_FOLDERS.map(s => (
            <button
              key={s.path}
              onClick={() => setSelectedPath(s.path)}
              style={{
                padding: '16px 12px', textAlign: 'center', cursor: 'pointer',
                border: selectedPath === s.path ? '2px solid var(--accent)' : '2px solid var(--border)',
                borderRadius: 10, color: 'var(--text-primary)',
                background: selectedPath === s.path ? 'var(--accent-muted)' : 'var(--bg-secondary)',
              }}
            >
              <div style={{ fontSize: 24, marginBottom: 6 }}>{'\uD83D\uDCC1'}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600 }}>{s.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{s.desc}</div>
            </button>
          ))}
          <button
            onClick={openBrowser}
            style={{
              padding: '16px 12px', textAlign: 'center', cursor: 'pointer',
              border: '2px solid var(--border)', borderRadius: 10, color: 'var(--text-primary)',
              background: 'var(--bg-secondary)',
            }}
          >
            <div style={{ fontSize: 24, marginBottom: 6 }}>{'\uD83D\uDD0D'}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600 }}>Browse...</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>Pick any folder</div>
          </button>
        </div>
      )}

      {/* Full folder browser (shown after clicking Browse) */}
      {showBrowser && (
        <div className="welcome-folder-browser" style={{ marginTop: 8 }}>
          <button
            className="btn"
            onClick={() => setShowBrowser(false)}
            style={{ fontSize: 13, marginBottom: 10 }}
          >
            {'\u2190'} Back to suggestions
          </button>

          {/* Breadcrumb navigation */}
          <div className="folder-breadcrumb">
            {!browseIsWindows && (
              <button className="folder-breadcrumb-item" onClick={() => loadDirectory('/')}>
                /
              </button>
            )}
            {breadcrumbs.map((part, i) => (
              <span key={i}>
                <span className="folder-breadcrumb-sep">{sep}</span>
                <button className="folder-breadcrumb-item" onClick={() => loadDirectory(buildPath(i))}>
                  {part}
                </button>
              </span>
            ))}
          </div>

          {/* Editable path + Go */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input
              className="form-input"
              value={currentPath}
              onChange={e => setCurrentPath(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') loadDirectory(currentPath) }}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 13, flex: 1 }}
            />
            <button className="btn" onClick={() => loadDirectory(currentPath)} style={{ padding: '6px 14px', fontSize: 13 }}>
              Go
            </button>
          </div>

          {/* Directory listing */}
          {browserError && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 8 }}>{browserError}</div>}
          {browserLoading ? (
            <div style={{ textAlign: 'center', padding: 16, color: 'var(--text-secondary)', fontSize: 13 }}>Loading...</div>
          ) : (
            <div className="folder-list" style={{ maxHeight: 180, marginBottom: 8 }}>
              {!atRoot && (
                <div
                  className="folder-list-item"
                  onClick={() => {
                    let parent = currentPath.replace(/[\\/][^\\/]+[\\/]?$/, '')
                    if (browseIsWindows && /^[A-Za-z]:$/.test(parent)) parent += '\\'
                    if (!parent) parent = '/'
                    loadDirectory(parent)
                  }}
                >
                  <span className="folder-list-icon">..</span>
                  <span>Parent directory</span>
                </div>
              )}
              {entries.map(entry => (
                <div
                  key={entry.path}
                  className="folder-list-item"
                  onClick={() => loadDirectory(entry.path)}
                >
                  <span className="folder-list-icon">{'\uD83D\uDCC2'}</span>
                  <span>{entry.name}</span>
                </div>
              ))}
              {entries.length === 0 && !browserLoading && (
                <div className="folder-list-item" style={{ color: 'var(--text-muted)', cursor: 'default' }}>
                  No subdirectories
                </div>
              )}
            </div>
          )}

          {/* Select current folder button */}
          <button
            className={`btn ${selectedPath === currentPath ? 'btn-primary' : ''}`}
            onClick={() => setSelectedPath(currentPath)}
            style={{ width: '100%', fontSize: 13 }}
          >
            {selectedPath === currentPath
              ? `\u2713 Selected: ${currentPath}`
              : `Select this folder: ${currentPath}`
            }
          </button>
        </div>
      )}

      {/* Selection confirmation (visible in both modes) */}
      {selectedPath && !showBrowser && (
        <div style={{
          padding: '10px 14px', marginTop: 10,
          background: 'var(--accent-muted)', borderRadius: 8,
          fontSize: 13, color: 'var(--accent-text)', fontWeight: 600,
          textAlign: 'center',
        }}>
          {'\u2713'} {selectedPath}
        </div>
      )}
    </div>,

    // Step 4: Unlock Checklist
    <div key="checklist" className="welcome-wizard-step">
      <h2 className="welcome-wizard-title" style={{ color: 'var(--accent-text)' }}>
        {'\u2728'} What you'll unlock
      </h2>
      <p className="welcome-wizard-desc">
        Every level brings new powers.
      </p>
      <div className="unlock-scroll" style={{
        maxHeight: 300, overflowY: 'auto', marginBottom: 12,
        paddingRight: 4,
      }}>
        {[
          { label: 'Beginner', range: 'Lv 1-5', gates: beginnerGates, icon: '\uD83D\uDEE1\uFE0F' },
          { label: 'Intermediate', range: 'Lv 6-10', gates: intermediateGates, icon: '\u2694\uFE0F' },
          { label: 'Advanced', range: 'Lv 11-15', gates: advancedGates, icon: '\uD83D\uDC51' },
        ].map(tier => (
          <div key={tier.label} style={{ marginBottom: 14 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontFamily: 'var(--font-pixel)', fontSize: 9,
              color: 'var(--accent-text)', margin: '0 0 8px',
              textTransform: 'uppercase', letterSpacing: 1,
            }}>
              <span style={{ fontSize: 16 }}>{tier.icon}</span>
              {tier.label}
              <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 400 }}>
                {tier.range}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {tier.gates.map(gate => (
                <div key={gate.key} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                  background: 'var(--bg-tertiary)', borderRadius: 8,
                  border: '1px solid var(--border)',
                }}>
                  <span style={{
                    fontFamily: 'var(--font-pixel)', fontSize: 10,
                    background: 'var(--accent-muted)', borderRadius: 6,
                    padding: '4px 8px', minWidth: 28, textAlign: 'center',
                    color: 'var(--accent-text)', fontWeight: 700,
                    border: '1px solid var(--border-accent)',
                  }}>
                    {gate.level}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {gate.title}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.4 }}>
                      {gate.description}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center' }}>
        Unlock everything in 1-2 days of regular usage.
      </p>
    </div>,

    // Step 5: Ready!
    <div key="go" className="welcome-wizard-step" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>{'\uD83D\uDE80'}</div>
      <h2 className="welcome-wizard-title">Ready to begin!</h2>
      <p className="welcome-wizard-desc">
        {selectedPath
          ? `Starting with: ${selectedPath.replace(/^.*[\\/]/, '')}`
          : 'You can add projects anytime from the sidebar.'}
      </p>
      <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 8 }}>
        Level 1 · Novice · 0 / 75 XP to next level
      </p>
      <button
        className="btn btn-primary"
        onClick={handleFinish}
        style={{ width: '100%', padding: '12px', fontSize: 14, marginTop: 24, fontFamily: 'var(--font-mono)' }}
      >
        Launch OrcStrator {'\u2192'}
      </button>
    </div>
  ]

  const canAdvance = step === 1 ? guidedMode !== null : step === 2 ? selectedPath !== '' : true
  const isLast = step === steps.length - 1

  return (
    <div className={`welcome-overlay ${exiting ? 'exiting' : ''}`}>
      <div className="welcome-card welcome-card-wide">
        {steps[step]}

        {/* Step dots + navigation */}
        {!isLast && (
          <div className="welcome-nav">
            {step > 0 && (
              <button className="btn" onClick={() => setStep(s => s - 1)} style={{ fontSize: 13 }}>
                Back
              </button>
            )}

            <div className="welcome-steps">
              {steps.map((_, i) => (
                <div
                  key={i}
                  className={`welcome-step-dot ${i <= step ? 'active' : ''} ${i === step ? 'current' : ''}`}
                />
              ))}
            </div>

            <button
              className="btn btn-primary"
              onClick={() => canAdvance && setStep(s => s + 1)}
              disabled={!canAdvance}
              style={{ fontSize: 13 }}
            >
              Next
            </button>
          </div>
        )}

        <div className="welcome-step-title">
          {['Welcome', 'Choose Path', 'Select Folder', 'Features', 'Launch'][step]}
          {' \u00B7 '}Step {step + 1} of {steps.length}
        </div>
      </div>
    </div>
  )
}
