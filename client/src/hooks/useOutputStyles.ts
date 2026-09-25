import { useEffect, useState } from 'react'
import { OUTPUT_STYLE_BUILTINS } from '@shared/constants'
import { api } from '../api'

export interface OutputStyleOption {
  value: string
  name: string
  description: string
  /** Built-ins render flat; custom ones get grouped under their own label. */
  custom?: boolean
}

/**
 * The output styles a picker should offer: Claude Code's five built-ins, plus any custom
 * markdown styles found in ~/.claude/output-styles (and in `cwd`'s own .claude/output-styles
 * when a chat folder is given). Same list /config shows, assembled the same way.
 *
 * The custom half can only come from the server (they are files on disk), so this fetches
 * once per mount and falls back to the built-ins alone if that fails.
 */
export function useOutputStyles(cwd?: string): OutputStyleOption[] {
  const [custom, setCustom] = useState<OutputStyleOption[]>([])

  useEffect(() => {
    let cancelled = false
    api.getOutputStyles(cwd)
      .then(r => { if (!cancelled) setCustom(r.styles.map(s => ({ ...s, custom: true }))) })
      .catch(() => { /* none on disk is the normal case */ })
    return () => { cancelled = true }
  }, [cwd])

  return [...OUTPUT_STYLE_BUILTINS.map(s => ({ value: s.value, name: s.name, description: s.description })), ...custom]
}
