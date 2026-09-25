import { useCallback, useMemo, useState } from 'react'
import {
  PERMISSION_SCOPE_BLURBS,
  PERMISSION_SCOPE_LABELS,
  dedupeRules,
  isPermissionScope,
  type PermissionScope,
} from '@shared/permission-rules'
import type { FolderConfig, PermissionRuleSet } from '@shared/types'
import { useUI } from '../context/UIContext'
import { useInstances } from '../context/InstancesContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'
import { mergeProjectRules, projectRuleChain } from '../utils/permissionMatch'

/**
 * The scope an "Allow always" saves at, and the one call that saves it there.
 *
 * WHY THIS IS A HOOK AND NOT TWO COPIES. Two surfaces offer "Allow always", the
 * permission banner and the refusal card, and they already had to be kept in step on what the rule
 * IS (planStandingAllow exists for exactly that). Adding three places a rule can land would have
 * doubled that surface: a scope that saved to the folder on one card and app-wide on the other is
 * not a bug anyone would notice until a grant quietly failed to apply, which is the class of
 * failure this whole area has been fixing for a week.
 *
 * All three scopes are ADDITIVE and unioned at spawn (hook-injector cliSettingsArgs), so picking a
 * narrow one never takes anything away, and a deny still beats every one of them.
 */
export interface PermissionScopeControl {
  scope: PermissionScope
  setScope: (next: PermissionScope) => void
  /** The project this chat sits in, or null when it has no registered folder. */
  project: FolderConfig | null
  /** This chat's inherited project rules, for the matcher. Folder chain, outermost first. */
  projectRules: PermissionRuleSet
  /** "in every chat" / "in every chat in ... including its sub-folders" / "in this chat only". */
  blurb: string
  /** The scope in three words, for a receipt line: "all chats", "this project", "this chat". */
  label: string
  /** Saves the rules at the current scope. Rejects if the save fails, so the caller can say so. */
  save: (rules: string[]) => Promise<void>
}

export function usePermissionScope(instanceId: string | undefined): PermissionScopeControl {
  const { settings } = useUI()
  const { folders, instances } = useInstances()
  const { dispatch } = useAppDispatch()

  const instance = useMemo(() => instances.find(i => i.id === instanceId), [instances, instanceId])
  const project = useMemo(
    () => folders.find(f => f.id === instance?.folderId) ?? null,
    [folders, instance],
  )
  const chain = useMemo(() => projectRuleChain(folders, instance?.folderId), [folders, instance])
  const projectRules = useMemo(() => mergeProjectRules(chain), [chain])

  // The stored preference is the starting point, not the state: a saved 'project' on a chat with no
  // registered folder would offer a scope with nowhere to save to, so it falls back to 'app', which
  // is what both buttons did before the picker existed.
  const remembered = isPermissionScope(settings.lastPermissionScope) ? settings.lastPermissionScope : 'app'
  const [picked, setPicked] = useState<PermissionScope>(remembered)
  const scope: PermissionScope = picked === 'project' && !project ? 'app' : picked === 'chat' && !instance ? 'app' : picked

  const setScope = useCallback((next: PermissionScope) => {
    setPicked(next)
    // Remembered the moment it is PICKED rather than when it is clicked through, so changing your
    // mind and closing the banner still teaches the picker where you work.
    dispatch({ type: 'UPDATE_SETTINGS', payload: { lastPermissionScope: next } })
    api.updateSettings({ lastPermissionScope: next }).catch(err => {
      console.error('The permission scope preference did not save:', err)
    })
  }, [dispatch])

  const save = useCallback(async (rules: string[]) => {
    const list = dedupeRules(rules)
    if (list.length === 0) return

    if (scope === 'app') {
      const res = await api.addPermissionAllowRules(list)
      if (res.permissionAllowRules) {
        dispatch({ type: 'UPDATE_SETTINGS', payload: { permissionAllowRules: res.permissionAllowRules } })
      }
      return
    }

    if (scope === 'project') {
      if (!project) throw new Error('This chat has no project to save to')
      const res = await api.patchFolderPermissionRules(project.id, { add: list })
      dispatch({
        type: 'UPDATE_FOLDER',
        payload: { id: project.id, updates: { permissionRules: res.permissionRules ?? undefined } },
      })
      return
    }

    if (!instance) throw new Error('This chat is gone')
    // Per-chat is the one scope written by a whole-column PUT rather than a server-side append, so
    // every other bucket has to be carried through by hand. Dropping askOnce here would delete a
    // one-time question the operator had just asked for from a refusal card, and the retry would go
    // straight back to the classifier (the same trap PermissionRulesModal.save documents).
    const current = instance.permissionRules ?? {}
    const next: PermissionRuleSet = { ...current, allow: dedupeRules([...(current.allow ?? []), ...list]) }
    dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { permissionRules: next } } })
    await api.updateInstance(instance.id, { permissionRules: next })
  }, [scope, project, instance, dispatch])

  const blurb = scope === 'project' && project
    ? `in every chat in ${project.displayName || project.name || 'this project'}, including its sub-folders`
    : PERMISSION_SCOPE_BLURBS[scope]

  return { scope, setScope, project, projectRules, blurb, label: PERMISSION_SCOPE_LABELS[scope], save }
}
