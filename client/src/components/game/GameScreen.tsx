import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Application, Container, Graphics, Sprite, Text } from 'pixi.js'
import { SpriteManager } from './SpriteManager'
import { useInstances } from '../../context/InstancesContext'
import { useAppDispatch } from '../../context/AppDispatchContext'
import { useUI } from '../../context/UIContext'
import { api } from '../../api'
import { GAME_W, GAME_H, IDLE_ZONE, ACTIVE_ZONE } from './constants'
import type { GameDisplayMode } from './constants'
import { buildIdlePanel, buildActivePanel } from './AgentPanel'
import { MonsterPanel } from './monsterPanel'
import { GameDashboard } from './GameDashboard'
import { AttackAnimator, getCharacterCenter } from './attackAnimator'
import { burst } from './particles'
import type { InstanceConfig, FolderConfig, PipelineTask } from '@shared/types'

export function GameScreen() {
  const containerRef        = useRef<HTMLDivElement>(null)
  const appRef              = useRef<Application | null>(null)
  const idlePanelRef        = useRef<Container | null>(null)
  const activePanelRef      = useRef<Container | null>(null)
  const monsterPanelRef     = useRef<MonsterPanel | null>(null)
  const attackAnimatorRef   = useRef<AttackAnimator | null>(null)
  const prevTasksRef        = useRef<PipelineTask[]>([])
  const activeIdsRef        = useRef<Set<string>>(new Set())
  const idleLabelRef        = useRef<{ bg: Graphics; text: Text } | null>(null)
  const activeLabelRef      = useRef<{ bg: Graphics; text: Text } | null>(null)

  const [spritesReady, setSpritesReady] = useState(SpriteManager.isReady())
  const [gameActive, setGameActive]     = useState<boolean>(() => {
    try { return localStorage.getItem('nasklaude.gameActive') === 'true' } catch { return false }
  })
  const [displayMode, setDisplayMode]   = useState<GameDisplayMode>(() => {
    try { return (localStorage.getItem('nasklaude.displayMode') as GameDisplayMode) || 'both' } catch { return 'both' }
  })
  const displayModeRef = useRef(displayMode)
  useEffect(() => { displayModeRef.current = displayMode }, [displayMode])

  // Fetch ALL pipeline tasks across all projects (unified game view)
  const [tasks, setTasks] = useState<PipelineTask[]>([])
  const fetchAllTasks = useCallback(async () => {
    try {
      const data = await api.getPipelines()
      const all = Object.values(data).flat()
      setTasks(all)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchAllTasks()
    // Re-fetch on any pipeline WS event
    const unsub = api.onPipelineUpdated(() => { fetchAllTasks() })
    return unsub
  }, [fetchAllTasks])

  const { instances, folders } = useInstances()
  const instancesRef = useRef<InstanceConfig[]>(instances)
  const foldersRef   = useRef<FolderConfig[]>(folders)
  useEffect(() => { instancesRef.current = instances }, [instances])
  useEffect(() => { foldersRef.current   = folders   }, [folders])

  // Only show tasks/instances from expanded (open) folders in the sidebar
  const expandedFolderIds = useMemo(
    () => new Set(folders.filter(f => f.expanded).map(f => f.id)),
    [folders]
  )
  const visibleTasks     = useMemo(() => tasks.filter(t => expandedFolderIds.has(t.projectId)),     [tasks, expandedFolderIds])
  const visibleInstances = useMemo(() => instances.filter(i => expandedFolderIds.has(i.folderId)), [instances, expandedFolderIds])

  const { dispatch } = useAppDispatch()
  const dispatchRef  = useRef(dispatch)
  useEffect(() => { dispatchRef.current = dispatch }, [dispatch])

  const { settings } = useUI()
  const settingsRef = useRef(settings)
  useEffect(() => { settingsRef.current = settings }, [settings])

  const tasksRef = useRef<PipelineTask[]>(visibleTasks)
  useEffect(() => { tasksRef.current = visibleTasks }, [visibleTasks])

  // Helper: compute active instance IDs — running instances are active
  function computeActiveIds(instanceList: InstanceConfig[]): Set<string> {
    const ids = new Set<string>()
    for (const i of instanceList) {
      if (i.state === 'running') ids.add(i.id)
    }
    return ids
  }

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
      if (!app.canvas) return
      if (cancelled || !containerRef.current) return

      const canvas = app.canvas as HTMLCanvasElement
      canvas.style.width  = '100%'
      canvas.style.height = '100%'
      containerRef.current.appendChild(canvas)

      app.stage.eventMode = 'static'
      app.stage.hitArea   = app.screen

      const stage = new Container()
      app.stage.addChild(stage)

      // Fallback dark background (replaced by battlefield texture once loaded)
      const fallbackBg = new Graphics()
      fallbackBg.rect(0, 0, GAME_W, GAME_H)
      fallbackBg.fill({ color: 0x0d0d1a })
      stage.addChild(fallbackBg)

      // Agent panels
      const idleContainer = new Container()
      stage.addChild(idleContainer)
      idlePanelRef.current = idleContainer

      const activeContainer = new Container()
      stage.addChild(activeContainer)
      activePanelRef.current = activeContainer

      const onInstanceClick = (id: string) => {
        dispatchRef.current({ type: 'SELECT_INSTANCE', payload: id })
        dispatchRef.current({ type: 'SET_VIEW', payload: 'chat' })
      }

      // Monster panel (battle + queue zones)
      const monsterPanel = new MonsterPanel(stage, app)
      monsterPanelRef.current = monsterPanel

      // Attack animator
      const animator = new AttackAnimator(stage, app)
      attackAnimatorRef.current = animator

      // Load sprite sheets, then build panels with real sprites
      SpriteManager.load().then(() => {
        if (cancelled) return
        const bgTex = SpriteManager.getTexture('battlefield')
        if (bgTex) {
          const bgSprite = new Sprite(bgTex)
          bgSprite.width  = GAME_W
          bgSprite.height = GAME_H
          stage.addChildAt(bgSprite, 0)
          stage.removeChild(fallbackBg)
          fallbackBg.destroy()
        }

        // Overlay container: dim + zone color panels + dividers + vignettes
        // Inserted at index 1 so it sits above bgSprite (0) but below character containers
        const overlayContainer = new Graphics()
        // Dark dim overlay
        overlayContainer.rect(0, 0, GAME_W, GAME_H)
        overlayContainer.fill({ color: 0x050510, alpha: 0.58 })
        // Zone color panels
        overlayContainer.rect(0, 0, 350, GAME_H)
        overlayContainer.fill({ color: 0x1e3a8a, alpha: 0.18 })
        overlayContainer.rect(350, 0, 350, GAME_H)
        overlayContainer.fill({ color: 0x14532d, alpha: 0.18 })
        overlayContainer.rect(700, 0, 350, GAME_H)
        overlayContainer.fill({ color: 0x78350f, alpha: 0.22 })
        overlayContainer.rect(1050, 0, 350, GAME_H)
        overlayContainer.fill({ color: 0x3b0764, alpha: 0.18 })
        // Vertical zone dividers
        overlayContainer.moveTo(350, 0).lineTo(350, GAME_H)
        overlayContainer.stroke({ color: 0xffffff, alpha: 0.08, width: 1 })
        overlayContainer.moveTo(700, 0).lineTo(700, GAME_H)
        overlayContainer.stroke({ color: 0xffffff, alpha: 0.08, width: 1 })
        overlayContainer.moveTo(1050, 0).lineTo(1050, GAME_H)
        overlayContainer.stroke({ color: 0xffffff, alpha: 0.08, width: 1 })
        // Vignettes
        overlayContainer.rect(0, 0, 60, GAME_H)
        overlayContainer.fill({ color: 0x000000, alpha: 0.3 })
        overlayContainer.rect(GAME_W - 60, 0, 60, GAME_H)
        overlayContainer.fill({ color: 0x000000, alpha: 0.3 })
        overlayContainer.rect(0, 0, GAME_W, 30)
        overlayContainer.fill({ color: 0x000000, alpha: 0.25 })
        overlayContainer.rect(0, GAME_H - 40, GAME_W, 40)
        overlayContainer.fill({ color: 0x000000, alpha: 0.3 })
        stage.addChildAt(overlayContainer, 1)

        // Dynamic IDLE / ACTIVE zone labels (FIGHTING/QUEUED handled by MonsterPanel)
        const LABEL_W = 110, LABEL_H = 20, LABEL_Y = 3
        ;[
          { zone: IDLE_ZONE,   ref: idleLabelRef,   label: 'IDLE'   },
          { zone: ACTIVE_ZONE, ref: activeLabelRef,  label: 'ACTIVE' },
        ].forEach(({ zone, ref, label }) => {
          const bg = new Graphics()
          bg.roundRect(zone.x + zone.w / 2 - LABEL_W / 2, LABEL_Y, LABEL_W, LABEL_H, 5)
          bg.fill({ color: 0x000000, alpha: 0.55 })
          stage.addChild(bg)
          const txt = new Text({ text: label, style: { fontFamily: 'monospace', fontSize: 12, fill: 0x8899cc, fontWeight: 'bold' } })
          txt.anchor.set(0.5, 0)
          txt.x = zone.x + zone.w / 2
          txt.y = LABEL_Y + 4
          stage.addChild(txt)
          ref.current = { bg, text: txt }
        })

        // Rebuild agent panels with real sprites
        const ids = computeActiveIds(instancesRef.current)
        activeIdsRef.current = ids
        const idle  = instancesRef.current.filter(i => !ids.has(i.id))
        const active = instancesRef.current.filter(i => ids.has(i.id))
        buildIdlePanel(idleContainer, idle, onInstanceClick)
        buildActivePanel(activeContainer, active, onInstanceClick)
        monsterPanel.rebuild()
        monsterPanel.update(tasksRef.current)
        monsterPanel.applyDisplayMode(displayModeRef.current)
        setSpritesReady(true)
      }).catch(err =>
        console.warn('[GameScreen] Sprite sheet load failed:', err.message)
      )
    })

    return () => {
      cancelled = true
      attackAnimatorRef.current?.destroy()
      attackAnimatorRef.current = null
      monsterPanelRef.current?.destroy()
      monsterPanelRef.current = null
      try { app.destroy(true) } catch { /* PixiJS may throw if init never completed */ }
      appRef.current        = null
      idlePanelRef.current  = null
      activePanelRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Effect 2: Diff tasks, fire attack animations, update monsters
  useEffect(() => {
    if (!SpriteManager.isReady()) return
    const panel    = monsterPanelRef.current
    const animator = attackAnimatorRef.current
    const app      = appRef.current

    // Fire attack animations for task column changes
    if (panel && animator && app && prevTasksRef.current.length > 0) {
      const activeIds = activeIdsRef.current
      for (const task of visibleTasks) {
        const old = prevTasksRef.current.find(t => t.id === task.id)
        if (!old || old.column === task.column) continue

        // Find the attacker: lockedBy if set, otherwise find a running agent with matching role
        let attackerId = task.lockedBy
        if (!attackerId) {
          const colRole: Record<string, string> = { spec: 'planner', build: 'builder', qa: 'tester', ship: 'promoter' }
          const role = colRole[task.column]
          if (role) {
            attackerId = instancesRef.current.find(i => i.state === 'running' && i.agentRole === role)?.id
          }
        }
        if (!attackerId) continue

        const inst = instancesRef.current.find(i => i.id === attackerId)
        const role = inst?.agentRole ?? 'default'
        const from = getCharacterCenter(attackerId, activeIds, instancesRef.current)
        const to   = panel.getMonsterCenter(task.id)
        if (!from || !to) continue

        animator.fire(from, to, role, () => {
          panel.triggerHit(task.id, app, role)
        })
      }
    }

    prevTasksRef.current = visibleTasks
    panel?.update(visibleTasks)
    panel?.applyDisplayMode(displayModeRef.current)
  }, [visibleTasks, spritesReady])

  // Effect 3: Rebuild agent panels when instances change (active = running state)
  useEffect(() => {
    if (!idlePanelRef.current || !activePanelRef.current || !SpriteManager.isReady()) return
    const activeIds = computeActiveIds(visibleInstances)
    activeIdsRef.current = activeIds
    const onInstanceClick = (id: string) => {
      dispatchRef.current({ type: 'SELECT_INSTANCE', payload: id })
      dispatchRef.current({ type: 'SET_VIEW', payload: 'chat' })
    }
    const idleInst   = visibleInstances.filter(i => !activeIds.has(i.id))
    const activeInst = visibleInstances.filter(i => activeIds.has(i.id))
    buildIdlePanel(idlePanelRef.current, idleInst, onInstanceClick)
    buildActivePanel(activePanelRef.current, activeInst, onInstanceClick)

    // Update IDLE / ACTIVE zone label counts
    if (idleLabelRef.current) {
      const n = idleInst.length
      idleLabelRef.current.text.text = n > 0 ? `${n} IDLE` : 'IDLE'
      idleLabelRef.current.text.style.fill = n > 0 ? 0xaabbff : 0x8899cc
      idleLabelRef.current.bg.alpha = n > 0 ? 1 : 0.6
    }
    if (activeLabelRef.current) {
      const n = activeInst.length
      activeLabelRef.current.text.text = n > 0 ? `${n} ACTIVE` : 'ACTIVE'
      activeLabelRef.current.text.style.fill = n > 0 ? 0x55ee88 : 0x8899cc
      activeLabelRef.current.bg.alpha = n > 0 ? 1 : 0.6
    }
  }, [visibleInstances, spritesReady])

  // Effect 4: Persist game active state
  useEffect(() => {
    try { localStorage.setItem('nasklaude.gameActive', String(gameActive)) } catch { /* ignore */ }
  }, [gameActive])

  // Effect 5: Persist display mode
  useEffect(() => {
    try { localStorage.setItem('nasklaude.displayMode', displayMode) } catch { /* ignore */ }
  }, [displayMode])

  // Effect 6: Apply display mode to all monsters when it changes
  useEffect(() => {
    monsterPanelRef.current?.applyDisplayMode(displayMode)
  }, [displayMode])

  // Effect 7: Level-up animation on instance:levelup WS event
  useEffect(() => {
    const unsub = api.onInstanceLevelUp((payload: { instanceId: string; newLevel: number }) => {
      const app   = appRef.current
      const stage = app?.stage?.children[0] as Container | undefined
      if (!app || !stage) return

      const pos = getCharacterCenter(payload.instanceId, activeIdsRef.current, instancesRef.current)
      if (!pos) return

      burst(stage, pos.x, pos.y, 0xffd700, 12, app)
      burst(stage, pos.x, pos.y, 0xffffff, 8, app)

      const lvlUpText = new Text({
        text: '✦ LEVEL UP! ✦',
        style: { fontFamily: 'monospace', fontSize: 20, fill: 0xffd700, fontWeight: 'bold' },
      })
      lvlUpText.anchor.set(0.5, 0.5)
      lvlUpText.x = pos.x
      lvlUpText.y = pos.y - 20
      stage.addChild(lvlUpText)

      const start = Date.now()
      const tick = () => {
        const t = Math.min((Date.now() - start) / 2200, 1)
        lvlUpText.y = pos.y - 20 - t * 70
        lvlUpText.alpha = 1 - t
        if (t >= 1) {
          app.ticker.remove(tick)
          stage.removeChild(lvlUpText)
          lvlUpText.destroy()
        }
      }
      app.ticker.add(tick)

      if (settingsRef.current.soundsEnabled !== false) {
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

  const DISPLAY_MODES: { label: string; value: GameDisplayMode }[] = [
    { label: 'Code',   value: 'code'      },
    { label: 'Name',   value: 'name'      },
    { label: 'Both',   value: 'both'      },
    { label: 'Bars',   value: 'bars'      },
    { label: '👁',     value: 'immersive' },
  ]
  const currentModeIdx   = DISPLAY_MODES.findIndex(m => m.value === displayMode)
  const currentModeLabel = DISPLAY_MODES[currentModeIdx].label
  const cycleMode = () => {
    const next = DISPLAY_MODES[(currentModeIdx + 1) % DISPLAY_MODES.length]
    setDisplayMode(next.value)
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 500 }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', visibility: gameActive ? 'visible' : 'hidden', position: 'absolute', inset: 0 }} />
      {!gameActive && <GameDashboard instances={visibleInstances} tasks={visibleTasks} projectId={folders[0]?.id} />}
      <div className="game-controls-bar">
        <button
          className={`game-ctrl-btn game-mode-toggle ${gameActive ? 'active' : ''}`}
          onClick={() => setGameActive(v => !v)}
          title="Toggle game view"
        >
          {gameActive ? '⚔ ON' : '⚔ OFF'}
        </button>
        <div className="game-ctrl-divider" />
        <button
          className="game-ctrl-btn active"
          onClick={cycleMode}
          disabled={!gameActive}
          title="Cycle display mode"
        >
          {currentModeLabel}
        </button>
      </div>
    </div>
  )
}
