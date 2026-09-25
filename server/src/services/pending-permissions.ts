// Every can_use_tool request a chat is currently blocked on, held in memory until it is answered
// or the process goes away.
//
// WHY THIS EXISTS. The request used to live only in the browser, in one slot per chat.
// Two things went wrong with that:
//
//  - A reload, a new tab, or a WebSocket reconnect lost it. The CLI was still blocked on stdin
//    waiting for an answer, the banner that could give one was gone, and nothing on screen said
//    the chat was waiting. The turn just sat there.
//  - One slot per chat meant the second of two concurrent requests (parallel tool calls, a
//    subagent asking while its parent does) overwrote the first. The first was never answered,
//    so the turn hung with a banner showing for the wrong call.
//
// So the server keeps the queue, in arrival order, and /state hands it to a freshly loaded tab.
// In memory on purpose, same as turn-progress.ts: a request belongs to one live process, and after a
// server restart that process is gone and nothing could answer the request anyway.
import type { PermissionRequestData } from '@orcstrator/shared'

const store = new Map<string, PermissionRequestData[]>()

/** Record a request the CLI is now blocked on. A repeat of the same request id is ignored. */
export function trackPermissionRequest(request: PermissionRequestData): void {
  const queue = store.get(request.instanceId) ?? []
  if (queue.some(r => r.requestId === request.requestId)) return
  queue.push(request)
  store.set(request.instanceId, queue)
}

/** Remove one answered request and return it, or undefined when it was not pending. */
export function resolvePermissionRequest(instanceId: string, requestId: string): PermissionRequestData | undefined {
  const queue = store.get(instanceId)
  if (!queue) return undefined
  const index = queue.findIndex(r => r.requestId === requestId)
  if (index === -1) return undefined
  const [request] = queue.splice(index, 1)
  if (queue.length === 0) store.delete(instanceId)
  return request
}

/** Is this exact request still waiting? False once it is answered, withdrawn, or its process died. */
export function isPermissionRequestPending(instanceId: string, requestId: string): boolean {
  return !!store.get(instanceId)?.some(r => r.requestId === requestId)
}

/** When the chat's oldest unanswered request arrived, or null when its CLI is blocked on none. */
export function oldestPendingPermissionAt(instanceId: string): number | null {
  const queue = store.get(instanceId)
  if (!queue || queue.length === 0) return null
  return Math.min(...queue.map(r => r.receivedAt))
}

/** Drop everything for a chat: its process exited, so no request of its can be answered now. */
export function clearPermissionRequests(instanceId: string): void {
  store.delete(instanceId)
}

/** Every chat's pending requests, oldest first, for the fresh-tab load. */
export function allPendingPermissionRequests(): Record<string, PermissionRequestData[]> {
  const out: Record<string, PermissionRequestData[]> = {}
  for (const [instanceId, queue] of store) {
    if (queue.length > 0) out[instanceId] = [...queue]
  }
  return out
}
