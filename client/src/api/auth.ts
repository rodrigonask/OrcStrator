// The admin token this page needs for anything that changes state.
//
// The server makes a new one at every boot and hands it only to a same-origin browser
// request, so the page asks once, keeps it in memory, and asks again when the server says
// it no longer knows it (a restart). It is never stored: a reload simply asks again.

// Optional chaining so node tests can load this module (import.meta.env exists only under Vite).
const BASE = import.meta.env?.VITE_API_URL || ''
const TOKEN_HEADER = 'X-OrcStrator-Token'

let token: string | null = null
let pending: Promise<string | null> | null = null

async function requestToken(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/api/auth/session`, { method: 'POST', credentials: 'same-origin' })
    if (!res.ok) return null
    const body = await res.json() as { token?: unknown }
    return typeof body.token === 'string' ? body.token : null
  } catch {
    return null
  }
}

/** The current token, fetching one if the page has none yet. Concurrent callers share one request. */
export async function getSessionToken(forceRefresh = false): Promise<string | null> {
  if (token && !forceRefresh) return token
  if (!pending) {
    pending = requestToken().then(t => {
      token = t
      pending = null
      return t
    })
  }
  return pending
}

/**
 * fetch() with the token attached. A 401 means the server restarted and made a new token,
 * so the page fetches the new one and retries once.
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const send = async (t: string | null) => {
    const headers = new Headers(init.headers)
    if (t) headers.set(TOKEN_HEADER, t)
    return fetch(input, { ...init, headers })
  }
  let res = await send(await getSessionToken())
  if (res.status === 401) res = await send(await getSessionToken(true))
  return res
}
