import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { InstanceConfig } from '@shared/types'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { usePinnedChats } from './usePinnedChats'
import { resolveSoundTier } from './useVFX'
import { sounds } from '../utils/sounds'
import { useConfirm } from '../components/ConfirmModal'
import { CloseSessionDialog } from '../components/pipeline/CloseSessionDialog'
import { OutputStyleSelect } from '../components/OutputStyleSelect'
import { PermissionRulesModal } from '../components/PermissionRulesModal'
import type { CloseStatus } from '../components/pipeline/CloseSessionDialog'
import { WorktreeOrphanDialog } from '../components/pipeline/WorktreeOrphanDialog'
import type { WorktreeOrphanInfo } from '../components/pipeline/WorktreeOrphanDialog'
import { CloseScheduledDialog, scheduledCardsForChats } from '../components/CloseScheduledDialog'
import { rest } from '../api/rest'
import { api } from '../api'
import type { PipelineTask } from '@shared/types'

/**
 * Shared right-click menu for an instance (Pin, Split View, Rename, Close).
 * Used by the sidebar folder-tree rows (InstanceItem) and the Active/Recent
 * quick-access rows so the two can't drift apart.
 *
 * Returns an `onContextMenu` handler to spread on the row, the `menu` portal to
 * render, and `isOpen` for keeping the row highlighted while the menu is up.
 */
/**
 * The message Investigate sends back into the session. Written the way the user would say
 * it, because that is what it becomes: a user turn. It carries the facts the scan already
 * has, so the session does not start by re-deriving them.
 */
function buildInvestigatePrompt(orphans: WorktreeOrphanInfo[]): string {
  const lines = orphans.map(o => {
    const bits: string[] = []
    if (o.dirty > 0) bits.push(`${o.dirty} uncommitted file${o.dirty !== 1 ? 's' : ''}`)
    if (o.unpushed > 0) bits.push(`${o.unpushed} unpushed commit${o.unpushed !== 1 ? 's' : ''}`)
    if (o.unpushed === -1) bits.push('never pushed')
    if (!o.registered) bits.push('git no longer tracks it as a worktree')
    return `- ${o.path} (branch ${o.branch || 'detached'}${bits.length ? ', ' + bits.join(', ') : ''})`
  }).join('\n')
  const many = orphans.length !== 1
  return [
    `I was about to close this session and OrcStrator found ${orphans.length} worktree${many ? 's' : ''} it created and never removed:`,
    '',
    lines,
    '',
    'Audit each of those branches in this repo and report the real state of each one: uncommitted work, unpushed commits, whether a PR exists and whether it merged.',
    '',
    `Then finish ${many ? 'each one' : 'it'}: commit and push, open a PR, merge it, remove the worktree and delete the branches. If something cannot be finished, say exactly what is blocking it instead of removing anything.`,
    '',
    'Never delete a worktree that has uncommitted or unpushed work, and never touch a worktree another session created.',
  ].join('\n')
}

/**
 * The message "Make Recurring" sends back into the session. A user turn, like
 * buildInvestigatePrompt above, so the answer lands in the conversation the work happened in.
 *
 * The session creates the card itself against the ordinary task-create endpoint rather than
 * the client opening the card modal prefilled: the title, the stored instruction and the
 * schedule all come out of a conversation about what is worth repeating, and a form cannot
 * host that conversation.
 *
 * There is no routines API left to post to. A schedule is a property of a pipeline card
 * now, so this creates a CARD carrying schedule fields, on the project's own board, where
 * it can be seen, edited and deleted like anything else.
 *
 * Both ids are injected rather than left to the session to look up. instanceId is the same
 * value as the ORCSTRATOR_INSTANCE_ID env var every spawned process carries, and projectId
 * is the chat's folder, which is where its board lives. The client has both for free and
 * handing them over removes two steps that can fail.
 */
function buildMakeRecurringPrompt(instanceId: string, projectId: string): string {
  return [
    'Turn something I have been doing in this chat into a recurring scheduled card.',
    '',
    '1. Review what has actually happened in this conversation so far: the work done, the commands run, the checks made. Read back through your own history rather than going off the last message.',
    '2. Tell me which of those activities are worth repeating on a schedule and which are one-offs. A short list, one line of reasoning each, plus the schedule you would suggest for each.',
    '3. Stop and wait for me to pick one and confirm its schedule. Do not create anything until I have confirmed both the activity and the schedule.',
    '',
    'Once I have confirmed, create it as a scheduled card on this project pipeline board, aimed at THIS chat, so it fires again right here:',
    '',
    `curl.exe -s -X POST "http://127.0.0.1:$env:ORCSTRATOR_PORT/api/pipelines/${projectId}/tasks" -H "X-OrcStrator-Token: $env:ORCSTRATOR_AGENT_TOKEN" -H "Content-Type: application/json" -d '{"title":"<short title>","description":"<the full instruction the future run should receive>","scheduleKind":"times","scheduleValue":"09:00","targetInstanceId":"${instanceId}","rawPrompt":true}'`,
    '',
    'Use curl.exe, not curl: in PowerShell curl is an alias for Invoke-WebRequest and will not take those flags.',
    '',
    'The X-OrcStrator-Token header is required: without it the app answers 401. ORCSTRATOR_AGENT_TOKEN and ORCSTRATOR_PORT are already set in this chat\'s environment (in bash, write them as $ORCSTRATOR_AGENT_TOKEN and $ORCSTRATOR_PORT). Do not add a permissionMode field: the app refuses it from a chat.',
    '',
    `There is no routines endpoint any more. A schedule is a property of a card, so this is the ordinary create-task call with the schedule fields in the same body. The project is ${projectId}, which goes in the URL and not in the body.`,
    '',
    `targetInstanceId is ${instanceId}, this chat, the same value as its ORCSTRATOR_INSTANCE_ID. It is the chat every fire is AIMED at, and it is NOT the same field as instanceId (the chat that last worked a card), so do not send instanceId at all. Leave targetInstanceId out and each fire opens a fresh chat in the project instead.`,
    '',
    'scheduleKind and scheduleValue go together. There are three kinds:',
    '- "every": scheduleValue is a whole number of MINUTES as a string, e.g. "300" for every 5 hours. It fires on a fixed grid anchored on the active window open, or on midnight when there is no window, never "N minutes after the last run".',
    '- "times": scheduleValue is a comma-separated list of clock times, e.g. "09:00" or "11:00,19:00".',
    '- "once": scheduleValue is "YYYY-MM-DDTHH:MM".',
    '',
    'Three optional fields shape it further, and each null means something:',
    '- scheduleDays: "D,D,D" with 0=Sun to 6=Sat, ascending and unique, e.g. "1,2,3,4,5" for weekdays. Leave it out for every day.',
    '- scheduleWindow: "HH:MM-HH:MM", on "every" only, e.g. "11:00-19:00". An end at or before the start means the window runs overnight and closes the next day. The end minute is included. Leave it out for the whole day.',
    '- scheduleTz: an IANA name like "Asia/Tokyo". Leave it out for computer time, which follows this laptop wherever it is. That is almost always what you want.',
    '',
    'The old "interval", "daily" and "weekly" kinds no longer exist and are rejected with a 400.',
    '',
    'Keep rawPrompt true: it sends the description VERBATIM as the message, with no kickoff template wrapped around it, which is exactly what a routine always did. Add "silent":true as well if the fires should run without pulling the chat into the grid.',
    '',
    'The description you store is what a future run receives with none of this conversation in front of it, so write it standalone: what to do, where, and what finished looks like.',
    '',
    'Confirm the POST came back 201 and tell me the card title and when it next runs.',
  ].join('\n')
}

export function useInstanceContextMenu(instance: InstanceConfig | undefined) {
  const { settings } = useUI()
  const { dispatch, secureCloseInstance, sendMessage, addToGrid } = useAppDispatch()
  const { isPinned, pin, unpin } = usePinnedChats()
  const { confirm } = useConfirm()
  const soundEnabled = resolveSoundTier(settings) >= 2

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [closeTask, setCloseTask] = useState<PipelineTask | null>(null)
  const [orphans, setOrphans] = useState<WorktreeOrphanInfo[] | null>(null)
  const [closeScheduled, setCloseScheduled] = useState<PipelineTask[] | null>(null)
  // Scheduled cards the user chose to drop in the close dialog. Deleted only immediately
  // before the close itself, never earlier: the task-status dialog still comes after it,
  // and a Cancel there has to leave the cards exactly as they were. A ref rather than state
  // because the close continues in the same tick the choice is made.
  //
  // The whole card is kept, not just its id: a task delete is addressed through its own
  // project (DELETE /api/pipelines/:projectId/tasks/:taskId), and going back to look the
  // project up later would mean a second fetch at the worst possible moment.
  const pendingScheduledDeletes = useRef<PipelineTask[]>([])
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const summaryMode = settings.sessionSummaryMode ?? 'tasks'

  // Runs right before secureCloseInstance on every path that reaches it. Returns false
  // when the close must not go ahead.
  const deletePendingScheduled = useCallback(async (): Promise<boolean> => {
    const cards = pendingScheduledDeletes.current
    pendingScheduledDeletes.current = []
    for (const card of cards) {
      try {
        // The ordinary task delete. Deleting a scheduled card is deleting a card, there is
        // no separate routine to remove any more, and the server takes its run history with
        // it in the same transaction.
        await api.deleteTask(card.projectId, card.id)
      } catch (err) {
        // The card is still there. Closing quietly would be a "keep" nobody picked.
        const msg = (err as Error).message || 'unknown error'
        const ok = await confirm(
          `Could not delete a scheduled card (${msg}). Close anyway and leave it firing in new chats?`,
          'Scheduled card not deleted'
        )
        if (!ok) return false
      }
    }
    return true
  }, [confirm])

  // The tail of the close flow, after every guard: the mandatory task status pick, then
  // the close itself. Extracted so the scheduled-cards dialog's "keep" and "delete" both
  // resume exactly here.
  const finishClose = useCallback(async () => {
    if (!instance) return
    // If this session came from a pipeline task, the status pick is mandatory and the
    // close happens from the dialog instead. Asked AFTER the uncommitted-work guard, so
    // the cheap "never mind" is still the first thing offered.
    try {
      const { task } = await rest.getInstanceTask(instance.id)
      if (task) { setCloseTask(task); return }
    } catch {
      /* task lookup unavailable, fall through and close as before */
    }
    if (!(await deletePendingScheduled())) return
    // Close + permanently scrub API keys / passwords from the transcript file. The "removed"
    // sound only once it really closed (a chat whose agent would not stop stays).
    if (await secureCloseInstance(instance.id, instance.name) && soundEnabled) sounds.remove()
  }, [instance, soundEnabled, secureCloseInstance, deletePendingScheduled])

  // The rest of the close flow, after the worktree check: the uncommitted-work guard, then
  // the scheduled-cards question, then finishClose above. Extracted so the orphan dialog's
  // "Ignore and close" resumes exactly where the check interrupted.
  const continueClose = useCallback(async () => {
    if (!instance) return
    // Guard: warn before orphaning a session that has uncommitted edits. The files stay
    // on disk, what is lost is the session that knows why they exist.
    try {
      const gs = await api.getInstanceGitStatus(instance.id)
      if (gs.isRepo && gs.mine.length > 0) {
        const shown = gs.mine.slice(0, 6).join(', ')
        const more = gs.mine.length > 6 ? `, +${gs.mine.length - 6} more` : ''
        const others = gs.others.length > 0
          ? `\n\n(${gs.others.length} other uncommitted file${gs.others.length !== 1 ? 's' : ''} in this shared repo belong to other sessions.)`
          : ''
        const ok = await confirm(
          `"${instance.name}" has ${gs.mine.length} uncommitted change${gs.mine.length !== 1 ? 's' : ''}: ${shown}${more}.\n\n` +
          `Closing ends the session that made them. The files stay on disk, but the context that knows why is gone. Commit them first, or close anyway?${others}`,
          'Uncommitted changes'
        )
        if (!ok) return
      }
    } catch {
      /* git-status unavailable (no repo / server error), do not block the close */
    }
    // Scheduled cards aimed at this chat. The server never deletes them with the chat: a
    // kept card runs in a fresh chat in its project from the next fire on. That is right
    // for a reminder and wrong for a card that only made sense here, so ask. Filtered
    // client-side rather than through a per-instance endpoint, because a client change is
    // live on merge and a server change waits for a lock-gated restart.
    //
    // This project's board, not every project's, for two reasons. The card modal only ever
    // offers chats from the card's OWN project as a target, so a card aimed at this chat
    // lives on this chat's board by construction. And the all-projects payload is the light
    // task shape, which carries no schedule columns at all: filtering it would find nothing
    // and say so silently, which is the one failure mode this dialog cannot have.
    //
    // scheduledCardsForChats is the filter, and it is targetInstanceId (the chat fires are
    // AIMED at), never instanceId (the chat that last worked the card). See its comment.
    //
    // The `true` is not optional and is not really about done cards: it is the flag that
    // makes this route answer with the FULL task shape. Drop it and the same call returns
    // the light shape, with no schedule columns, and the question is never asked.
    try {
      const tasks = await api.getProjectPipeline(instance.folderId, true)
      const mine = scheduledCardsForChats(tasks, [instance.id])
      if (mine.length > 0) { setCloseScheduled(mine); return }
    } catch {
      /* task list unavailable, never block a close on it */
    }
    await finishClose()
  }, [instance, confirm, finishClose])

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    if (!instance) return
    e.preventDefault()
    e.stopPropagation()
    setPos({ x: e.clientX, y: e.clientY })
  }, [instance])

  // Escape closes the menu
  useEffect(() => {
    if (!pos) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setPos(null) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [pos])

  // Reposition if the menu overflows the viewport
  useEffect(() => {
    if (!pos || !menuRef.current) return
    const el = menuRef.current
    const rect = el.getBoundingClientRect()
    const pad = 8
    let { x, y } = pos
    if (rect.bottom > window.innerHeight - pad) y = Math.max(pad, pos.y - rect.height)
    if (rect.right > window.innerWidth - pad) x = Math.max(pad, window.innerWidth - rect.width - pad)
    if (x !== pos.x || y !== pos.y) { el.style.left = `${x}px`; el.style.top = `${y}px` }
  }, [pos])

  const close = () => setPos(null)

  const menu = pos && instance ? createPortal(
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 199 }}
        onClick={(e) => { e.stopPropagation(); close() }}
        onContextMenu={(e) => { e.preventDefault(); close() }}
      />
      <div
        ref={menuRef}
        className="context-menu"
        style={{ top: pos.y, left: pos.x }}
        onClick={e => e.stopPropagation()}
      >
        <button
          className="context-menu-item"
          onClick={() => {
            close()
            if (isPinned(instance.id)) unpin(instance.id)
            else pin(instance.id)
          }}
        >
          {isPinned(instance.id) ? 'Unpin from Sidebar' : 'Pin to Sidebar'}
        </button>
        <button
          className="context-menu-item"
          onClick={() => {
            close()
            if ((window as any).__orcSplitAdd) (window as any).__orcSplitAdd(instance.id)
          }}
        >
          Open in Split View
        </button>
        <button
          className="context-menu-item"
          onClick={() => {
            close()
            const name = window.prompt('Rename session:', instance.name)
            if (name !== null && name.trim() && name.trim() !== instance.name) {
              const trimmed = name.trim()
              api.updateInstance(instance.id, { name: trimmed })
                .then(() => dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { name: trimmed } } }))
                .catch(err => console.error('Failed to rename session:', err))
            }
          }}
        >
          Rename...
        </button>
        {/* Turns whatever this chat has been doing into a scheduled card that fires back
            into this same chat. The work happens in the conversation, so the row only has to
            put the instruction there: same addToGrid + sendMessage path the orphan dialog's
            Investigate uses, and for the same reason (a tile the user cannot see reads as nothing
            happening, and rest.sendMessage alone paints no user bubble). */}
        <button
          className="context-menu-item"
          onClick={() => {
            close()
            addToGrid(instance.id)
            void sendMessage(instance.id, buildMakeRecurringPrompt(instance.id, instance.folderId))
          }}
        >
          Make Recurring...
        </button>
        <div className="context-menu-separator" />
        {/* Per-chat output style. It lives here, not only in the chat header's ☰, because
            Grid is the view that actually gets used and a grid tile has no menu of its own,
            this same menu is what a tile right-click opens. */}
        <OutputStyleSelect instance={instance} />
        {/* Rules for this chat only, added on top of the app-wide set. A list editor is far
            too big to live inline the way the output-style select does, so the row opens a
            modal. Here rather than only in Settings because the grant is nearly always
            reactive: a chat just got refused something and needs it now. */}
        <button
          className="context-menu-item"
          onClick={() => { close(); setPermissionsOpen(true) }}
        >
          Permissions...
        </button>
        <div className="context-menu-separator" />
        <button
          className="context-menu-item danger"
          onClick={async () => {
            close()
            pendingScheduledDeletes.current = []
            // FIRST, before every other close check. A worktree outlives the session that
            // made it but the reason for it does not, so this is the last moment the
            // session can still be told to go and finish it. Read from the transcript, so
            // it holds even when the session no longer remembers making one.
            try {
              const wt = await api.getInstanceWorktreeOrphans(instance.id)
              if (wt.checked && wt.orphans.length > 0) { setOrphans(wt.orphans); return }
            } catch {
              /* scan unavailable, never block a close on it */
            }
            await continueClose()
          }}
        >
          Close Session
        </button>
      </div>
    </>,
    document.body
  ) : null

  // Mandatory status pick for a task-linked session. Cancelling leaves the session open:
  // a close with no status is exactly the gap this closes.
  const closeDialog = instance && closeTask ? (
    <CloseSessionDialog
      instanceName={instance.name}
      task={closeTask}
      willSummarize={summaryMode !== 'off'}
      onCancel={() => { pendingScheduledDeletes.current = []; setCloseTask(null) }}
      onConfirm={async (status: CloseStatus) => {
        setCloseTask(null)
        if (!(await deletePendingScheduled())) return
        if (await secureCloseInstance(instance.id, instance.name, status) && soundEnabled) sounds.remove()
      }}
    />
  ) : null

  // Worktrees this session created and never removed. Rendered alongside the status pick
  // but reached first, because the close flow asks about them before anything else.
  const orphanDialog = instance && orphans ? (
    <WorktreeOrphanDialog
      instanceName={instance.name}
      orphans={orphans}
      onCancel={() => setOrphans(null)}
      onIgnore={() => { setOrphans(null); void continueClose() }}
      onInvestigate={() => {
        const list = orphans
        setOrphans(null)
        // Grid is the view that actually gets used, so put the session on screen before
        // talking to it. Handing work to a tile the user cannot see reads as nothing happening.
        addToGrid(instance.id)
        // Through the app-level sendMessage, never rest.sendMessage: that is the call that
        // paints the user bubble, flips the tile to running, and reports a rejected send as
        // a message in the chat. Posting to /send directly was the invisible message - the
        // turn started with nothing on screen saying why.
        void sendMessage(instance.id, buildInvestigatePrompt(list))
      }}
    />
  ) : null

  // Scheduled cards that can still fire on this chat. Reached after the worktree check and
  // the uncommitted-work guard, before the task status pick. Cancel leaves the chat open.
  const scheduledDialog = instance && closeScheduled ? (
    <CloseScheduledDialog
      instanceName={instance.name}
      tasks={closeScheduled}
      onCancel={() => { pendingScheduledDeletes.current = []; setCloseScheduled(null) }}
      onKeep={() => { pendingScheduledDeletes.current = []; setCloseScheduled(null); void finishClose() }}
      onDelete={() => {
        // Only remembered here. The deletes run in deletePendingScheduled, right before the
        // close itself, so a Cancel in the task-status dialog still finds them untouched.
        pendingScheduledDeletes.current = closeScheduled
        setCloseScheduled(null)
        void finishClose()
      }}
    />
  ) : null

  // Rendered outside `menu` above, because the menu closes the moment the row is clicked
  // and the modal has to outlive it.
  const permissionsDialog = instance && permissionsOpen ? (
    <PermissionRulesModal instance={instance} onClose={() => setPermissionsOpen(false)} />
  ) : null

  return {
    onContextMenu,
    menu: (menu || closeDialog || orphanDialog || scheduledDialog || permissionsDialog)
      ? <>{menu}{closeDialog}{orphanDialog}{scheduledDialog}{permissionsDialog}</>
      : null,
    isOpen: pos != null,
  }
}
