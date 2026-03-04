import { useEffect, useState, useMemo } from 'react'
import { LEVELS } from '@shared/constants'

interface LevelUpAnimationProps {
  level: number
  onComplete: () => void
}

interface Particle {
  id: number
  x: number
  y: number
  dx: number
  dy: number
  color: string
}

const PARTICLE_COLORS = ['#7c3aed', '#a78bfa', '#8b5cf6', '#6d28d9', '#c4b5fd', '#10b981', '#f59e0b']

export function LevelUpAnimation({ level, onComplete }: LevelUpAnimationProps) {
  const [visible, setVisible] = useState(true)

  const levelData = LEVELS.find(l => l.level === level) || LEVELS[0]

  const particles: Particle[] = useMemo(() => {
    return Array.from({ length: 30 }, (_, i) => ({
      id: i,
      x: 50 + (Math.random() - 0.5) * 20,
      y: 50 + (Math.random() - 0.5) * 20,
      dx: (Math.random() - 0.5) * 400,
      dy: -100 - Math.random() * 300,
      color: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
    }))
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false)
      setTimeout(onComplete, 300)
    }, 3000)
    return () => clearTimeout(timer)
  }, [onComplete])

  const handleClick = () => {
    setVisible(false)
    setTimeout(onComplete, 300)
  }

  if (!visible) return null

  return (
    <div className="level-up-overlay" onClick={handleClick}>
      <div className="level-up-particles">
        {particles.map(p => (
          <div
            key={p.id}
            className="level-up-particle"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              backgroundColor: p.color,
              '--dx': `${p.dx}px`,
              '--dy': `${p.dy}px`,
              animationDelay: `${Math.random() * 0.5}s`,
            } as React.CSSProperties}
          />
        ))}
      </div>
      <div className="level-up-content">
        <div className="level-up-badge">Lv.{level}</div>
        <div className="level-up-title">Level Up!</div>
        <div className="level-up-subtitle">
          You are now a {levelData.name}
        </div>
      </div>
    </div>
  )
}
