import type { PipelineTask } from '@shared/types'

export interface CardEdits {
  title: string
  description: string
  priority: PipelineTask['priority']
  labels: string[]
}

/**
 * Only the fields the person actually changed since the card was loaded.
 *
 * The detail panel used to send title, description, priority and labels on every Save. The
 * scheduler and the agents update cards too (a run stamps its labels, an agent rewrites a
 * description), and a save of a panel opened before that change wrote the stale copy back over
 * it. Comparing against the row the panel loaded, and sending only what differs, means a Save
 * touches exactly what the person touched.
 */
export function changedCardFields(loaded: Pick<PipelineTask, 'title' | 'description' | 'priority' | 'labels'>, edits: CardEdits): Partial<CardEdits> {
  const out: Partial<CardEdits> = {}
  if (edits.title !== loaded.title) out.title = edits.title
  if (edits.description !== (loaded.description ?? '')) out.description = edits.description
  if (edits.priority !== loaded.priority) out.priority = edits.priority
  const before = loaded.labels ?? []
  if (edits.labels.length !== before.length || edits.labels.some((l, i) => l !== before[i])) out.labels = edits.labels
  return out
}

/**
 * The run-settings half of the same rule. The settings form always builds its whole payload,
 * including `scheduleEnabled`, so a Save after the scheduler disarmed the card (too many failures,
 * budget spent) re-armed it although nobody touched the schedule. Keep only the keys whose value
 * differs from the loaded row (null and undefined count as the same, arrays and objects by value).
 */
export function changedSettingFields<T extends object>(loaded: object, settings: T): Partial<T> {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(settings)) {
    if (!same(v, (loaded as Record<string, unknown>)[k])) (out as Record<string, unknown>)[k] = v
  }
  return out
}

export function hasCardEdits(loaded: Pick<PipelineTask, 'title' | 'description' | 'priority' | 'labels'> | null, edits: CardEdits): boolean {
  return !!loaded && Object.keys(changedCardFields(loaded, edits)).length > 0
}
