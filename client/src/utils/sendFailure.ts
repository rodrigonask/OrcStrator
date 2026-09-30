// The chat line shown when something the person sent never reached Claude. The server's own
// error messages are written for people; a network failure is not, so it is replaced.
// A command is run, not sent: callers pass their own verb and last sentence.
export function sendFailureText(what: string, err: unknown, verb = 'send', tail = 'It was not delivered.'): string {
  // fetch() rejects with a TypeError ("Failed to fetch", "NetworkError ...", "Load failed").
  let reason = err instanceof TypeError && /fetch|network|load failed/i.test(err.message)
    ? 'OrcStrator is not responding. Check the OrcStrator window.'
    : (err instanceof Error ? err.message : String(err ?? '')).trim()
  if (!reason) reason = 'Something went wrong.'
  if (!/[.!?]$/.test(reason)) reason += '.'
  return `⚠ Couldn't ${verb} ${what}. ${reason} ${tail}`
}
