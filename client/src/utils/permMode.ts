import type { PermissionMode } from '@shared/types'

/**
 * Per-instance permission mode, as picked in the composer toggle.
 *
 * Lives in localStorage rather than the DB so it survives refreshes and new tabs —
 * which also means the SERVER cannot see it. Any server-side flow that spawns a turn
 * on the user's behalf (plan approval, etc.) has to be told the mode explicitly, or it
 * will silently run under a different one than the UI is showing.
 */
// The key lives with every other per-chat key, so deleting a chat can clean them all up.
import { PERM_KEY } from './chatStorage'
export { PERM_KEY }

/** Resolve an instance's effective mode: per-instance pick → global default. */
export function readPermMode(instanceId: string, fallback: PermissionMode): PermissionMode {
  return (localStorage.getItem(PERM_KEY(instanceId)) as PermissionMode | null) || fallback
}

/**
 * The CLI flag for a permission mode. 'bypassPermissions' is spelled as its own flag; every other
 * mode rides `--permission-mode`.
 *
 * EVERY turn this app starts has to carry one, and that is not a style preference.
 * `globalFlags` on an older install is often `['--dangerously-skip-permissions']` (new installs
 * start on `--permission-mode=auto`), and the send route only
 * strips it when the message itself names a permission mode. So a turn started WITHOUT a mode flag
 * does not run in the chat's mode, it runs in BYPASS. For example, a refusal-card retry queued
 * through /btw with no flags would spawn with `--dangerously-skip-permissions` on a chat the
 * operator had set to auto (visible in the server's own spawn log). The banner would still
 * appear, because the CLI honours an ask rule from the settings file even under bypass, but
 * everything else in that turn would be ungated.
 *
 * A mirror of `permissionFlag` in server/src/services/turn-flags.ts, which exists for the same
 * reason on the card-start path. If a third caller appears, it goes through one of these two.
 */
export function permissionModeFlag(mode: PermissionMode): string {
  return mode === 'bypassPermissions' ? '--dangerously-skip-permissions' : `--permission-mode=${mode}`
}
