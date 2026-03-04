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
      const dirs = await api.listDirectories(path)
      setEntries(dirs)
      setCurrentPath(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load directory')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDirectory(currentPath)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const breadcrumbs = currentPath.split('/').filter(Boolean)
  const buildPath = (index: number) => '/' + breadcrumbs.slice(0, index + 1).join('/')

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
            <button
              className="folder-breadcrumb-item"
              onClick={() => loadDirectory('/')}
            >
              /
            </button>
            {breadcrumbs.map((part, i) => (
              <span key={i}>
                <span className="folder-breadcrumb-sep">/</span>
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
          <div className="form-group">
            <input
              className="form-input"
              value={currentPath}
              readOnly
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
            />
          </div>

          {/* Directory listing */}
          {error && <div className="message-error">{error}</div>}
          {loading ? (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
              Loading...
            </div>
          ) : (
            <div className="folder-list">
              {currentPath !== '/' && (
                <div
                  className="folder-list-item"
                  onClick={() => {
                    const parent = currentPath.split('/').slice(0, -1).join('/') || '/'
                    loadDirectory(parent)
                  }}
                >
                  <span className="folder-list-icon">..</span>
                  <span>Parent directory</span>
                </div>
              )}
              {entries.map(entry => (
                <div
                  key={entry.path}
                  className="folder-list-item"
                  onClick={() => loadDirectory(entry.path)}
                >
                  <span className="folder-list-icon">\uD83D\uDCC2</span>
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
