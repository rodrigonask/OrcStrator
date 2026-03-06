import { useState, useEffect, useCallback } from 'react'
import { useGame } from '../../context/GameContext'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { api } from '../../api'

interface FolderEntry {
  name: string
  path: string
}

const isWindows = navigator.platform.startsWith('Win') || navigator.platform === 'Win32'
const ROOT_PATH = isWindows ? 'C:\\' : '/'

export function WelcomeOverlay() {
  const { tour, completeStep, addXp } = useGame()
  const { dispatch } = useAppDispatch()
  const [step, setStep] = useState(0)
  const [exiting, setExiting] = useState(false)
  const [selectedPath, setSelectedPath] = useState('')
  const [folders, setFolders] = useState<FolderEntry[]>([])
  const [browsingPath, setBrowsingPath] = useState(ROOT_PATH)
  const [pathInput, setPathInput] = useState(ROOT_PATH)

  // Load subfolders when browsing path changes
  useEffect(() => {
    if (!browsingPath) return
    setPathInput(browsingPath)
    api.getSubfolders(browsingPath)
      .then(result => setFolders(result.folders))
      .catch(() => setFolders([]))
  }, [browsingPath])

  const handlePathSubmit = () => {
    const trimmed = pathInput.trim()
    if (trimmed) setBrowsingPath(trimmed)
  }

  const navigateUp = () => {
    if (!browsingPath) return
    if (isWindows && /^[A-Za-z]:\\?$/.test(browsingPath)) return
    if (browsingPath === '/') return
    let parent = browsingPath.replace(/[\\/][^\\/]+[\\/]?$/, '')
    if (isWindows && /^[A-Za-z]:$/.test(parent)) parent += '\\'
    if (!parent) parent = '/'
    setBrowsingPath(parent)
  }

  const atRoot = isWindows
    ? /^[A-Za-z]:\\?$/.test(browsingPath)
    : browsingPath === '/'

  const handleFinish = useCallback(async () => {
    setExiting(true)

    // Save selected path as rootFolder in settings
    if (selectedPath) {
      try {
        await api.updateSettings({ rootFolder: selectedPath })
        dispatch({ type: 'UPDATE_SETTINGS', payload: { rootFolder: selectedPath } })
      } catch {
        // settings update failed, continue anyway
      }

      // Also create it as a folder entry
      try {
        await api.createFolder({
          path: selectedPath,
          name: selectedPath.replace(/^.*[\\/]/, ''),
        })
      } catch {
        // folder might already exist (UNIQUE constraint)
      }
    }

    // Mark onboarding complete — set the boolean directly
    try {
      await api.updateTour({ onboardingComplete: true })
      await completeStep('onboarding')
    } catch {
      // continue anyway
    }

    try {
      await addXp('tour-step')
    } catch {
      // XP award failed, non-critical
    }
  }, [selectedPath, completeStep, addXp, dispatch])

  if (!tour || tour.onboardingComplete) return null

  const steps = [
    // Step 1: Welcome
    <div key="welcome" className="welcome-wizard-step">
      <div className="welcome-logo">OrcStrator</div>
      <h2 className="welcome-wizard-title">Use Claude Code like a game.</h2>
      <p className="welcome-wizard-desc">
        Every message earns 15 XP. Complex tasks earn bonus XP.
        Level up to unlock agents, skills, lessons, and knowledge bases.
      </p>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
        30 levels across 6 tiers — from Novice to Singularity.
        Your first level-up is just 10 messages away.
      </p>
    </div>,

    // Step 2: Select Folder
    <div key="folder" className="welcome-wizard-step">
      <h2 className="welcome-wizard-title">Choose your root folder</h2>
      <p className="welcome-wizard-desc">
        Pick the root folder where all your Claude Code projects live.
        {isWindows ? ' For example: C:\\Projects or C:\\Agents' : ' For example: ~/dev or ~/projects'}
      </p>

      <div className="welcome-folder-browser">
        {/* Editable path input */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            type="text"
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handlePathSubmit() }}
            style={{
              flex: 1, padding: '8px 12px', fontSize: 13,
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text-primary)', outline: 'none',
              fontFamily: 'var(--font-mono, monospace)',
            }}
            placeholder={isWindows ? 'C:\\Agents' : '/home/user/projects'}
          />
          <button className="btn btn-primary" onClick={handlePathSubmit} style={{ padding: '8px 14px' }}>
            Go
          </button>
        </div>

        {/* Current selection highlight */}
        {selectedPath && (
          <div style={{
            padding: '10px 14px', marginBottom: 12,
            background: 'var(--accent-muted)', borderRadius: 8,
            fontSize: 13, color: 'var(--accent-text)', fontWeight: 600,
          }}>
            Selected: {selectedPath.replace(/^.*[\\/]/, '')}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginTop: 2 }}>
              {selectedPath}
            </div>
          </div>
        )}

        {/* Folder list with .. navigation */}
        {browsingPath && (
          <div className="folder-list" style={{ maxHeight: 200, marginBottom: 12 }}>
            {!atRoot && (
              <div className="folder-list-item" onClick={navigateUp}>
                <span className="folder-list-icon">{'\u2B06'}</span>
                <span>..</span>
              </div>
            )}
            {folders.map(sf => (
              <div
                key={sf.path}
                className="folder-list-item"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                onClick={() => setBrowsingPath(sf.path)}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="folder-list-icon">{'\uD83D\uDCC2'}</span>
                  <span>{sf.name}</span>
                </span>
                <button
                  className={`btn ${selectedPath === sf.path ? 'btn-primary' : ''}`}
                  onClick={(e) => { e.stopPropagation(); setSelectedPath(sf.path) }}
                  style={{ padding: '2px 10px', fontSize: 11 }}
                >
                  {selectedPath === sf.path ? '\u2713 Selected' : 'Select'}
                </button>
              </div>
            ))}
            {folders.length === 0 && (
              <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                No subfolders found
              </div>
            )}
          </div>
        )}

        {/* Select current browsing path */}
        <button
          className={`btn ${selectedPath === browsingPath ? 'btn-primary' : ''}`}
          onClick={() => setSelectedPath(browsingPath)}
          style={{ width: '100%' }}
        >
          {selectedPath === browsingPath
            ? `\u2713 Using ${browsingPath.replace(/^.*[\\/]/, '') || browsingPath}`
            : `Select current: ${browsingPath.replace(/^.*[\\/]/, '') || browsingPath}`
          }
        </button>
      </div>
    </div>,

    // Step 3: What You'll Unlock
    <div key="unlock" className="welcome-wizard-step">
      <h2 className="welcome-wizard-title">What you will unlock</h2>
      <div className="welcome-features">
        {[
          { icon: '\uD83E\uDD16', title: 'Agents', desc: 'Reusable AI personalities you assign to any project.' },
          { icon: '\u26A1', title: 'Skills', desc: 'Slash commands that encode your best workflows.' },
          { icon: '\uD83D\uDCDA', title: 'Lessons', desc: 'Step-by-step guides that teach agents complex tasks.' },
          { icon: '\uD83E\uDDE0', title: 'Knowledge Bases', desc: 'Persistent domain expertise for your agents.' }
        ].map(item => (
          <div key={item.title} className="welcome-feature">
            <div className="welcome-feature-icon">{item.icon}</div>
            <div>
              <strong>{item.title}</strong> — {item.desc}
            </div>
          </div>
        ))}
      </div>
    </div>,

    // Step 4: Let's Go!
    <div key="go" className="welcome-wizard-step" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>{'\uD83D\uDE80'}</div>
      <h2 className="welcome-wizard-title">Ready to begin!</h2>
      <p className="welcome-wizard-desc">
        {selectedPath
          ? `Starting with: ${selectedPath.replace(/^.*[\\/]/, '')}`
          : 'You can add folders anytime from the sidebar.'}
      </p>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
        Level 1 · Novice · 0 / 150 XP to next level
      </p>
      <button
        className="btn btn-primary"
        onClick={handleFinish}
        style={{ width: '100%', padding: '12px', fontSize: 15, marginTop: 24 }}
      >
        Launch OrcStrator {'\u2192'}
      </button>
    </div>
  ]

  const canAdvance = step === 1 ? true : true // folder selection is optional
  const isLast = step === steps.length - 1

  return (
    <div className={`welcome-overlay ${exiting ? 'exiting' : ''}`}>
      <div className="welcome-card welcome-card-wide">
        {steps[step]}

        {/* Step dots + navigation */}
        {!isLast && (
          <div className="welcome-nav">
            {step > 0 && (
              <button className="btn" onClick={() => setStep(s => s - 1)}>
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
            >
              Next
            </button>
          </div>
        )}

        <div className="welcome-step-title">
          {['Welcome', 'Select Folder', 'Features', 'Launch'][step]}
          {' \u00B7 '}Step {step + 1} of {steps.length}
        </div>
      </div>
    </div>
  )
}
