import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Catches a render error so it costs one tile, not the whole window.
 *
 * Before this there was no boundary anywhere, so one malformed message or card turned the
 * app white with no way back for someone who does not open DevTools. Two uses:
 *
 *   - `variant="app"` around <App/>: last resort, offers a full reload.
 *   - `variant="tile"` around each Grid tile: the rest of the grid keeps working, and
 *     "Reload tile" re-mounts just that one.
 *
 * The error text is shown small and collapsed: useful when reporting it, never the headline.
 */
interface Props {
  variant: 'app' | 'tile'
  children: ReactNode
  /** Tile only: take the broken tile out of the grid. */
  onRemove?: () => void
  /** Tile only: the chat's name, so the card says which of several tiles broke. */
  label?: string
}

interface State {
  error: Error | null
  attempt: number
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.variant}]`, error, info.componentStack)
  }

  private retry = () => {
    this.setState(s => ({ error: null, attempt: s.attempt + 1 }))
  }

  render(): ReactNode {
    const { error, attempt } = this.state
    if (!error) {
      // `key` re-mounts the subtree on retry, so a tile starts clean instead of re-rendering
      // the same broken state it just threw from.
      return <ErrorBoundaryChildren key={attempt}>{this.props.children}</ErrorBoundaryChildren>
    }

    if (this.props.variant === 'tile') {
      return (
        <div className="error-boundary error-boundary-tile" role="alert">
          <div className="error-boundary-title">{this.props.label ? `"${this.props.label}" could not be shown` : 'This chat could not be shown'}</div>
          <div className="error-boundary-text">Something in it did not display correctly. The chat itself is fine.</div>
          <div className="error-boundary-actions">
            <button className="btn btn-ghost" onClick={this.retry}>Reload tile</button>
            {this.props.onRemove && <button className="btn btn-ghost" onClick={this.props.onRemove}>Remove from grid</button>}
          </div>
          <details className="error-boundary-details">
            <summary>Details</summary>
            <code>{error.message}</code>
          </details>
        </div>
      )
    }

    return (
      <div className="error-boundary error-boundary-app" role="alert">
        <div className="error-boundary-title">OrcStrator hit a display error</div>
        <div className="error-boundary-text">Your chats, cards and routines are safe. Reloading usually fixes it.</div>
        <div className="error-boundary-actions">
          <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload OrcStrator</button>
          <button className="btn btn-ghost" onClick={this.retry}>Try again</button>
        </div>
        <details className="error-boundary-details">
          <summary>Details</summary>
          <code>{error.message}</code>
        </details>
      </div>
    )
  }
}

function ErrorBoundaryChildren({ children }: { children: ReactNode }) {
  return <>{children}</>
}
