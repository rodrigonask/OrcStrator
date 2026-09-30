// The model and effort lists, in ONE place.
//
// They used to be declared inside MessageInput.tsx, which was fine while the composer was
// the only thing that could pick a model. A card can pick one too now, and a second copy of
// this list would drift the first time a model ships: the composer would offer it and the
// card would not, for no reason anybody could see.
//
// The model list itself now lives one level further out, in shared/constants, because the
// SERVER needs it too (the /model command's help text). This file stays as the client's
// door to it so existing imports keep working.
import { MODEL_OPTIONS } from '@shared/constants'

export const MODELS = MODEL_OPTIONS.map(({ id, label }) => ({ id, label }))

export const EFFORT_LEVELS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'xHigh' },
  { id: 'max', label: 'Max' },
]

/**
 * Permission modes a CARD can be set to, with labels that say what actually happens rather
 * than naming the CLI flag. 'default' is deliberately absent as a distinct entry: on a card
 * an unset value means inherit the app-wide setting, and offering both "unset" and "default"
 * would be two names for a difference nobody can act on.
 */
export const CARD_PERMISSION_MODES = [
  { id: 'auto', label: 'Auto' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'plan', label: 'Plan only' },
  { id: 'default', label: 'Ask every time' },
  { id: 'bypassPermissions', label: 'Bypass (never asks, for unattended routines)' },
]
