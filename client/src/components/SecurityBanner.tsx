import { useEffect, useRef, useState } from 'react'
import { useUI } from '../context/UIContext'
import type { SessionLogResult } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'

/** How long the banner waits for the summary before giving up and closing itself. */
const SUMMARY_WAIT_MS = 60_000
/** How long a finished notice stays up, when nobody is looking at it. */
const RESOLVED_MS = 2_000

/**
 * Where the summary ended up, in one sentence.
 *
 * The destination may genuinely be unnameable: `taskTitle` is absent on a server that
 * predates the field, and `name` is empty when the close happened in another client, so
 * every sentence needs a version that reads correctly with no title at all. Naming it
 * anyway produced "Logged to the board as “the chat”".
 */
function LogLine({ log, name }: { log: SessionLogResult; name: string }) {
  // A chat filed as a new task is titled after the chat, so `name` IS the task's title
  // whenever the server did not send one.
  const title = log.taskTitle || (log.loggedAsNewTask ? name : '')

  if (!log.ok) {
    return title
      ? <>Filed to “{title}”, but the summary itself could not be written.</>
      : <>Filed to the board, but the summary itself could not be written.</>
  }
  if (log.loggedAsNewTask) {
    return title
      ? <>Logged to the board as “{title}”, in Done.</>
      : <>Logged to the board, in Done.</>
  }
  return title
    ? <>Summary added to “{title}”.</>
    : <>Summary added to the linked task.</>
}

/**
 * App-level banner for the close-and-scrub flow. Shows "Scanning…" while the transcript
 * is being cleaned, then the result. Lives above the views (not on the tile) because the
 * instance is already gone by the time the result lands.
 *
 * ONE close is ONE banner, start to finish. It used to be two in sequence (the scrub, then
 * the summary landing seconds later), which meant the same event had to be dismissed twice
 * and whichever notice you were reading got replaced mid-sentence. So when the server says
 * a summary is coming, the notice stays up with the scrub result readable on it and the
 * summary MERGES in when it arrives (see SET_SESSION_LOG). The scrub line drops the chat's
 * name once the summary is alongside it, because the summary line already names where the
 * work went and printing the same title twice reads like a stutter.
 *
 * The wait is bounded: a summary that never reports back (server died, broadcast lost)
 * would otherwise pin the banner open, so SUMMARY_WAIT_MS closes it. It sits comfortably
 * past the summarizer's own 30s request timeout.
 *
 * A finished notice is gone in two seconds, because it is a receipt and not something to
 * read. Hovering it holds it for as long as the pointer is there, and leaving gives it a
 * fresh two seconds — so the short timer never takes the sentence away mid-read.
 */
export function SecurityBanner() {
  const { securityNotice } = useUI()
  const { dispatch } = useAppDispatch()

  // The scanning state stays until it resolves. A resolved notice that is still waiting on
  // its summary gets the long timer (it is a backstop, not a display time); everything
  // else gets the short one. `at` is bumped when the summary merges in, so the finished
  // banner gets its own full RESOLVED_MS to be read.
  const phase = securityNotice?.phase
  const waiting = !!securityNotice && !securityNotice.log && !!securityNotice.pendingLog
  const at = securityNotice?.at
  const id = securityNotice?.id
  const ref = useRef<HTMLDivElement>(null)
  // Hovering holds the banner. `hovered` is in the deps, so leaving restarts the timer
  // from zero rather than resuming what was left of it: two seconds is short enough that
  // a resumed remainder would blink out from under the pointer.
  const [hovered, setHovered] = useState(false)
  // A new close must not inherit the last one's hover. The component never unmounts (it
  // renders null between notices), and dismissing by hand while hovering means the
  // mouseleave never fires, so the flag would otherwise stick and pin the next banner.
  useEffect(() => { setHovered(false) }, [id])
  useEffect(() => {
    if (!phase || phase === 'scanning' || hovered) return
    const t = setTimeout(() => {
      // The pointer can already be over the banner without a mouseenter ever firing: the
      // banner appears under a cursor that never moved. Ask the DOM at the moment it
      // matters. :focus-within covers the same case for the keyboard.
      if (ref.current?.matches(':hover, :focus-within')) { setHovered(true); return }
      dispatch({ type: 'CLEAR_SECURITY_NOTICE' })
    }, waiting ? SUMMARY_WAIT_MS : RESOLVED_MS)
    return () => clearTimeout(t)
  }, [phase, waiting, at, hovered, dispatch])

  if (!securityNotice) return null
  const { name, apiKeys, passwords, log } = securityNotice
  const total = apiKeys + passwords

  const parts: string[] = []
  if (apiKeys > 0) parts.push(`${apiKeys} API key${apiKeys === 1 ? '' : 's'}`)
  if (passwords > 0) parts.push(`${passwords} password${passwords === 1 ? '' : 's'}`)
  const found = parts.join(' & ')

  return (
    <div
      ref={ref}
      className={`security-banner ${securityNotice.phase}${log ? ' logged' : ''}`}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="security-banner-icon" aria-hidden>
        {log ? '📋' : securityNotice.phase === 'scanning' ? '🛡️' : securityNotice.phase === 'error' ? '⚠️' : '🔒'}
      </span>
      <span className="security-banner-text">
        {securityNotice.phase === 'scanning' && <>Scanning <strong>{name}</strong> for security leaks…</>}

        {/* Resolved, with the summary alongside it: the destination leads, the scrub is the
            tail clause. That order is deliberate — where the work was filed is the part
            worth reading, the scrub is a reassurance. */}
        {securityNotice.phase !== 'scanning' && log && (
          <>
            <strong><LogLine log={log} name={name} /></strong>{' '}
            {securityNotice.phase === 'error'
              ? <>The security scan didn’t finish, so rotate any keys you pasted to be safe.</>
              : total > 0
                ? <>Chat cleaned: removed {found}.</>
                : <>Chat cleaned. No key or password formats OrcStrator recognises were found.</>}
          </>
        )}

        {/* Resolved with no summary attached: either none is coming, or it has not landed
            yet and the banner is holding the line open for it. */}
        {securityNotice.phase === 'done' && !log && (total > 0
          ? <><strong>Chat cleaned.</strong> Removed {found} from “{name}”.</>
          : <><strong>Chat cleaned.</strong> No key or password formats OrcStrator recognises were found in “{name}”.</>)}
        {securityNotice.phase === 'error' && !log && (
          <>Closed “{name}”, but the scan didn’t finish. Rotate any keys you pasted to be safe.</>
        )}
        {waiting && <span className="security-banner-pending"> Filing the summary…</span>}
      </span>
      {securityNotice.phase !== 'scanning' && (
        <button
          className="security-banner-dismiss"
          onClick={() => dispatch({ type: 'CLEAR_SECURITY_NOTICE' })}
          title="Dismiss"
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  )
}
