import { useEffect, useRef } from 'react'
import { Application, Container, Graphics, Sprite, Text } from 'pixi.js'
import { SpriteManager } from './SpriteManager'
import { useInstances } from '../../context/InstancesContext'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { usePipeline } from '../../context/PipelineContext'
import { GAME_W, GAME_H, LEFT_ZONE, CENTER_ZONE, RIGHT_ZONE } from './constants'
import { buildAgentPanel } from './AgentPanel'
import { MonsterPanel } from './monsterPanel'
import { AttackAnimator, getCharacterCenter } from './attackAnimator'
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

      // Load sprite sheets (non-blocking — panels use Graphics until later tasks swap to sprites)
      SpriteManager.load().catch(err =>
        console.warn('[GameScreen] Sprite sheet load failed:', err.message)
      )

      // Enable root stage events
      app.stage.eventMode = 'static'
      app.stage.hitArea   = app.screen

      const stage = new Container()
      app.stage.addChild(stage)

      // Zone backgrounds
      const leftBg = new Graphics()
      leftBg.rect(LEFT_ZONE.x, 0, LEFT_ZONE.w, GAME_H)
      leftBg.fill({ color: 0x1a1a2e })
      stage.addChild(leftBg)

      const centerBg = new Graphics()
      centerBg.rect(CENTER_ZONE.x, 0, CENTER_ZONE.w, GAME_H)
      centerBg.fill({ color: 0x0d0d1a })
      stage.addChild(centerBg)

      const rightBg = new Graphics()
      rightBg.rect(RIGHT_ZONE.x, 0, RIGHT_ZONE.w, GAME_H)
      rightBg.fill({ color: 0x1a2e1a })
      stage.addChild(rightBg)

      // Vertical dividers
      const divLeft = new Graphics()
      divLeft.rect(LEFT_ZONE.x + LEFT_ZONE.w, 0, 1, GAME_H)
      divLeft.fill({ color: 0x2a2a4a })
      stage.addChild(divLeft)

      const divRight = new Graphics()
      divRight.rect(RIGHT_ZONE.x, 0, 1, GAME_H)
      divRight.fill({ color: 0x2a2a4a })
      stage.addChild(divRight)

      // CENTER_ZONE title
      const title = new Text({
        text: 'NASKLAUDE',
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

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', minHeight: 500 }}
    />
  )
}
