import { createContext, useContext, useState, useCallback, useEffect } from 'react'

interface ConfirmState {
  message: string
  title?: string
  isAlert?: boolean
  resolve: (v: boolean) => void
}

interface ConfirmContextValue {
  confirm: (message: string, title?: string) => Promise<boolean>
  alert: (message: string, title?: string) => Promise<void>
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null)

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider')
  return ctx
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null)

  const confirm = useCallback((message: string, title?: string): Promise<boolean> => {
    return new Promise(resolve => {
      setState({ message, title, isAlert: false, resolve })
    })
  }, [])

  const alert = useCallback((message: string, title?: string): Promise<void> => {
    return new Promise(resolve => {
      setState({ message, title, isAlert: true, resolve: () => resolve() })
    })
  }, [])

  const handleOk = useCallback(() => {
    state?.resolve(true)
    setState(null)
  }, [state])

  const handleCancel = useCallback(() => {
    state?.resolve(false)
    setState(null)
  }, [state])

  useEffect(() => {
    if (!state) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        state.isAlert ? handleOk() : handleCancel()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [state, handleOk, handleCancel])

  return (
    <ConfirmContext.Provider value={{ confirm, alert }}>
      {children}
      {state && (
        <div className="modal-overlay" onClick={state.isAlert ? undefined : handleCancel}>
          <div className="modal-panel confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>
                {state.title || (state.isAlert ? 'Notice' : 'Confirm')}
              </span>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>{state.message}</p>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {!state.isAlert && (
                <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
              )}
              <button className="btn btn-primary" onClick={handleOk} autoFocus>OK</button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
