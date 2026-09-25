// When to end a Claude CLI process's stdin.
//
// Ending stdin is how a turn's process gets told "no more input, exit when you are done". It is
// ALSO the pipe every permission answer travels back on (the control_response to a can_use_tool
// request, and the auto-allow for the AskUserQuestion/ExitPlanMode cards). End it while the CLI
// still has work queued and that work's first permission request fails at once, before any card
// can be shown, with:
//
//   Tool permission request failed: AbortError: Stream closed
//
// A `result` event does NOT mean the process is done. One process can emit several. The common
// case (most real Stream closed failures): the previous turn left a
// background task running, the process exited and stopped it, and on --resume the CLI reports that
// task as a <task-notification> and runs it as its own empty turn (num_turns 0, ~40 ms, a result)
// BEFORE it starts the user's prompt. Ending stdin on that first result left the whole real turn
// without a way to receive an answer. Reproduced on demand against the real CLI.
//
// The CLI's own signal for "my input queue is drained": with CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS
// set it emits {type:'system', subtype:'session_state_changed', state} with 'running',
// 'requires_action' (a permission request is waiting) or 'idle'. Measured against CLI 2.1.272: the
// state stays 'running' across that empty notification turn and only reports 'idle' after the
// user's turn has finished, and 'idle' arrives immediately after a turn that left a background
// task running (so closing on it keeps the one-process-per-turn lifecycle exactly as it was).
//
// A CLI that never emits a state event (an older build, or the variable stops being honoured: it
// is not in the public env-var docs) is handled exactly as before: stdin ends on the first result.
// That fallback is decided AT the first result, which is safe because 2.1.272 emits 'running'
// before anything else in a turn; a build that emitted its first state event later would quietly
// get the old behaviour back, not a hang.
//
// The other background variant: a turn that ends while a BACKGROUND agent works. The CLI keeps
// the session 'running' until the agent is done (and runs the agent's notification as one more
// turn), so stdin stays open for every request the agent raises. Background Bash does not hold
// 'running'; the CLI stops those ~5 s after stdin ends, as it always did.

/** Set on the CLI's environment so it reports its session state on stdout. */
export const SESSION_STATE_EVENTS_ENV = 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS'

export interface StdinCloseTracker {
  /** Feed every parsed stdout object, in order. */
  onEvent(raw: unknown): void
  /** True once it is safe to end stdin. Stays true once it has become true. */
  shouldCloseStdin(): boolean
}

export function createStdinCloseTracker(): StdinCloseTracker {
  let sawResult = false
  let sawStateEvent = false
  let idleAfterResult = false
  let decided = false
  return {
    onEvent(raw) {
      if (decided || !raw || typeof raw !== 'object') return
      const d = raw as { type?: unknown; subtype?: unknown; state?: unknown }
      if (d.type === 'result') {
        sawResult = true
        return
      }
      if (d.type === 'system' && d.subtype === 'session_state_changed') {
        sawStateEvent = true
        // 'idle' before any result is the CLI settling at startup, not the end of our turn.
        idleAfterResult = d.state === 'idle' && sawResult
      }
    },
    shouldCloseStdin() {
      if (decided) return true
      if (!sawResult) return false
      decided = sawStateEvent ? idleAfterResult : true
      return decided
    },
  }
}
