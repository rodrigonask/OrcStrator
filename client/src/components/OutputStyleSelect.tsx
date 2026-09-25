import { useCallback } from 'react'
import type { InstanceConfig } from '@shared/types'
import { useOutputStyles } from '../hooks/useOutputStyles'
import { useUI } from '../context/UIContext'
import { useAppDispatch } from '../context/AppDispatchContext'
import { api } from '../api'

/**
 * Per-chat output-style override, as one row.
 *
 * Deliberately a native <select> rather than the list-of-buttons the verbosity picker uses:
 * this menu already carries five verbosity rows, and six more would turn it into a scroller.
 * One row, and the OS draws the list.
 *
 * Empty value means "inherit the app-wide setting", which is exactly what the server stores
 * (blank column = not overridden), so there is no third state to keep in sync.
 */
export function OutputStyleSelect({ instance, onChanged }: { instance: InstanceConfig; onChanged?: () => void }) {
  const { settings } = useUI()
  const { dispatch } = useAppDispatch()
  const styles = useOutputStyles(instance.cwd)
  const inherited = settings.outputStyle || 'Default'
  const value = instance.outputStyle ?? ''

  const onChange = useCallback((next: string) => {
    dispatch({ type: 'UPDATE_INSTANCE', payload: { id: instance.id, updates: { outputStyle: next || undefined } } })
    api.updateInstance(instance.id, { outputStyle: next })
      .catch(err => console.error('Failed to set output style:', err))
    onChanged?.()
  }, [dispatch, instance.id, onChanged])

  const builtins = styles.filter(s => !s.custom)
  const custom = styles.filter(s => s.custom)

  return (
    <label className="menu-inline-field" onClick={e => e.stopPropagation()}>
      <span className="menu-inline-label">Output style</span>
      <select
        className="menu-inline-select"
        value={value}
        onChange={e => onChange(e.target.value)}
        onPointerDown={e => e.stopPropagation()}
        title="Changes how Claude writes in this chat. Applies from the next turn."
      >
        <option value="">Inherit ({inherited})</option>
        {builtins.map(s => (
          <option key={s.value} value={s.value}>{s.name}</option>
        ))}
        {custom.length > 0 && (
          <optgroup label="Custom">
            {custom.map(s => (
              <option key={s.value} value={s.value}>{s.name}</option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  )
}
