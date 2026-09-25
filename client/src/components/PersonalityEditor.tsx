import { useState } from 'react'
import type { AgentPersonality } from '@shared/types'

const MBTI_PAIRS: Array<[string, string]> = [['E', 'I'], ['S', 'N'], ['T', 'F'], ['J', 'P']]
const TONE_OPTIONS: Array<AgentPersonality['tone']> = ['formal', 'casual', 'playful', 'technical']

interface Props {
  personality: AgentPersonality | null | undefined
  onSave: (personality: AgentPersonality) => void
}

export function PersonalityEditor({ personality, onSave }: Props) {
  const [collapsed, setCollapsed] = useState(true)
  const [disc, setDisc] = useState(personality?.disc || { D: 50, I: 50, S: 50, C: 50 })
  const [mbti, setMbti] = useState(personality?.mbti || 'INTJ')
  const [big5, setBig5] = useState(personality?.big5 || { O: 50, C: 50, E: 50, A: 50, N: 50 })
  const [tone, setTone] = useState<AgentPersonality['tone']>(personality?.tone || 'technical')

  const save = () => {
    onSave({ disc, mbti, big5, tone })
  }

  const mbtiLetters = mbti.split('')

  return (
    <div className="personality-editor">
      <button
        className="personality-toggle"
        onClick={() => setCollapsed(c => !c)}
      >
        <span className="font-mono" style={{ fontSize: '11px' }}>
          {collapsed ? '▶' : '▼'} Personality Profile
        </span>
      </button>

      {!collapsed && (
        <div className="personality-content">
          {/* DISC */}
          <div className="personality-section">
            <div className="personality-section-title font-mono">DISC</div>
            {(['D', 'I', 'S', 'C'] as const).map(key => (
              <div key={key} className="personality-slider-row">
                <label className="personality-slider-label font-mono">{key}</label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={disc[key]}
                  onChange={e => setDisc(d => ({ ...d, [key]: Number(e.target.value) }))}
                  className="personality-slider"
                />
                <span className="personality-slider-value font-mono">{disc[key]}</span>
              </div>
            ))}
          </div>

          {/* MBTI */}
          <div className="personality-section">
            <div className="personality-section-title font-mono">MBTI</div>
            <div className="mbti-toggles">
              {MBTI_PAIRS.map(([a, b], idx) => (
                <div key={idx} className="mbti-pair">
                  <button
                    className={`mbti-btn ${mbtiLetters[idx] === a ? 'active' : ''}`}
                    onClick={() => {
                      const letters = [...mbtiLetters]
                      letters[idx] = a
                      setMbti(letters.join(''))
                    }}
                  >
                    {a}
                  </button>
                  <button
                    className={`mbti-btn ${mbtiLetters[idx] === b ? 'active' : ''}`}
                    onClick={() => {
                      const letters = [...mbtiLetters]
                      letters[idx] = b
                      setMbti(letters.join(''))
                    }}
                  >
                    {b}
                  </button>
                </div>
              ))}
              <span className="mbti-result font-mono">{mbti}</span>
            </div>
          </div>

          {/* Big 5 (OCEAN) */}
          <div className="personality-section">
            <div className="personality-section-title font-mono">Big Five (OCEAN)</div>
            {([
              ['O', 'Openness'],
              ['C', 'Conscientiousness'],
              ['E', 'Extraversion'],
              ['A', 'Agreeableness'],
              ['N', 'Neuroticism'],
            ] as const).map(([key, label]) => (
              <div key={key} className="personality-slider-row">
                <label className="personality-slider-label font-mono" title={label}>{key}</label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={big5[key]}
                  onChange={e => setBig5(b => ({ ...b, [key]: Number(e.target.value) }))}
                  className="personality-slider"
                />
                <span className="personality-slider-value font-mono">{big5[key]}</span>
              </div>
            ))}
          </div>

          {/* Tone */}
          <div className="personality-section">
            <div className="personality-section-title font-mono">Tone</div>
            <div className="tone-options">
              {TONE_OPTIONS.map(t => (
                <button
                  key={t}
                  className={`tone-btn ${tone === t ? 'active' : ''}`}
                  onClick={() => setTone(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <button className="personality-save-btn" onClick={save}>
            Save Personality
          </button>
        </div>
      )}
    </div>
  )
}

export function personalitySummary(p: AgentPersonality | null | undefined): string {
  if (!p) return ''
  const parts: string[] = []
  if (p.mbti) parts.push(p.mbti)
  if (p.tone) parts.push(p.tone)
  if (p.disc) {
    const top = (Object.entries(p.disc) as Array<[string, number]>)
      .sort((a, b) => b[1] - a[1])[0]
    if (top[1] > 60) {
      const labels: Record<string, string> = { D: 'Dominant', I: 'Influential', S: 'Steady', C: 'Conscientious' }
      parts.push(labels[top[0]] || top[0])
    }
  }
  return parts.join(' · ')
}
