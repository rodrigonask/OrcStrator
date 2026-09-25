import fs from 'fs'
import path from 'path'
import os from 'os'
import type { ScannedSkill, SkillInventory, SkillSource } from '@orcstrator/shared'

/**
 * Every skill Claude can see on this machine, read off the disk. No model call.
 *
 * The question "which skills do I have" has a filesystem answer, and it was being answered
 * from the wrong two places: the OrcStrator `skills` table (an in-app concept nobody has
 * ever written a row to) and `~/.claude/commands` (legacy command files). Skills
 * live in `~/.claude/skills/<slug>/SKILL.md`, which neither place looked at.
 *
 * Four sources, in the order Claude itself resolves them:
 *
 *   personal  ~/.claude/skills/<slug>/SKILL.md
 *   project   <project>/.claude/skills/<slug>/SKILL.md, per registered folder
 *   plugin    <installPath>/skills/<slug>/SKILL.md, per ENABLED plugin
 *   command   ~/.claude/commands/*.md and <project>/.claude/commands/*.md
 *
 * The one thing this cannot reach is the CLI's own built-ins (dataviz, code-review,
 * simplify, loop, schedule, …). They are compiled into the `claude` binary as bytecode,
 * so their names survive only in a minified constants table with the descriptions
 * detached. A regex over that blob would be a scraper that quietly returns nothing on the
 * next release, which is worse than an honest omission, so they are left out and the UI
 * says so.
 */

const SKILL_FILE = 'SKILL.md'

/** Scratch dirs a user may keep beside the real skills. Not skills, never invocable. */
function isIgnoredDir(name: string): boolean {
  return name.startsWith('_') || name.startsWith('.') || name === 'node_modules'
}

/**
 * Frontmatter, to the depth these files actually use.
 *
 * Every SKILL.md on disk writes `key: value` on one line (descriptions run to 900
 * characters without wrapping). Block scalars and wrapped continuations are handled
 * anyway because one hand-edited file eventually uses them, and a parser that drops a
 * description silently produces a skill that looks undocumented rather than unparsed.
 */
function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {}
  const lines = text.split(/\r?\n/)
  if (lines[0].trim() !== '---') return {}

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '---' || t === '...') { end = i; break }
  }
  if (end === -1) return {}

  const out: Record<string, string> = {}
  let key: string | null = null
  let block: 'literal' | 'folded' | null = null
  let buf: string[] = []

  const flush = () => {
    if (!key) return
    let v = block === 'literal' ? buf.join('\n') : buf.join(' ')
    v = v.trim()
    out[key] = stripQuotes(v)
    key = null
    block = null
    buf = []
  }

  for (let i = 1; i < end; i++) {
    const raw = lines[i]
    if (!raw.trim() && !block) continue

    const m = raw.match(/^([A-Za-z0-9_-]+):\s?(.*)$/)
    const indented = /^\s/.test(raw)

    if (m && !(block && indented)) {
      flush()
      key = m[1]
      const rest = m[2].trim()
      if (rest === '|' || rest === '|-' || rest === '|+') block = 'literal'
      else if (rest === '>' || rest === '>-' || rest === '>+') block = 'folded'
      else { buf = [rest] }
      continue
    }

    // Continuation of the value above: a wrapped plain scalar, or a block scalar body.
    if (key) buf.push(block === 'literal' ? raw.replace(/^\s{0,4}/, '') : raw.trim())
  }
  flush()
  return out
}

/** The document's own title, used when there is no frontmatter to read. */
function firstHeading(text: string): string {
  const m = text.match(/^#{1,3}\s+(.+?)\s*$/m)
  return m ? m[1].replace(/[*_`]/g, '').trim() : ''
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

function readSkillFile(file: string, source: SkillSource, scope: string, slug: string, invocation: string): ScannedSkill | null {
  let stat: fs.Stats
  try { stat = fs.statSync(file) } catch { return null }

  let head = ''
  try {
    // The frontmatter is the only part anyone reads here, and some SKILL.md files run
    // to 40KB of procedure below the frontmatter. 16KB is far past any realistic header.
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(16384, stat.size))
    fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    head = buf.toString('utf-8')
  } catch { return null }

  const fm = parseFrontmatter(head)
  return {
    name: fm.name || slug,
    slug,
    // Some skills carry no frontmatter at all and
    // open straight on a heading. Claude falls back to that H1 for its own listing, so
    // this does too: the alternative is a page that calls a working skill undocumented.
    description: fm.description || firstHeading(head) || '',
    argumentHint: fm['argument-hint'] || undefined,
    userInvocable: fm['user-invocable'] !== 'false',
    source,
    scope,
    invocation,
    path: file,
    bytes: stat.size,
    mtime: stat.mtimeMs,
  }
}

/** `<root>/<slug>/SKILL.md` for every child directory of root, one level deep. */
function scanSkillDir(root: string, source: SkillSource, scope: string, invocationOf: (slug: string) => string): ScannedSkill[] {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }

  const out: ScannedSkill[] = []
  for (const e of entries) {
    if (!e.isDirectory() || isIgnoredDir(e.name)) continue
    const file = path.join(root, e.name, SKILL_FILE)
    if (!fs.existsSync(file)) continue
    const s = readSkillFile(file, source, scope, e.name, invocationOf(e.name))
    if (s) out.push(s)
  }
  return out
}

/** `<root>/*.md` — slash commands, which are a different thing wearing the same hat. */
function scanCommandDir(root: string, scope: string): ScannedSkill[] {
  let files: string[]
  try { files = fs.readdirSync(root) } catch { return [] }

  const out: ScannedSkill[] = []
  for (const f of files) {
    if (!f.endsWith('.md')) continue
    const slug = f.slice(0, -3)
    const s = readSkillFile(path.join(root, f), 'command', scope, slug, `/${slug}`)
    if (s) out.push(s)
  }
  return out
}

interface InstalledPluginEntry {
  scope?: string
  installPath?: string
  version?: string
}

/**
 * Enabled plugins only, from `installed_plugins.json`.
 *
 * Two traps here, both of which inflate the count by an order of magnitude if you glob
 * instead. `~/.claude/plugins/marketplaces/` carries every plugin the marketplace offers,
 * installed or not (discord, imessage, claude-security …), and `cache/` keeps one folder
 * per version ever pulled: nine of frontend-design alone. The manifest names the exact
 * installPath that is live, so it is the only thing worth reading.
 */
function scanPlugins(): ScannedSkill[] {
  const manifest = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json')
  let json: { plugins?: Record<string, InstalledPluginEntry[]> }
  try { json = JSON.parse(fs.readFileSync(manifest, 'utf-8')) } catch { return [] }

  const out: ScannedSkill[] = []
  const seen = new Set<string>()
  for (const [key, entries] of Object.entries(json.plugins || {})) {
    const pluginName = key.split('@')[0]
    for (const entry of entries || []) {
      if (!entry.installPath || seen.has(entry.installPath)) continue
      seen.add(entry.installPath)
      out.push(...scanSkillDir(
        path.join(entry.installPath, 'skills'),
        'plugin',
        pluginName,
        slug => `/${pluginName}:${slug}`,
      ))
    }
  }
  return out
}

export interface ProjectRoot {
  /** Display name for the group header. */
  name: string
  /** Absolute path to the project checkout. */
  path: string
}

/**
 * Scan everything. `projects` are the folders registered in OrcStrator, which is how a
 * project-scoped skill gets found without a session being open in that directory.
 */
export function scanSkills(projects: ProjectRoot[] = []): SkillInventory {
  const home = os.homedir()
  const skills: ScannedSkill[] = []

  skills.push(...scanSkillDir(path.join(home, '.claude', 'skills'), 'personal', 'Personal', slug => `/${slug}`))
  skills.push(...scanPlugins())

  const seenProjects = new Set<string>()
  for (const p of projects) {
    const root = path.resolve(p.path)
    if (seenProjects.has(root.toLowerCase())) continue
    seenProjects.add(root.toLowerCase())
    skills.push(...scanSkillDir(path.join(root, '.claude', 'skills'), 'project', p.name, slug => `/${slug}`))
  }

  skills.push(...scanCommandDir(path.join(home, '.claude', 'commands'), 'Personal'))
  for (const p of projects) {
    skills.push(...scanCommandDir(path.join(path.resolve(p.path), '.claude', 'commands'), p.name))
  }

  skills.sort((a, b) => a.name.localeCompare(b.name))

  return {
    skills,
    scannedAt: Date.now(),
    roots: {
      personal: path.join(home, '.claude', 'skills'),
      commands: path.join(home, '.claude', 'commands'),
      plugins: path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      projects: projects.map(p => path.resolve(p.path)),
    },
    /**
     * Named so the UI never implies a completeness it does not have: the CLI's own
     * skills are compiled into the binary and cannot be enumerated from disk.
     */
    excludesBuiltIns: true,
  }
}
