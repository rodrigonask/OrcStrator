import { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../api'
import type { ScannedSkill, SkillInventory, SkillSource } from '@shared/types'

/**
 * Every skill on disk, read off the filesystem rather than asked for.
 *
 * "Which skills do I have" is a question with a file-tree answer, and until now the only
 * way to get it was to ask a model, which costs a turn and can hallucinate a skill that
 * was deleted last month. This page is one HTTP call to a readdir. It is exact, it is
 * free, and it is the same scanner `/skills` prints, so the two can never drift.
 */

const SOURCE_ORDER: SkillSource[] = ['personal', 'project', 'plugin', 'command']

const SOURCE_LABEL: Record<SkillSource, string> = {
  personal: 'Personal',
  project: 'Project',
  plugin: 'Plugin',
  command: 'Command',
}

/** Muted, not decorative. The page is a list of documents, not a status board. */
const SOURCE_COLOR: Record<SkillSource, string> = {
  personal: 'var(--accent-text)',
  project: '#7aa2f7',
  plugin: '#bb9af7',
  command: 'var(--text-muted)',
}

function groupKey(s: ScannedSkill): string {
  return s.source === 'personal' ? 'Personal' : `${SOURCE_LABEL[s.source]}: ${s.scope}`
}

function SkillRow({ s, expanded, onToggle }: {
  s: ScannedSkill
  expanded: boolean
  onToggle: () => void
}) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(s.invocation).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }).catch(() => {})
  }, [s.invocation])

  return (
    <div
      onClick={onToggle}
      style={{
        borderBottom: '1px solid var(--border)',
        padding: '10px 12px',
        cursor: 'pointer',
        background: expanded ? 'var(--bg-elevated)' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span
          className="font-mono"
          style={{ fontSize: 12, color: 'var(--text-primary)', flexShrink: 0 }}
        >
          {s.invocation}
        </span>
        {s.argumentHint && (
          <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
            {s.argumentHint}
          </span>
        )}
        <span
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: expanded ? 'normal' : 'nowrap',
            flex: 1,
            lineHeight: 1.5,
          }}
        >
          {s.description || <em style={{ opacity: 0.6 }}>no description in frontmatter</em>}
        </span>
        <button
          onClick={copy}
          className="font-mono"
          style={{
            fontSize: 10,
            padding: '2px 8px',
            flexShrink: 0,
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 4,
            color: copied ? 'var(--accent-text)' : 'var(--text-muted)',
            cursor: 'pointer',
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {expanded && (
        <div
          className="font-mono"
          style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, wordBreak: 'break-all' }}
        >
          {s.path}
          <span style={{ marginLeft: 12 }}>{Math.round(s.bytes / 1024)}KB</span>
          {!s.userInvocable && (
            <span style={{ marginLeft: 12, color: 'var(--warning)' }}>not user-invocable</span>
          )}
        </div>
      )}
    </div>
  )
}

export function SkillsPage() {
  const [inv, setInv] = useState<SkillInventory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const fetchSkills = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setInv(await api.getAvailableSkills())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSkills() }, [fetchSkills])

  const groups = useMemo(() => {
    if (!inv) return []
    const q = filter.trim().toLowerCase()
    const matched = q
      ? inv.skills.filter(s =>
          s.name.toLowerCase().includes(q) ||
          s.invocation.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q))
      : inv.skills

    const byGroup = new Map<string, ScannedSkill[]>()
    for (const s of matched) {
      const k = groupKey(s)
      const list = byGroup.get(k)
      if (list) list.push(s)
      else byGroup.set(k, [s])
    }
    return [...byGroup.entries()].sort((a, b) => {
      const sa = SOURCE_ORDER.indexOf(a[1][0].source)
      const sb = SOURCE_ORDER.indexOf(b[1][0].source)
      return sa !== sb ? sa - sb : a[0].localeCompare(b[0])
    })
  }, [inv, filter])

  const shown = groups.reduce((n, g) => n + g[1].length, 0)

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1100, margin: '0 auto', overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <h2 className="font-pixel" style={{ fontSize: 14, margin: 0 }}>Skills</h2>
        <button
          className="add-folder-btn"
          onClick={fetchSkills}
          disabled={loading}
          style={{ padding: '4px 12px' }}
        >
          <span className="font-mono" style={{ fontSize: 11 }}>{loading ? 'Scanning...' : 'Rescan'}</span>
        </button>
      </div>

      <div className="font-mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
        Read straight off disk, no model involved.
        {inv && ` ${inv.skills.length} found.`}
      </div>

      {error && (
        <div className="font-mono" style={{ color: 'var(--error)', marginBottom: 12, fontSize: 12, lineHeight: 1.6 }}>
          {error}
          {/* The scanner route ships with a server change, and dev-watch holds its restart
              until no chat is running anywhere. Between merge and that lull the page is
              live but the endpoint is not, which reads as a broken feature unless it says
              otherwise. */}
          {/not found/i.test(error) && (
            <div style={{ color: 'var(--text-muted)', marginTop: 6 }}>
              The scanner endpoint is not live yet. The dev server restart is queued and fires
              once every chat is idle.
            </div>
          )}
        </div>
      )}

      <input
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="Filter by name or description"
        className="font-mono"
        style={{
          width: '100%',
          padding: '7px 10px',
          fontSize: 12,
          marginBottom: 16,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          color: 'var(--text-primary)',
        }}
      />

      {groups.map(([label, items]) => (
        <div key={label} style={{ marginBottom: 22 }}>
          <div
            className="font-mono"
            style={{
              fontSize: 11,
              color: SOURCE_COLOR[items[0].source],
              marginBottom: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {label}
            <span style={{ color: 'var(--text-muted)' }}>{items.length}</span>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            {items.map(s => (
              <SkillRow
                key={s.path}
                s={s}
                expanded={expanded === s.path}
                onToggle={() => setExpanded(expanded === s.path ? null : s.path)}
              />
            ))}
          </div>
        </div>
      ))}

      {!loading && inv && shown === 0 && (
        <div className="font-mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {filter ? 'Nothing matches that filter.' : 'No skills found on disk.'}
        </div>
      )}

      {/* Stated rather than quietly omitted: the CLI's own skills live inside the binary
          as bytecode, so a disk scan cannot see them and no amount of scraping would
          survive the next release. Better an honest gap than a list that looks complete. */}
      {inv?.excludesBuiltIns && (
        <div
          className="font-mono"
          style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 28, lineHeight: 1.7, opacity: 0.75 }}
        >
          Built-in CLI skills (/code-review, /dataviz, /simplify, /loop …) are compiled into the
          claude binary and are not on disk, so they are not listed here.
          <br />
          Scanned: {inv.roots.personal} · {inv.roots.commands} · {inv.roots.plugins} ·{' '}
          {inv.roots.projects.length} project {inv.roots.projects.length === 1 ? 'checkout' : 'checkouts'}
        </div>
      )}
    </div>
  )
}
