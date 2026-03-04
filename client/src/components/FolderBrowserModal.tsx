import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import { useApp } from '../context/AppContext'

interface FolderBrowserModalProps {
  onClose: () => void
  onSelect: (path: string) => void
}

interface DirectoryEntry {
  name: string
  path: string
}

export function FolderBrowserModal({ onClose, onSelect }: FolderBrowserModalProps) {
  const { state } = useApp()
  const [currentPath, setCurrentPath] = useState(state.settings.rootFolder || '/')
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.getSubfolders(path)
      setEntries(result.folders)
      setCurrentPath(result.dir)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load directory')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDirectory(currentPath)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const breadcrumbs = currentPath.split(/[\\/]/).filter(Boolean)
  const isWindows = currentPath.includes('\\') || /^[A-Z]:/i.test(currentPath)
  const sep = isWindows ? '\\' : '/'
  const buildPath = (index: number) => {
    if (isWindows) {
      return breadcrumbs.slice(0, index + 1).join('\\')
    }
    return '/' + breadcrumbs.slice(0, index + 1).join('/')
  }

  const handleSelect = useCallback(() => {
    onSelect(currentPath)
    onClose()
  }, [currentPath, onSelect, onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Select Folder</span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body folder-browser">
          {/* Breadcrumb */}
          <div className="folder-breadcrumb">
            {!isWindows && (
              <button
                className="folder-breadcrumb-item"
                onClick={() => loadDirectory('/')}
              >
                /
              </button>
            )}
            {breadcrumbs.map((part, i) => (
              <span key={i}>
                <span className="folder-breadcrumb-sep">{sep}</span>
                <button
                  className="folder-breadcrumb-item"
                  onClick={() => loadDirectory(buildPath(i))}
                >
                  {part}
                </button>
              </span>
            ))}
          </div>

          {/* Current path display */}
          <div className="form-group" style={{ display: 'flex', gap: 6 }}>
            <input
              className="form-input"
              value={currentPath}
              onChange={e => setCurrentPath(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') loadDirectory(currentPath) }}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12, flex: 1 }}
            />
            <button className="btn" onClick={() => loadDirectory(currentPath)} style={{ padding: '4px 12px', fontSize: 12 }}>
              Go
            </button>
          </div>

          {/* Directory listing */}
          {error && <div className="message-error">{error}</div>}
          {loading ? (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
              Loading...
            </div>
          ) : (
            <div className="folder-list">
              {(() => {
                const atRoot = isWindows
                  ? /^[A-Za-z]:\\?$/.test(currentPath)
                  : currentPath === '/'
                if (atRoot) return null
                return (
                  <div
                    className="folder-list-item"
                    onClick={() => {
                      let parent = currentPath.replace(/[\\/][^\\/]+[\\/]?$/, '')
                      // Fix bare drive letter: C: → C:\
                      if (isWindows && /^[A-Za-z]:$/.test(parent)) parent += '\\'
                      if (!parent) parent = '/'
                      loadDirectory(parent)
                    }}
                  >
                    <span className="folder-list-icon">..</span>
                    <span>Parent directory</span>
                  </div>
                )
              })()}
              {entries.map(entry => (
                <div
                  key={entry.path}
                  className="folder-list-item"
                  onClick={() => loadDirectory(entry.path)}
                >
                  <span className="folder-list-icon">{'\uD83D\uDCC2'}</span>
                  <span>{entry.name}</span>
                </div>
              ))}
              {entries.length === 0 && !loading && (
                <div className="folder-list-item" style={{ color: 'var(--text-muted)', cursor: 'default' }}>
                  No subdirectories
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSelect}>Select This Folder</button>
        </div>
      </div>
    </div>
  )
}
