import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import { useUI } from '../context/UIContext'

interface FolderBrowserModalProps {
  rootFolder?: string
  onClose: () => void
  onSelect: (path: string) => void
}

interface DirectoryEntry {
  name: string
  path: string
}

export function FolderBrowserModal({ rootFolder, onClose, onSelect }: FolderBrowserModalProps) {
  const { settings } = useUI()
  const effectiveRoot = rootFolder || settings.rootFolder

  // If rootFolder is set, show simple subfolder picker
  if (effectiveRoot) {
    return (
      <RootScopedBrowser
        rootFolder={effectiveRoot}
        onClose={onClose}
        onSelect={onSelect}
      />
    )
  }

  // Fallback: full browser (no rootFolder configured)
  return (
    <FullBrowser
      initialPath="/"
      onClose={onClose}
      onSelect={onSelect}
    />
  )
}

// Navigable subfolder picker scoped to rootFolder
function RootScopedBrowser({
  rootFolder,
  onClose,
  onSelect,
}: {
  rootFolder: string
  onClose: () => void
  onSelect: (path: string) => void
}) {
  const [currentPath, setCurrentPath] = useState(rootFolder)
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const isAtRoot = currentPath === rootFolder

  const loadDirectory = useCallback((dir: string) => {
    setLoading(true)
    setError(null)
    api.getSubfolders(dir)
      .then(result => {
        setEntries(result.folders)
        setCurrentPath(result.dir)
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadDirectory(rootFolder)
  }, [rootFolder, loadDirectory])

  const goUp = useCallback(() => {
    let parent = currentPath.replace(/[\\/][^\\/]+[\\/]?$/, '')
    if (/^[A-Za-z]:$/.test(parent)) parent += '\\'
    if (!parent) parent = rootFolder
    // Don't navigate above rootFolder
    if (parent.length < rootFolder.length) parent = rootFolder
    loadDirectory(parent)
  }, [currentPath, rootFolder, loadDirectory])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Add Project</span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body folder-browser">
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            Showing subfolders of: <strong>{currentPath}</strong>
          </div>

          {error && <div className="message-error">{error}</div>}
          {loading ? (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
              Loading...
            </div>
          ) : (
            <div className="folder-list">
              {!isAtRoot && (
                <div className="folder-list-item" onClick={goUp}>
                  <span className="folder-list-icon">..</span>
                  <span>Back</span>
                </div>
              )}
              {entries.map(entry => (
                <div
                  key={entry.path}
                  className="folder-list-item"
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span
                    style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                    onClick={() => onSelect(entry.path)}
                  >
                    <span className="folder-list-icon">{'\uD83D\uDCC2'}</span>
                    <span>{entry.name}</span>
                  </span>
                  <button
                    className="btn"
                    onClick={() => loadDirectory(entry.path)}
                    style={{ padding: '2px 8px', fontSize: 11, flexShrink: 0 }}
                    title={`Browse into ${entry.name}`}
                  >
                    {'\u25BC'}
                  </button>
                </div>
              ))}
              {entries.length === 0 && (
                <div className="folder-list-item" style={{ color: 'var(--text-muted)', cursor: 'default' }}>
                  No subfolders found
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          {!isAtRoot && (
            <button className="btn btn-primary" onClick={() => onSelect(currentPath)} style={{ marginRight: 'auto' }}>
              Select This Folder
            </button>
          )}
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// Full browser with navigation (fallback when no rootFolder)
function FullBrowser({
  initialPath,
  onClose,
  onSelect,
}: {
  initialPath: string
  onClose: () => void
  onSelect: (path: string) => void
}) {
  const [currentPath, setCurrentPath] = useState(initialPath)
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isWindows = currentPath.includes('\\') || /^[A-Z]:/i.test(currentPath)
  const atRoot = isWindows
    ? /^[A-Za-z]:\\?$/.test(currentPath)
    : currentPath === '/'

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

  const handleSelect = useCallback(() => {
    onSelect(currentPath)
    onClose()
  }, [currentPath, onSelect, onClose])

  const sep = isWindows ? '\\' : '/'
  const breadcrumbs = currentPath.split(/[\\/]/).filter(Boolean)
  const buildPath = (index: number) => {
    if (isWindows) return breadcrumbs.slice(0, index + 1).join('\\')
    return '/' + breadcrumbs.slice(0, index + 1).join('/')
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Select Project</span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body folder-browser">
          {/* Breadcrumb */}
          <div className="folder-breadcrumb">
            {!isWindows && (
              <button className="folder-breadcrumb-item" onClick={() => loadDirectory('/')}>
                /
              </button>
            )}
            {breadcrumbs.map((part, i) => (
              <span key={i}>
                <span className="folder-breadcrumb-sep">{sep}</span>
                <button className="folder-breadcrumb-item" onClick={() => loadDirectory(buildPath(i))}>
                  {part}
                </button>
              </span>
            ))}
          </div>

          {/* Editable path */}
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
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>Loading...</div>
          ) : (
            <div className="folder-list">
              {!atRoot && (
                <div
                  className="folder-list-item"
                  onClick={() => {
                    let parent = currentPath.replace(/[\\/][^\\/]+[\\/]?$/, '')
                    if (isWindows && /^[A-Za-z]:$/.test(parent)) parent += '\\'
                    if (!parent) parent = '/'
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
          <button className="btn btn-primary" onClick={handleSelect}>Select This Project</button>
        </div>
      </div>
    </div>
  )
}
