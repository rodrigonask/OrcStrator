import type { ChildProcess } from 'child_process'
import { isPidAlive, hardKill } from './process-tree.js'

// ─────────────────────────────────────────────────────────────────────────────
// ONE in-flight set for everything that starts a claude process on a chat.
//
// The process registry only learns about a turn when its process is registered, which is
// several awaits into sendMessage (healing the session file, sanitizing it, an optional
// pre-turn /compact, the spawn itself). A double-click, "Try again", a /btw, a wake-up or a
// /compact landing in that window used to start a second agent on the same conversation.
// Now every one of those paths claims the chat here, synchronously, before its first await,
// and a second claim is refused. The claim is held until the turn's process is registered
// (from then on the registry says the chat is busy) or the start fails.
//
// The same set also carries two other one-at-a-time keys: a pipeline card being started
// (`task:<id>`) and a session being resumed into a new chat (`session:<id>`).
// Keys are plain strings so each caller picks its own namespace.
// ─────────────────────────────────────────────────────────────────────────────

export type ClaimKind = 'turn' | 'compact' | 'task' | 'resume' | 'stopping'

interface Claim {
  token: symbol
  kind: ClaimKind
  since: number
  /** A process this claim runs outside the registry (a /compact), so Stop and shutdown can reach it. */
  child?: ChildProcess
  /** Stop was pressed while this start was still being set up: it must not spawn. */
  cancelled?: boolean
}

/**
 * Ask the start holding `key` to give up (Stop during its setup). Returns the token of the
 * claim that was cancelled, so the caller waits on THAT start and not on a new one made after.
 */
export function requestCancel(key: string): symbol | null {
  const c = claims.get(key)
  if (!c) return null
  c.cancelled = true
  return c.token
}

/** Was the claim `token` holds on `key` cancelled by a Stop? */
export function isCancelled(key: string, token: symbol): boolean {
  const c = claims.get(key)
  return !!c && c.token === token && (c.cancelled === true || shuttingDown)
}

// Chats being stopped right now (Stop, Pause, Reset, closing, deleting), and the app shutting
// down. No new start may claim such a chat until the stop has finished and its caller has
// written the chat's state: a message that slipped in between used to be killed by that Stop,
// or left running under a chat the Stop then marked idle, paused or deleted.
const stopping = new Map<string, number>()
let shuttingDown = false

/** A stop on `key` begins. Nest-safe: every beginStop needs its endStop. */
export function beginStop(key: string): void {
  stopping.set(key, (stopping.get(key) ?? 0) + 1)
}

export function endStop(key: string): void {
  const n = (stopping.get(key) ?? 0) - 1
  if (n > 0) stopping.set(key, n)
  else stopping.delete(key)
}

/** The app is shutting down: every start still being set up gives up, and none may begin. */
export function beginShutdown(): void {
  shuttingDown = true
  for (const c of claims.values()) c.cancelled = true
}

/** A shutdown that failed part-way leaves the server up: it must accept starts again. */
export function abortShutdown(): void {
  shuttingDown = false
}

export function isShuttingDown(): boolean {
  return shuttingDown
}

/** The error a start throws when Stop cancelled it before it spawned. */
export class StartCancelledError extends Error {
  statusCode = 409
  constructor() { super('Stopped before the chat started working on it.') }
}

const claims = new Map<string, Claim>()

// The process each start registered, by claim token, so a Stop that cancelled one start can
// tell its process apart from one a LATER start registered on the same chat.
// Kept a minute after the claim ends (a Stop waiting on it reads it just after), then dropped.
const spawnedBy = new Map<symbol, ChildProcess>()

/** Record the process the start holding `token` registered. */
export function noteSpawn(token: symbol | null | undefined, child: ChildProcess): void {
  if (token) spawnedBy.set(token, child)
}

/** The process the start holding `token` registered, if it got that far. */
export function spawnOf(token: symbol | null | undefined): ChildProcess | undefined {
  return token ? spawnedBy.get(token) : undefined
}

/** The error a refused claim throws. Routes turn it into a 409. */
export class BusyError extends Error {
  statusCode = 409
  constructor(public key: string, public heldBy: ClaimKind) {
    super(heldBy === 'compact'
      ? 'This chat is tidying up its memory. Try again in a moment.'
      : heldBy === 'stopping'
        ? (shuttingDown ? 'OrcStrator is shutting down. Send the message again after it restarts.' : 'This chat is stopping. Try again in a moment.')
        : 'This chat is already working. Wait for it to finish.')
  }
}

/** Claim `key`. Returns a token to release it with, or null when someone else holds it. */
export function claim(key: string, kind: ClaimKind): symbol | null {
  if (claims.has(key) || stopping.has(key) || shuttingDown) return null
  const token = Symbol(key)
  claims.set(key, { token, kind, since: Date.now() })
  return token
}

/** Claim or throw BusyError. */
export function claimOrThrow(key: string, kind: ClaimKind): symbol {
  const t = claim(key, kind)
  if (!t) throw new BusyError(key, claims.get(key)?.kind ?? 'stopping')
  return t
}

// Told whenever a claim is actually released (not for a stale token).
const releaseHooks: Array<(key: string, token: symbol) => void> = []
export function onRelease(fn: (key: string, token: symbol) => void): void {
  releaseHooks.push(fn)
}

/** The token holding `key` right now, if any. */
export function claimToken(key: string): symbol | null {
  return claims.get(key)?.token ?? null
}

/** Release a claim. Only the holder's token releases it; a stale token is a no-op. */
export function release(key: string, token: symbol | null | undefined): void {
  if (!token) return
  if (claims.get(key)?.token === token) {
    claims.delete(key)
    for (const h of releaseHooks) { try { h(key, token) } catch (err) { console.error('[turn-gate] release hook failed:', err) } }
  }
  if (spawnedBy.has(token)) setTimeout(() => spawnedBy.delete(token), 60_000).unref?.()
}

/** Does `token` hold `key` right now? */
export function holds(key: string, token: symbol | null | undefined): boolean {
  return !!token && claims.get(key)?.token === token
}

export function isClaimed(key: string): boolean {
  return claims.has(key)
}

export function claimKind(key: string): ClaimKind | null {
  return claims.get(key)?.kind ?? null
}

/** Attach the process a claim runs outside the registry. */
export function attachChild(key: string, token: symbol, child: ChildProcess): void {
  const c = claims.get(key)
  if (c && c.token === token) c.child = child
}

/** Kill the untracked process (a /compact) holding `key`, if any. True when none is left alive. */
export async function killClaimChild(key: string): Promise<boolean> {
  const child = claims.get(key)?.child
  if (!child?.pid || child.exitCode !== null) return true
  const pid = child.pid
  for (let i = 0; i < 10 && isPidAlive(pid); i++) {
    hardKill(pid)
    await new Promise(r => setTimeout(r, 200))
  }
  return !isPidAlive(pid)
}

/** Shutdown: every untracked child still running (killAll does not know about them). */
export async function killAllClaimChildren(): Promise<void> {
  await Promise.all([...claims.keys()].map(k => killClaimChild(k)))
}

/** Chats with a turn or a /compact starting or running under a claim right now. */
export function chatsStarting(): string[] {
  return [...claims.keys()].filter(k => k.startsWith('chat:')).map(k => k.slice(5))
}

/** Instance key for the chat-level claim. */
export const chatKey = (instanceId: string) => `chat:${instanceId}`
export const taskKey = (taskId: string) => `task:${taskId}`
export const sessionKey = (sessionId: string) => `session:${sessionId}`

/** Test hook. */
export function _resetClaims(): void {
  claims.clear()
  stopping.clear()
  shuttingDown = false
}
