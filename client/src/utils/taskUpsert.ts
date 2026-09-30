import type { PipelineTask } from '@shared/types'

/**
 * Wrap a single-card fetch so concurrent asks for the same card share one request.
 * A board event is heard by two listeners at once (the open board and the app-wide task list);
 * each asks for the card the event names, and only one request goes out.
 */
export function shareInFlight(fetchOne: (projectId: string, taskId: string) => Promise<PipelineTask>) {
  // Sharing is only safe between asks made for the SAME event: both listeners run in the same
  // synchronous turn, so an ask in that turn joins. An ask from a LATER event (a second change to
  // the same card) must not join a request that left before that change was written; it gets one
  // follow-up fetch after the current one, shared by every later ask meanwhile.
  const inFlight = new Map<string, { p: Promise<PipelineTask>; fresh: boolean; next?: Promise<PipelineTask> }>()
  const start = (key: string, projectId: string, taskId: string): Promise<PipelineTask> => {
    const entry: { p: Promise<PipelineTask>; fresh: boolean; next?: Promise<PipelineTask> } = { p: Promise.resolve(null as unknown as PipelineTask), fresh: true }
    entry.p = fetchOne(projectId, taskId).finally(() => { if (inFlight.get(key) === entry) inFlight.delete(key) })
    inFlight.set(key, entry)
    queueMicrotask(() => { entry.fresh = false })
    return entry.p
  }
  return (projectId: string, taskId: string): Promise<PipelineTask> => {
    const key = `${projectId}/${taskId}`
    const existing = inFlight.get(key)
    if (!existing) return start(key, projectId, taskId)
    if (existing.fresh) return existing.p
    existing.next ??= existing.p.catch(() => undefined).then(() => start(key, projectId, taskId))
    return existing.next
  }
}

/**
 * Apply a full list that may have left before a one-card update landed: a card this client
 * already holds in a NEWER version (by updatedAt) is kept, so a slow full refetch cannot put an
 * older copy back over a fresher one.
 */
export function keepNewer(prev: PipelineTask[], incoming: PipelineTask[]): PipelineTask[] {
  const held = new Map(prev.map(t => [t.id, t]))
  return incoming.map(t => {
    const cur = held.get(t.id)
    return cur && (cur.updatedAt ?? 0) > (t.updatedAt ?? 0) ? cur : t
  })
}

/**
 * Put one card into a project's list in the order the server returns lists in (priority, then
 * creation time), replacing it if it is already there: the same result a full refetch gives
 * for that one card.
 */
export function upsertTask(list: PipelineTask[], task: PipelineTask): PipelineTask[] {
  const next = list.filter(t => t.id !== task.id)
  next.push(task)
  next.sort((a, b) => (a.priority - b.priority) || (a.createdAt - b.createdAt))
  return next
}
