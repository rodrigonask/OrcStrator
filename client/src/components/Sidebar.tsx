import { useState } from 'react'
import { useApp } from '../context/AppContext'
import { ConnectionStatus } from './ConnectionStatus'
import { FolderGroup } from './FolderGroup'
import { SettingsModal } from './SettingsModal'
import { LevelBar } from './tour/LevelBar'

export function Sidebar() {
  const { state, dispatch } = useApp()
  const [collapsed, setCollapsed] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const usage = state.usage
  const primaryBucket = usage?.buckets?.[0]
  const usagePercent = primaryBucket?.percentage ?? 0
  const usageLabel = primaryBucket?.label ?? 'Usage'
  const usageReset = primaryBucket?.resetCountdown

  const usageBarClass = usagePercent >= 90 ? 'danger' : usagePercent >= 70 ? 'warning' : ''

  return (
    <>
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-header-left">
            <ConnectionStatus />
            <span className="sidebar-title">Nasklaude</span>
          </div>
          <button
            className="sidebar-collapse-btn"
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? '\u25B6' : '\u25C0'}
          </button>
        </div>

        <div className="sidebar-usage">
          <div className="usage-label">
            <span>{usageLabel}</span>
            <span>{Math.round(usagePercent)}%</span>
          </div>
          <div className="usage-bar-track">
            <div
              className={`usage-bar-fill ${usageBarClass}`}
              style={{ width: `${Math.min(usagePercent, 100)}%` }}
            />
          </div>
          {usageReset && <div className="usage-reset">Resets {usageReset}</div>}
        </div>

        <div className="sidebar-folders">
          {state.folders.map(folder => (
            <FolderGroup key={folder.id} folder={folder} />
          ))}
        </div>

        <div className="sidebar-add-folder">
          <button
            className="add-folder-btn"
            onClick={() => dispatch({ type: 'OPEN_FOLDER_BROWSER' })}
          >
            <span>+</span>
            <span>Add Folder</span>
          </button>
        </div>

        <LevelBar />

        <div className="sidebar-footer">
          <button
            className="settings-btn"
            onClick={() => setShowSettings(true)}
          >
            <span>\u2699</span>
            <span className="sidebar-footer-text">Settings</span>
          </button>
        </div>
      </aside>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  )
}
