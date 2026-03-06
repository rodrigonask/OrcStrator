import { useEffect, useRef } from 'react'
import { Application, Container, Graphics, Sprite, Text } from 'pixi.js'
import { SpriteManager } from './SpriteManager'
import { useInstances } from '../../context/InstancesContext'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { usePipeline } from '../../context/PipelineContext'
import { useUI } from '../../context/UIContext'
import { api } from '../../api'
import { GAME_W, GAME_H, LEFT_ZONE, CENTER_ZONE, RIGHT_ZONE } from './constants'
import { buildAgentPanel } from './AgentPanel'
import { MonsterPanel } from './monsterPanel'
import { AttackAnimator, getCharacterCenter } from './attackAnimator'
import { burst } from './particles'
import type { InstanceConfig, FolderConfig, PipelineTask } from '@shared/types'

export function GameScreen() {
  const containerRef        = useRef<HTMLDivElement>(null)
  const appRef              = useRef<Application | null>(null)
  const panelRef            = useRef<Container | null>(null)
  const monsterPanelRef     = useRef<MonsterPanel | null>(null)
  const attackAnimatorRef   = useRef<AttackAnimator | null>(null)
  const prevTasksRef        = useRef<PipelineTask[]>([])

  const { tasks } = usePipeline()

  // Keep latest instances/folders in refs so the async init callback can access them
  const { instances, folders } = useInstances()
  const instancesRef = useRef<InstanceConfig[]>(instances)
  const foldersRef   = useRef<FolderConfig[]>(folders)
  useEffect(() => { instancesRef.current = instances }, [instances])
  useEffect(() => { foldersRef.current   = folders   }, [folders])

  const { dispatch } = useAppDispatch()
  const dispatchRef  = useRef(dispatch)
  useEffect(() => { dispatchRef.current = dispatch }, [dispatch])

  const { settings } = useUI()
  const settingsRef = useRef(settings)
  useEffect(() => { settingsRef.current = settings }, [settings])

  // Effect 1: Initialize PixiJS Application (runs once)
  useEffect(() => {
    if (!containerRef.current) return

    let cancelled = false
    const app = new Application()
    appRef.current = app

    app.init({
      width: GAME_W,
      height: GAME_H,
      background: 0x0d0d1a,
      antialias: true,
    }).catch((err) => {
      console.warn('[GameScreen] PixiJS init failed (HMR/StrictMode):', err.message)
    }).then(() => {
      if (!app.canvas) return // init failed
      if (cancelled || !containerRef.current) return

      const canvas = app.canvas as HTMLCanvasElement
      canvas.style.width  = '100%'
      canvas.style.height = '100%'
      containerRef.current.appendChild(canvas)

      // Enable root stage events
      app.stage.eventMode = 'static'
      app.stage.hitArea   = app.screen

      const stage = new Container()
      app.stage.addChild(stage)

      // Fallback solid-color zone backgrounds (replaced once battlefield texture loads)
      const fallbackBg = new Container()
      stage.addChild(fallbackBg)

      const leftBg = new Graphics()
      leftBg.rect(LEFT_ZONE.x, 0, LEFT_ZONE.w, GAME_H)
      leftBg.fill({ color: 0x1a1a2e })
      fallbackBg.addChild(leftBg)

      const centerBg = new Graphics()
      centerBg.rect(CENTER_ZONE.x, 0, CENTER_ZONE.w, GAME_H)
      centerBg.fill({ color: 0x0d0d1a })
      fallbackBg.addChild(centerBg)

      const rightBg = new Graphics()
      rightBg.rect(RIGHT_ZONE.x, 0, RIGHT_ZONE.w, GAME_H)
      rightBg.fill({ color: 0x1a2e1a })
      fallbackBg.addChild(rightBg)

      // Dark overlays for readability (rendered above background, below game elements)
      const overlays = new Container()
      stage.addChild(overlays)

      const leftOverlay = new Graphics()
      leftOverlay.rect(LEFT_ZONE.x, 0, LEFT_ZONE.w, GAME_H)
      leftOverlay.fill({ color: 0x000000, alpha: 0.4 })
      overlays.addChild(leftOverlay)

      const rightOverlay = new Graphics()
      rightOverlay.rect(RIGHT_ZONE.x, 0, RIGHT_ZONE.w, GAME_H)
      rightOverlay.fill({ color: 0x000000, alpha: 0.4 })
      overlays.addChild(rightOverlay)

      const centerOverlay = new Graphics()
      centerOverlay.rect(CENTER_ZONE.x, 0, CENTER_ZONE.w, GAME_H)
      centerOverlay.fill({ color: 0x000000, alpha: 0.2 })
      overlays.addChild(centerOverlay)

      // Semi-transparent vertical dividers
      const divLeft = new Graphics()
      divLeft.rect(LEFT_ZONE.x + LEFT_ZONE.w, 0, 1, GAME_H)
      divLeft.fill({ color: 0x2a2a4a, alpha: 0.3 })
      overlays.addChild(divLeft)

      const divRight = new Graphics()
      divRight.rect(RIGHT_ZONE.x, 0, 1, GAME_H)
      divRight.fill({ color: 0x2a2a4a, alpha: 0.3 })
      overlays.addChild(divRight)

      // Load sprite sheets + battlefield background
      SpriteManager.load().then(() => {
        if (cancelled) return
        const bgTex = SpriteManager.getTexture('battlefield')
        if (bgTex) {
          const bgSprite = new Sprite(bgTex)
          bgSprite.width  = GAME_W
          bgSprite.height = GAME_H
          // Insert at index 0 of stage (behind everything) and remove fallback
          stage.addChildAt(bgSprite, 0)
          fallbackBg.destroy({ children: true })
        }
      }).catch(err =>
        console.warn('[GameScreen] Sprite sheet load failed:', err.message)
      )

      // CENTER_ZONE title
      const title = new Text({
        text: 'ORCSTRATOR',
        style: {
          fontFamily: 'monospace',
          fontSize: 28,
          fill: 0x7c9fcc,
          letterSpacing: 6,
          align: 'center',
        },
      })
      title.anchor.set(0.5, 0.5)
      title.x = 700
      title.y = 310
      stage.addChild(title)

      const subtitle = new Text({
        text: 'agents assemble. monsters await.',
        style: {
          fontFamily: 'monospace',
          fontSize: 12,
          fill: 0x4a6a8a,
          align: 'center',
        },
      })
      subtitle.anchor.set(0.5, 0.5)
      subtitle.x = 700
      subtitle.y = 360
      stage.addChild(subtitle)

      // Agent panel container (LEFT_ZONE layer — sits above background)
      const panelContainer = new Container()
      stage.addChild(panelContainer)
      panelRef.current = panelContainer

      // Build panel with whatever instances/folders are available right now
      const onInstanceClick = (id: string) => {
        dispatchRef.current({ type: 'SELECT_INSTANCE', payload: id })
        dispatchRef.current({ type: 'SET_VIEW', payload: 'chat' })
      }
      buildAgentPanel(panelContainer, instancesRef.current, foldersRef.current, onInstanceClick)

      // Monster panel in RIGHT_ZONE
      const monsterPanel = new MonsterPanel(stage, app, RIGHT_ZONE)
      monsterPanelRef.current = monsterPanel

      // Attack animator — projectile layer sits on top of everything
      const animator = new AttackAnimator(stage, app)
      attackAnimatorRef.current = animator
    })

    return () => {
      cancelled = true
      attackAnimatorRef.current?.destroy()
      attackAnimatorRef.current = null
      monsterPanelRef.current?.destroy()
      monsterPanelRef.current = null
      try { app.destroy(true) } catch { /* PixiJS may throw if init never completed */ }
      appRef.current   = null
      panelRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Effect 2: Diff tasks, fire attack animations, then update monster panel
  useEffect(() => {
    const panel    = monsterPanelRef.current
    const animator = attackAnimatorRef.current
    const app      = appRef.current

    if (panel && animator && app && prevTasksRef.current.length > 0) {
      for (const task of tasks) {
        const old = prevTasksRef.current.find(t => t.id === task.id)
        if (!old || old.column === task.column) continue
        if (!task.lockedBy) continue   // only animate agent-driven moves

        const inst = instancesRef.current.find(i => i.id === task.lockedBy)
        const role = inst?.agentRole ?? 'default'
        const from = getCharacterCenter(task.lockedBy!, instancesRef.current, foldersRef.current)
        const to   = panel.getMonsterCenter(task.id)
        if (!from || !to) continue

        animator.fire(from, to, role, () => {
          panel.triggerHit(task.id, app, role)
        })
      }
    }

    prevTasksRef.current = tasks
    panel?.update(tasks)
  }, [tasks])

  // Effect 3: Rebuild agent panel whenever instances or folders change
  useEffect(() => {
    if (!panelRef.current) return
    const onInstanceClick = (id: string) => {
      dispatchRef.current({ type: 'SELECT_INSTANCE', payload: id })
      dispatchRef.current({ type: 'SET_VIEW', payload: 'chat' })
    }
    buildAgentPanel(panelRef.current, instances, folders, onInstanceClick)
  }, [instances, folders])

  // Effect 4: Level-up animation on instance:levelup WS event
  useEffect(() => {
    const unsub = api.onInstanceLevelUp((payload: { instanceId: string; newLevel: number }) => {
      const app   = appRef.current
      const stage = app?.stage?.children[0] as Container | undefined
      if (!app || !stage) return

      const pos = getCharacterCenter(payload.instanceId, instancesRef.current, foldersRef.current)
      if (!pos) return

      // Gold particle burst
      burst(stage, pos.x, pos.y, 0xffd700, 12, app)

      // Floating "LEVEL UP!" text
      const lvlUpText = new Text({
        text: 'LEVEL UP!',
        style: { fontFamily: 'monospace', fontSize: 14, fill: 0xffd700, fontWeight: 'bold' },
      })
      lvlUpText.anchor.set(0.5, 0.5)
      lvlUpText.x = pos.x
      lvlUpText.y = pos.y - 20
      stage.addChild(lvlUpText)

      const start = Date.now()
      const tick = () => {
        const t = Math.min((Date.now() - start) / 1500, 1)
        lvlUpText.y = pos.y - 20 - t * 40
        lvlUpText.alpha = 1 - t
        if (t >= 1) {
          app.ticker.remove(tick)
          stage.removeChild(lvlUpText)
          lvlUpText.destroy()
        }
      }
      app.ticker.add(tick)

      // Optional ascending tone
      if (settingsRef.current.soundsEnabled === true) {
        try {
          const actx = new AudioContext()
          const osc = actx.createOscillator()
          const gain = actx.createGain()
          osc.connect(gain).connect(actx.destination)
          osc.frequency.setValueAtTime(440, actx.currentTime)
          osc.frequency.linearRampToValueAtTime(880, actx.currentTime + 0.3)
          gain.gain.setValueAtTime(0.15, actx.currentTime)
          gain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.4)
          osc.start()
          osc.stop(actx.currentTime + 0.4)
        } catch { /* audio not available */ }
      }
    })
    return unsub
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', minHeight: 500 }}
    />
  )
}
