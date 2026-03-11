import { useState, useEffect, useCallback, useRef } from 'react'
import { useGame } from '../../context/GameContext'
import { useFontSize } from '../../hooks/useFontSize'

interface TourStep {
  targetId: string
  title: string
  description: string
}

const STEPS: TourStep[] = [
  { targetId: 'tour-projects', title: 'Your Projects', description: 'All your Claude Code projects live here.' },
  { targetId: 'tour-add-project', title: 'Add Project', description: 'Add an existing project, or create a brand new one from scratch.' },
  { targetId: 'tour-chat', title: 'Chat', description: 'Talk to Claude here. Every message earns XP.' },
  { targetId: 'tour-blackbox', title: 'The Black Box', description: 'See raw commands and output.' },
  { targetId: 'tour-pipeline', title: 'Pipeline', description: 'Kanban board for task management.' },
  { targetId: 'tour-stats', title: 'Your Stats', description: 'XP, level, usage — tracked here.' },
  { targetId: 'tour-game', title: 'Game Mode', description: 'Toggle the RPG battle view.' },
  { targetId: 'tour-settings', title: 'Settings', description: 'Configure agents, models, and more.' },
]

export function GuidedTour() {
  const { tour, completeStep, addXp } = useGame()
  const { zoom } = useFontSize()
  const [currentStep, setCurrentStep] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)

  const isComplete = tour?.completedSteps?.includes('guided-tour-complete')
  const shouldShow = tour?.onboardingComplete && !isComplete

  const updateRect = useCallback(() => {
    if (!shouldShow || currentStep >= STEPS.length) return
    const el = document.querySelector(`[data-tour-id="${STEPS[currentStep].targetId}"]`)
    if (el) {
      setRect(el.getBoundingClientRect())
    } else {
      setRect(null)
    }
  }, [currentStep, shouldShow])

  useEffect(() => {
    updateRect()
    window.addEventListener('resize', updateRect)
    window.addEventListener('scroll', updateRect, true)
    return () => {
      window.removeEventListener('resize', updateRect)
      window.removeEventListener('scroll', updateRect, true)
    }
  }, [updateRect])

  // Auto-skip steps whose target element doesn't exist in the DOM
  useEffect(() => {
    if (!shouldShow || currentStep >= STEPS.length) return
    const el = document.querySelector(`[data-tour-id="${STEPS[currentStep].targetId}"]`)
    if (!el) {
      // Target missing — skip forward (still award XP)
      addXp('tour-step').catch(() => {})
      if (currentStep < STEPS.length - 1) {
        setCurrentStep(s => s + 1)
      } else {
        completeStep('guided-tour-complete')
      }
    }
  }, [currentStep, shouldShow, addXp, completeStep])

  useEffect(() => {
    if (!rect) return
    const el = document.querySelector(`[data-tour-id="${STEPS[currentStep]?.targetId}"]`)
    if (!el) return
    observerRef.current?.disconnect()
    const obs = new ResizeObserver(() => updateRect())
    obs.observe(el)
    observerRef.current = obs
    return () => obs.disconnect()
  }, [currentStep, rect, updateRect])

  const handleNext = useCallback(async () => {
    try { await addXp('tour-step') } catch {}
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(s => s + 1)
    } else {
      await completeStep('guided-tour-complete')
    }
  }, [currentStep, addXp, completeStep])

  const handleSkip = useCallback(async () => {
    await completeStep('guided-tour-complete')
  }, [completeStep])

  if (!shouldShow || currentStep >= STEPS.length) return null

  const step = STEPS[currentStep]
  const pad = 8
  const tooltipH = 120 // approximate tooltip height

  // When the app has transform: scale(zoom), getBoundingClientRect() returns
  // viewport coords but CSS positioning inside the transform uses local coords.
  // Divide all viewport values by zoom to get the local coordinate space.
  const z = zoom || 1
  const vpW = window.innerWidth / z
  const vpH = window.innerHeight / z

  // Clamp the highlight rect to the visible viewport (in local coords)
  const visRect = rect ? {
    left: rect.left / z,
    top: Math.max(0, rect.top / z),
    width: rect.width / z,
    height: Math.min(rect.bottom / z, vpH) - Math.max(0, rect.top / z),
    bottom: Math.min(rect.bottom / z, vpH),
    right: rect.right / z,
  } : null

  // Smart tooltip position: prefer below, fall back to above, then beside
  let tooltipTop = 0
  let tooltipLeft = 0
  if (visRect) {
    tooltipLeft = Math.max(12, Math.min(visRect.left, vpW - 320))

    if (visRect.bottom + pad + tooltipH < vpH) {
      // Fits below the target
      tooltipTop = visRect.bottom + pad + 8
    } else if (visRect.top - tooltipH - pad > 0) {
      // Fits above the target
      tooltipTop = visRect.top - tooltipH - pad
    } else {
      // Place beside the target, vertically centered
      tooltipTop = Math.max(12, visRect.top + (visRect.height - tooltipH) / 2)
      tooltipLeft = Math.max(12, visRect.left + visRect.width + pad + 8)
      if (tooltipLeft + 300 > vpW) {
        tooltipLeft = Math.max(12, visRect.left - 300 - pad - 8)
      }
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10000, pointerEvents: 'none' }}>
      {/* Dark overlay with cutout */}
      {visRect && (
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'auto' }}>
          <defs>
            <mask id="tour-mask">
              <rect width="100%" height="100%" fill="white" />
              <rect
                x={visRect.left - pad} y={visRect.top - pad}
                width={visRect.width + pad * 2} height={visRect.height + pad * 2}
                rx={8} fill="black"
              />
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="rgba(0,0,0,0.6)" mask="url(#tour-mask)" />
        </svg>
      )}

      {/* Tooltip */}
      {visRect && (
        <div
          style={{
            position: 'absolute',
            top: tooltipTop,
            left: tooltipLeft,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '14px 18px',
            maxWidth: 300,
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            pointerEvents: 'auto',
            zIndex: 10001,
          }}
        >
          <div style={{ fontFamily: 'var(--font-pixel)', fontSize: 11, color: 'var(--accent-text)', marginBottom: 6 }}>
            {step.title}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-primary)', marginBottom: 14, lineHeight: 1.5 }}>
            {step.description}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
              {currentStep + 1} / {STEPS.length}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={handleSkip} style={{ fontSize: 13, padding: '6px 12px' }}>
                Skip Tour
              </button>
              <button className="btn btn-primary" onClick={handleNext} style={{ fontSize: 13, padding: '6px 12px' }}>
                {currentStep === STEPS.length - 1 ? 'Done' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
