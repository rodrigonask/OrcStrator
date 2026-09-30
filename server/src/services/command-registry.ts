import { db } from '../db.js'
import { processRegistry } from './process-registry.js'
import { broadcastEvent } from '../ws/handler.js'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { resolveClaudeBinary, CLAUDE_MISSING_MESSAGE } from './claude-binary.js'
import { clearAwaitingInput } from './awaiting-input.js'
import { scanSkills, type ProjectRoot } from './skill-scanner.js'
import { MODEL_ID_MAP, MODEL_OPTIONS } from '@orcstrator/shared'
import { getAdminToken } from './api-auth.js'
import { PORT } from '../config.js'
import { cliSettingsArgs } from './hook-injector.js'
import { redactSecrets } from '@orcstrator/shared'
import { claudeProjectsDir } from './claude-paths.js'

// Resolve once per call; we don't cache locally since claude-binary already does.
// Null when there is no usable binary. Never fall back to a bare "claude.exe": that is a
// PATH and cwd search, which would run exactly the unverified copy the launcher refused
// through ORCSTRATOR_CLAUDE_PATH.
function claudeBin(): string | null {
  return resolveClaudeBinary().path
}

/** The server's own `{ error }` message when it sent one (it is written for people), else the status. */
export function readableError(body: string, status: number): string {
  try {
    const e = (JSON.parse(body) as { error?: unknown }).error
    if (typeof e === 'string' && e) return e
  } catch { /* not JSON */ }
  return `HTTP ${status} ${body.slice(0, 120)}`
}

// === Types ===

export type CommandStrategy =
  | 'skill'           // A: Pass-through to claude -p (agent-side skills)
  | 'cli-subcommand'  // B: Spawn standalone CLI subcommand
  | 'native'          // C: Read files, DB, run git - no claude needed
  | 'client-only'     // D: Server validates, returns action for client
  | 'session-mgmt'    // E: Server-side session operations
  | 'url-redirect'    // F: Return URL for client to open
  | 'not-applicable'  // G: Return helpful message
  | 'session-turn'    // H: Send as a normal turn through the streaming pipeline

export type CommandCategory =
  | 'Session' | 'Model & Effort' | 'Context & Cost' | 'Project & Memory'
  | 'Code Review' | 'Planning' | 'Skills' | 'Configuration'
  | 'Authentication' | 'Diagnostics' | 'Integrations' | 'Clipboard & Export'
  | 'Onboarding'

export interface CommandEntry {
  name: string
  description: string
  strategy: CommandStrategy
  category: CommandCategory
  aliases?: string[]
}

export interface CommandResponse {
  ok: boolean
  result: string
  action?: string   // Client-side action: 'set-model', 'open-url', 'clear-history', etc.
  value?: string    // Value for the action
  url?: string      // URL to open in browser
}

interface CommandContext {
  instanceId: string
  sessionId: string | null
  cwd: string
  args: string       // Everything after the command name
  // Composer picks (model / effort / permission mode) for commands that start a real turn.
  // The client can't set these server-side (they live in localStorage), so a /goal routed
  // through the streaming pipeline must carry them or it silently runs on the defaults.
  flags?: string[]
}

// === Command Registry ===

const REGISTRY: CommandEntry[] = [
  // A: Skill pass-through (already working)
  // session-turn (not skill): /compact must flow through the streaming pipeline so the
  // compaction events reach the parser (ctx gauge reset, chat marker, kind='compact' cost row).
  { name: '/compact',         description: 'Compress conversation context',             strategy: 'session-turn', category: 'Context & Cost' },
  { name: '/context',         description: 'Show context window usage breakdown',       strategy: 'skill', category: 'Context & Cost' },
  { name: '/simplify',        description: 'Review changed code for quality & reuse',   strategy: 'skill', category: 'Code Review' },
  { name: '/security-review', description: 'Analyze branch for security vulnerabilities', strategy: 'skill', category: 'Code Review' },
  { name: '/review',          description: 'Code review current changes',               strategy: 'skill', category: 'Code Review' },
  { name: '/batch',           description: 'Batch edit files',                          strategy: 'skill', category: 'Skills' },
  { name: '/debug',           description: 'Debug current issue',                       strategy: 'skill', category: 'Skills' },
  { name: '/loop',            description: 'Run a command on interval',                 strategy: 'skill', category: 'Skills' },
  { name: '/claude-api',      description: 'Build with the Claude API',                 strategy: 'skill', category: 'Skills' },
  { name: '/schedule',        description: 'Manage scheduled remote agents',            strategy: 'skill', category: 'Skills' },
  // session-turn (not skill): /goal is a NATIVE CLI command (>= 2.1.139), not a skill.
  // Routing it to a skill spawned a one-shot `claude -p` that could never set a goal on
  // THIS session, so the native evaluator loop - the thing that keeps working across turns
  // until the condition holds - never ran. Same reasoning as /compact above.
  { name: '/goal',            description: 'Work until a condition is met (native)',     strategy: 'session-turn', category: 'Planning' },
  { name: '/workflows',       description: 'Create or run a dynamic multi-step workflow', strategy: 'skill', category: 'Planning', aliases: ['/workflow'] },
  { name: '/init',            description: 'Initialize CLAUDE.md for project',          strategy: 'skill', category: 'Project & Memory' },
  { name: '/insights',        description: 'Generate usage insights report',            strategy: 'skill', category: 'Diagnostics' },
  { name: '/extra-usage',     description: 'Open usage/billing management',             strategy: 'skill', category: 'Authentication' },

  // B: CLI subcommand proxy
  { name: '/status',   description: 'Show version, auth, model & account info',  strategy: 'cli-subcommand', category: 'Diagnostics' },
  { name: '/doctor',   description: 'Diagnose installation & settings',          strategy: 'native', category: 'Diagnostics' },
  { name: '/agents',   description: 'List configured agents',                    strategy: 'cli-subcommand', category: 'Configuration' },
  { name: '/mcp',      description: 'List MCP server status',                    strategy: 'cli-subcommand', category: 'Configuration' },
  { name: '/upgrade',  description: 'Show version & upgrade instructions',       strategy: 'cli-subcommand', category: 'Diagnostics' },

  // C: Native implementation
  { name: '/cost',            description: 'Show token usage & cost for session',       strategy: 'native', category: 'Context & Cost' },
  { name: '/usage',           description: 'Show plan usage & rate limits',             strategy: 'native', category: 'Context & Cost' },
  { name: '/stats',           description: 'Daily usage statistics',                    strategy: 'native', category: 'Context & Cost' },
  { name: '/diff',            description: 'Show uncommitted git changes',              strategy: 'native', category: 'Code Review' },
  { name: '/memory',          description: 'Show CLAUDE.md memory files',               strategy: 'native', category: 'Project & Memory' },
  { name: '/help',            description: 'Show all available commands',               strategy: 'native', category: 'Diagnostics' },
  { name: '/copy',            description: 'Copy last assistant reply to clipboard',    strategy: 'native', category: 'Clipboard & Export' },
  { name: '/export',          description: 'Export session transcript',                 strategy: 'native', category: 'Clipboard & Export' },
  { name: '/release-notes',   description: 'Show Claude Code release notes',            strategy: 'native', category: 'Diagnostics' },
  { name: '/skills',          description: 'List available skills',                     strategy: 'native', category: 'Configuration' },
  { name: '/add-dir',         description: 'Add directory to context',                  strategy: 'native', category: 'Project & Memory' },
  { name: '/hooks',           description: 'Show configured hooks',                     strategy: 'native', category: 'Configuration' },
  { name: '/config',          description: 'Show Claude Code settings',                 strategy: 'native', category: 'Configuration' },
  { name: '/permissions',     description: 'Show permission rules',                     strategy: 'native', category: 'Configuration' },
  { name: '/allowed-tools',   description: 'Show allowed tools',                        strategy: 'native', category: 'Configuration' },
  { name: '/tasks',           description: 'Show pipeline tasks for this project',      strategy: 'native', category: 'Planning' },
  { name: '/bashes',          description: 'Show running processes',                    strategy: 'native', category: 'Planning' },
  { name: '/plugin',          description: 'Show installed plugins',                    strategy: 'native', category: 'Configuration' },

  // D: Client-only (server validates, returns action)
  { name: '/clear',     description: 'Clear conversation history',   strategy: 'client-only', category: 'Session' },
  { name: '/model',     description: 'Change AI model',             strategy: 'client-only', category: 'Model & Effort' },
  { name: '/effort',    description: 'Set effort level',            strategy: 'client-only', category: 'Model & Effort' },
  { name: '/fast',      description: 'Toggle fast mode',            strategy: 'client-only', category: 'Model & Effort' },
  { name: '/plan',      description: 'Toggle plan mode',            strategy: 'client-only', category: 'Planning' },
  { name: '/ultraplan', description: 'Enable ultra plan mode',      strategy: 'client-only', category: 'Planning' },
  { name: '/new',       description: 'Create new chat instance',    strategy: 'client-only', category: 'Session' },
  { name: '/exit',      description: 'Kill process',                strategy: 'client-only', category: 'Session', aliases: ['/quit'] },
  { name: '/settings',  description: 'Open settings',               strategy: 'client-only', category: 'Configuration', aliases: ['/theme', '/color'] },
  { name: '/sandbox',   description: 'Toggle sandbox mode',         strategy: 'client-only', category: 'Configuration' },
  { name: '/auto',      description: 'Toggle auto permission mode', strategy: 'client-only', category: 'Configuration' },

  // E: Session management
  { name: '/reset',    description: 'Reset session (kill + clear session ID)',  strategy: 'session-mgmt', category: 'Session' },
  { name: '/rename',   description: 'Rename this chat instance',               strategy: 'session-mgmt', category: 'Session', aliases: ['/name'] },
  { name: '/branch',   description: 'Fork session into a new branch',          strategy: 'session-mgmt', category: 'Session', aliases: ['/fork'] },
  { name: '/resume',   description: 'Resume current session',                  strategy: 'session-mgmt', category: 'Session', aliases: ['/continue'] },
  { name: '/undo',     description: 'Undo last file changes',                  strategy: 'session-mgmt', category: 'Session' },
  { name: '/btw',      description: 'Queue side-note for next message',        strategy: 'session-mgmt', category: 'Session' },

  // F: URL redirect
  { name: '/feedback',            description: 'Submit feedback to Anthropic',              strategy: 'url-redirect', category: 'Diagnostics' },
  { name: '/bug',                 description: 'Report a bug',                              strategy: 'url-redirect', category: 'Diagnostics' },
  { name: '/install-github-app',  description: 'Install Claude GitHub App',                 strategy: 'url-redirect', category: 'Integrations' },
  { name: '/install-slack-app',   description: 'Install Claude Slack App',                  strategy: 'url-redirect', category: 'Integrations' },
  { name: '/web-setup',           description: 'Open Claude Code web interface',            strategy: 'url-redirect', category: 'Integrations' },
  { name: '/passes',              description: 'Open billing & passes',                     strategy: 'url-redirect', category: 'Authentication' },
  { name: '/privacy-settings',    description: 'Open privacy settings',                     strategy: 'url-redirect', category: 'Authentication' },
  { name: '/stickers',            description: 'Get Claude stickers',                       strategy: 'url-redirect', category: 'Onboarding' },
  { name: '/team-onboarding',     description: 'Open team onboarding docs',                 strategy: 'url-redirect', category: 'Onboarding' },
  { name: '/powerup',             description: 'Upgrade plan & billing',                    strategy: 'url-redirect', category: 'Authentication' },

  // G: Not applicable in OrcStrator
  { name: '/keybindings',    description: 'Keybindings (interactive terminal only)',  strategy: 'not-applicable', category: 'Configuration' },
  { name: '/terminal-setup', description: 'Terminal setup (interactive only)',        strategy: 'not-applicable', category: 'Configuration' },
  { name: '/statusline',     description: 'Status line (interactive only)',           strategy: 'not-applicable', category: 'Configuration' },
  { name: '/voice',          description: 'Voice input (not available)',              strategy: 'not-applicable', category: 'Integrations' },
  { name: '/mobile',         description: 'Mobile app link',                         strategy: 'not-applicable', category: 'Integrations', aliases: ['/ios', '/android'] },
  { name: '/ide',            description: 'IDE integration info',                    strategy: 'not-applicable', category: 'Integrations' },
  { name: '/chrome',         description: 'Chrome extension info',                   strategy: 'not-applicable', category: 'Integrations' },
  { name: '/desktop',        description: 'Desktop app info',                        strategy: 'not-applicable', category: 'Integrations', aliases: ['/app'] },
  { name: '/vim',            description: 'Vim mode (interactive only)',             strategy: 'not-applicable', category: 'Configuration' },
  { name: '/login',          description: 'Login (use CLI directly)',                strategy: 'not-applicable', category: 'Authentication' },
  { name: '/logout',         description: 'Logout (use CLI directly)',               strategy: 'not-applicable', category: 'Authentication' },
  { name: '/setup-bedrock',  description: 'Setup AWS Bedrock (use CLI)',             strategy: 'not-applicable', category: 'Authentication' },
  { name: '/setup-vertex',   description: 'Setup Google Vertex (use CLI)',           strategy: 'not-applicable', category: 'Authentication' },
]

// Build lookup maps
const commandMap = new Map<string, CommandEntry>()
for (const entry of REGISTRY) {
  commandMap.set(entry.name, entry)
  if (entry.aliases) {
    for (const alias of entry.aliases) {
      commandMap.set(alias, entry)
    }
  }
}

// === Public API ===

export function lookupCommand(name: string): CommandEntry | undefined {
  return commandMap.get(name.toLowerCase())
}

export function getAllCommands(): CommandEntry[] {
  return REGISTRY
}

export function isValidCommand(name: string): boolean {
  return commandMap.has(name.toLowerCase())
}

// === Dispatcher ===

export async function dispatchCommand(
  command: string,
  ctx: CommandContext,
  strategyOverride?: CommandStrategy
): Promise<CommandResponse> {
  const parts = command.trim().split(/\s+/)
  const name = parts[0].toLowerCase()
  const args = parts.slice(1).join(' ')
  const entry = lookupCommand(name)

  const fullCtx: CommandContext = { ...ctx, args }

  // If no registered entry, use the strategy override (fallback to skill pass-through)
  if (!entry) {
    if (strategyOverride === 'skill') return handleSessionTurn(command, fullCtx)
    return { ok: false, result: `Unknown command: ${name}. Type /help to see available commands.` }
  }

  switch (entry.strategy) {
    case 'skill':
      // A skill is an ordinary turn, so the chat's managed settings, fences and
      // permission mode apply. It used to run as a detached `claude --resume -p` without them.
      return handleSessionTurn(command, fullCtx)
    case 'cli-subcommand':
      return handleCliSubcommand(entry, fullCtx)
    case 'native':
      return handleNative(entry, fullCtx)
    case 'client-only':
      return handleClientOnly(entry, fullCtx)
    case 'session-mgmt':
      return handleSessionMgmt(entry, fullCtx)
    case 'url-redirect':
      return handleUrlRedirect(entry)
    case 'not-applicable':
      return handleNotApplicable(entry)
    case 'session-turn':
      // /goal & friends are fine as the first message (the turn creates the session),
      // but /compact on a session-less chat has nothing to compact - don't spawn a
      // process just to compress an empty context.
      if (entry.name === '/compact' && !fullCtx.sessionId) {
        return { ok: false, result: 'Nothing to compact yet - this chat has no session.' }
      }
      return handleSessionTurn(command, fullCtx)
    default:
      return { ok: false, result: `No handler for strategy: ${entry.strategy}` }
  }
}

// H: Send the command text as a normal user turn so all events flow through the
// streaming pipeline (parser, WS, cost persistence). Returns immediately - the
// turn's progress streams into the chat like any message.
//
// Deliberately NOT session-gated: /send starts a fresh session when the instance has
// none, so a prompt-shaped command can BE the first message of a chat. The old guard
// ("send a message first") forced a throwaway warm-up message before every /goal.
async function handleSessionTurn(command: string, ctx: CommandContext): Promise<CommandResponse> {
  const resp = await fetch(`http://127.0.0.1:${PORT}/api/instances/${ctx.instanceId}/send`, {
    method: 'POST',
    // The server calling itself carries the admin token like the page does.
    headers: { 'Content-Type': 'application/json', 'X-OrcStrator-Token': getAdminToken() },
    body: JSON.stringify({ text: command, flags: ctx.flags ?? [] })
  })
  if (resp.status >= 400) {
    return { ok: false, result: `Could not start: ${readableError(await resp.text(), resp.status)}` }
  }
  return { ok: true, result: 'Running - progress streams into the chat.' }
}

// === Strategy Handlers ===

// B: CLI subcommand proxy - spawn standalone claude subcommand
async function handleCliSubcommand(entry: CommandEntry, ctx: CommandContext): Promise<CommandResponse> {
  const cmd = claudeBin()
  if (!cmd) return { ok: false, result: CLAUDE_MISSING_MESSAGE }
  const env = { ...process.env }
  delete env['CLAUDECODE']

  const subcommands: Record<string, string[]> = {
    '/status': ['--version'],
    '/agents': ['agents'],
    '/mcp':    ['mcp', 'list'],
    '/upgrade': ['--version'],
  }

  const args = subcommands[entry.name] || ['--version']

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ctx.cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let resolved = false

    // Timeout after 30s to prevent hanging (e.g. commands requiring TTY)
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        child.kill()
        resolve({ ok: false, result: `Command timed out after 30s. Output so far:\n${stdout.trim() || stderr.trim() || 'none'}` })
      }
    }, 30_000)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('close', (code) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      let result = stdout.trim() || stderr.trim() || 'No output.'

      // Enrich /status with instance metadata
      if (entry.name === '/status') {
        const inst = db.prepare('SELECT name, state, session_id, agent_id FROM instances WHERE id = ?')
          .get(ctx.instanceId) as Record<string, unknown> | undefined
        if (inst) {
          result += `\n\n--- OrcStrator Instance ---`
          result += `\nName: ${inst.name}`
          result += `\nState: ${inst.state}`
          result += `\nSession: ${inst.session_id || 'none'}`
        }
      }

      // Enrich /upgrade
      if (entry.name === '/upgrade') {
        result += `\n\nTo upgrade: npm install -g @anthropic-ai/claude-code@latest`
      }

      resolve({ ok: code === 0, result })
    })
    child.once('error', () => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      resolve({ ok: false, result: `Failed to run: claude ${args.join(' ')}` })
    })
  })
}

// C: Native implementation
async function handleNative(entry: CommandEntry, ctx: CommandContext): Promise<CommandResponse> {
  switch (entry.name) {
    case '/cost':    return nativeCost(ctx)
    case '/doctor':  return nativeDoctor(ctx)
    case '/usage':   return nativeUsage()
    case '/stats':   return nativeStats()
    case '/diff':    return nativeDiff(ctx)
    case '/memory':  return nativeMemory(ctx)
    case '/help':    return nativeHelp()
    case '/copy':    return nativeCopy(ctx)
    case '/export':  return nativeExport(ctx)
    case '/release-notes': return nativeReleaseNotes()
    case '/skills':  return nativeSkills()
    case '/add-dir': return nativeAddDir(ctx)
    case '/hooks':   return nativeHooks(ctx)
    case '/config':  return nativeConfig(ctx)
    case '/permissions': return nativePermissions(ctx)
    case '/allowed-tools': return nativeAllowedTools(ctx)
    case '/tasks':   return nativeTasks(ctx)
    case '/bashes':  return nativeBashes()
    case '/plugin':  return nativePlugin()
    default:
      return { ok: false, result: `Native handler not implemented for ${entry.name}` }
  }
}

// D: Client-only - server returns an action for the client to execute
async function handleClientOnly(entry: CommandEntry, ctx: CommandContext): Promise<CommandResponse> {
  switch (entry.name) {
    case '/clear':
      return { ok: true, result: 'Clearing conversation history.', action: 'clear-history' }
    case '/model': {
      // The name → ID map and the offered list both live in shared/constants.
      // They used to be retyped here, which is how /model and the composer ended
      // up disagreeing about which models existed.
      const offered = MODEL_OPTIONS.map(m => `${m.short} (${m.label.split(' (')[0]})`).join(', ')
      const requested = ctx.args.trim().toLowerCase()
      if (!requested) {
        return { ok: true, result: `Available models: ${offered}`, action: 'show-models' }
      }
      const modelId = MODEL_ID_MAP[requested] || (requested.startsWith('claude-') ? requested : null)
      if (!modelId) {
        return { ok: false, result: `Unknown model: ${requested}. Available: ${MODEL_OPTIONS.map(m => m.short).join(', ')}` }
      }
      return { ok: true, result: `Model set to ${requested}.`, action: 'set-model', value: modelId }
    }
    case '/effort': {
      const valid = ['low', 'medium', 'high', 'xhigh', 'max']
      const level = ctx.args.trim().toLowerCase()
      if (!level || !valid.includes(level)) {
        return { ok: true, result: `Effort levels: ${valid.join(', ')}. Current effort shown in footer.`, action: 'show-effort' }
      }
      return { ok: true, result: `Effort set to ${level}.`, action: 'set-effort', value: level }
    }
    case '/fast':
      return { ok: true, result: 'Fast mode toggled.', action: 'toggle-fast' }
    case '/plan':
      return { ok: true, result: 'Plan mode toggled.', action: 'toggle-plan-mode' }
    case '/ultraplan':
      return { ok: true, result: 'Ultra plan mode enabled.', action: 'set-plan-mode', value: 'ultra' }
    case '/new':
      return { ok: true, result: 'Creating new chat instance.', action: 'new-instance' }
    case '/exit':
    case '/quit':
      return { ok: true, result: 'Killing process.', action: 'kill-process' }
    case '/settings':
    case '/theme':
    case '/color':
      return { ok: true, result: 'Opening settings.', action: 'open-settings' }
    case '/sandbox':
      return { ok: true, result: 'Sandbox mode toggled.', action: 'toggle-sandbox' }
    case '/auto':
      return { ok: true, result: 'Auto permission mode toggled.', action: 'set-permission-mode', value: 'auto' }
    default:
      return { ok: false, result: `Client-only handler not found for ${entry.name}` }
  }
}

// E: Session management
async function handleSessionMgmt(entry: CommandEntry, ctx: CommandContext): Promise<CommandResponse> {
  switch (entry.name) {
    case '/reset': {
      const [stopped] = await processRegistry.stopChats([ctx.instanceId])
      if (!stopped) return { ok: false, result: 'This chat is still working and could not be stopped, so the session was not reset. Try again, or open the chat and use Force reset in its \u2630 menu.' }
      db.prepare("UPDATE instances SET session_id = NULL, state = 'idle', process_state = 'idle', process_pid = NULL, version = version + 1 WHERE id = ?")
        .run(ctx.instanceId)
      // The session is gone, so any question it was waiting on is gone with it.
      clearAwaitingInput(ctx.instanceId)
      broadcastEvent({ type: 'instance:state', payload: { instanceId: ctx.instanceId, state: 'idle' } })
      return { ok: true, result: 'Session reset. Send a new message to start a fresh session.' }
    }
    case '/rename':
    case '/name': {
      const newName = ctx.args.trim()
      if (!newName) return { ok: false, result: 'Usage: /rename <new-name>' }
      db.prepare('UPDATE instances SET name = ? WHERE id = ?').run(newName, ctx.instanceId)
      const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(ctx.instanceId) as Record<string, unknown>
      broadcastEvent({ type: 'instance:updated', payload: row })
      return { ok: true, result: `Renamed to "${newName}".` }
    }
    case '/branch':
    case '/fork': {
      if (!ctx.sessionId) return { ok: false, result: 'No active session to branch.' }
      return { ok: true, result: `Current session: ${ctx.sessionId}\nTo fork, create a new instance and use --resume with this session ID. OrcStrator will preserve the original.` }
    }
    case '/resume':
    case '/continue': {
      if (ctx.sessionId) {
        return { ok: true, result: `Already in session: ${ctx.sessionId}` }
      }
      return { ok: false, result: 'No session to resume. Send a message to start one.' }
    }
    case '/undo': {
      if (!ctx.sessionId) return { ok: false, result: 'No active session.' }
      const histDir = path.join(os.homedir(), '.claude', 'file-history', ctx.sessionId)
      if (!fs.existsSync(histDir)) {
        return { ok: false, result: 'No file history found for this session.' }
      }
      const files = fs.readdirSync(histDir)
      return { ok: true, result: `File history contains ${files.length} entries for session ${ctx.sessionId}.\nUndo is not yet automated - check ${histDir} to manually restore files.` }
    }
    case '/btw': {
      const note = ctx.args.trim()
      if (!note) return { ok: false, result: 'Usage: /btw <note to prepend to next message>' }
      // Store as metadata on the instance for the next sendMessage to pick up
      db.prepare("UPDATE instances SET specialization = ? WHERE id = ?")
        .run(`[btw] ${note}`, ctx.instanceId)
      return { ok: true, result: `Side-note queued: "${note}"\nIt will be prepended to your next message.` }
    }
    default:
      return { ok: false, result: `Session handler not implemented for ${entry.name}` }
  }
}

// F: URL redirect
function handleUrlRedirect(entry: CommandEntry): CommandResponse {
  const urls: Record<string, string> = {
    '/feedback':           'https://github.com/anthropics/claude-code/issues',
    '/bug':                'https://github.com/anthropics/claude-code/issues/new',
    '/install-github-app': 'https://github.com/apps/claude',
    '/install-slack-app':  'https://slack.com/apps',
    '/web-setup':          'https://claude.ai/code',
    '/passes':             'https://console.anthropic.com/settings/billing',
    '/privacy-settings':   'https://console.anthropic.com/settings/privacy',
    '/stickers':           'https://www.anthropic.com/stickers',
    '/team-onboarding':    'https://docs.anthropic.com/en/docs/claude-code/team-setup',
    '/powerup':            'https://console.anthropic.com/settings/billing',
  }
  const url = urls[entry.name]
  if (!url) return { ok: false, result: `No URL mapped for ${entry.name}` }
  return { ok: true, result: `${entry.description}\n${url}`, action: 'open-url', url }
}

// G: Not applicable
function handleNotApplicable(entry: CommandEntry): CommandResponse {
  const messages: Record<string, string> = {
    '/keybindings':    'Keybindings are only available in the interactive Claude Code terminal. Use Ctrl+K in OrcStrator for the command palette.',
    '/terminal-setup': 'Terminal setup is for the interactive CLI. OrcStrator manages its own terminal display.',
    '/statusline':     'Status line is for the interactive CLI terminal. OrcStrator shows status in the chat header.',
    '/voice':          'Voice input is not yet available in OrcStrator.',
    '/mobile':         'Claude Code mobile apps: iOS and Android apps are available from Anthropic.',
    '/ios':            'Claude Code mobile apps: iOS and Android apps are available from Anthropic.',
    '/android':        'Claude Code mobile apps: iOS and Android apps are available from Anthropic.',
    '/ide':            'IDE integrations: Claude Code has extensions for VS Code and JetBrains.',
    '/chrome':         'Chrome extension: Visit the Chrome Web Store and search for Claude.',
    '/desktop':        'Desktop app: Download from claude.ai or use Claude Code CLI directly.',
    '/app':            'Desktop app: Download from claude.ai or use Claude Code CLI directly.',
    '/vim':            'Vim mode is only available in the interactive Claude Code terminal.',
    '/login':          'Login/logout must be done from the CLI directly: run "claude login" in your terminal.',
    '/logout':         'Login/logout must be done from the CLI directly: run "claude logout" in your terminal.',
    '/setup-bedrock':  'AWS Bedrock setup must be done from the CLI: run "claude setup-bedrock" in your terminal.',
    '/setup-vertex':   'Google Vertex setup must be done from the CLI: run "claude setup-vertex" in your terminal.',
  }
  return { ok: true, result: messages[entry.name] || `${entry.name} is not available in OrcStrator.` }
}

// === Native Implementation Handlers ===

async function nativeDoctor(ctx: CommandContext): Promise<CommandResponse> {
  const checks: string[] = []

  // 1. Version
  const version = await new Promise<string>((resolve) => {
    const cmd = claudeBin()
    if (!cmd) { resolve('not set up'); return }
    const child = spawn(cmd, ['--version'], {
      cwd: ctx.cwd, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    child.once('close', () => resolve(out.trim()))
    child.once('error', () => resolve('unknown'))
    setTimeout(() => { child.kill(); resolve('timeout') }, 10_000)
  })
  checks.push(version === 'not set up' ? `[✗] ${CLAUDE_MISSING_MESSAGE}` : `[✓] Claude Code version: ${version}`)

  // 2. ripgrep
  const hasRg = await new Promise<boolean>((resolve) => {
    const child = spawn('rg', ['--version'], {
      shell: process.platform === 'win32', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.once('close', (code) => resolve(code === 0))
    child.once('error', () => resolve(false))
    setTimeout(() => { child.kill(); resolve(false) }, 5_000)
  })
  checks.push(hasRg ? '[✓] ripgrep: installed' : '[✗] ripgrep: NOT found (search may be slower)')

  // 3. CLAUDE.md files
  const globalMd = path.join(os.homedir(), '.claude', 'CLAUDE.md')
  const projectMd = path.join(ctx.cwd, 'CLAUDE.md')
  for (const f of [globalMd, projectMd]) {
    if (fs.existsSync(f)) {
      const size = fs.statSync(f).size
      const tokens = Math.round(size / 4) // rough estimate
      const warn = tokens > 15000 ? ' ⚠ LARGE (>15K tokens)' : ''
      checks.push(`[✓] ${f}: ${tokens} tokens${warn}`)
    }
  }

  // 4. Settings
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  if (fs.existsSync(settingsPath)) {
    checks.push('[✓] settings.json: found')
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      const channel = settings.autoUpdatesChannel || 'stable'
      checks.push(`[✓] Auto-update channel: ${channel}`)
    } catch {
      checks.push('[✗] settings.json: invalid JSON')
    }
  } else {
    checks.push('[-] settings.json: not found (using defaults)')
  }

  // 5. MCP config
  const mcpGlobal = path.join(os.homedir(), '.claude', '.mcp.json')
  const mcpProject = path.join(ctx.cwd, '.mcp.json')
  for (const f of [mcpGlobal, mcpProject]) {
    if (fs.existsSync(f)) {
      try {
        const mcp = JSON.parse(fs.readFileSync(f, 'utf-8'))
        const count = Object.keys(mcp.mcpServers || {}).length
        checks.push(`[✓] ${f}: ${count} servers`)
      } catch {
        checks.push(`[✗] ${f}: invalid JSON`)
      }
    }
  }

  // 6. Credentials
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json')
  if (fs.existsSync(credPath)) {
    try {
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'))
      const sub = creds.claudeAiOauth?.subscriptionType || 'unknown'
      checks.push(`[✓] Authenticated: ${sub} plan`)
    } catch {
      checks.push('[✗] credentials: invalid')
    }
  } else {
    checks.push('[✗] Not authenticated (no credentials found)')
  }

  return { ok: true, result: `Doctor Diagnostics\n\n${checks.join('\n')}` }
}

function nativeCost(ctx: CommandContext): CommandResponse {
  // Per-chat cost lives in turn_costs, keyed by (instance_id, session_id) - the exact source
  // the chat header uses. token_usage is only populated for pipeline tasks, so reading it
  // here left /cost permanently empty for normal chat instances. Mirror the header's query.
  const row = ctx.sessionId
    ? (db.prepare(`
        SELECT COALESCE(SUM(COALESCE(NULLIF(cost_usd, 0), computed_cost_usd, 0)), 0) AS cost,
               COALESCE(SUM(input_tokens), 0)        AS inp,
               COALESCE(SUM(output_tokens), 0)       AS out,
               COALESCE(SUM(cache_read_tokens), 0)   AS cacheRead,
               COUNT(*)                              AS turns
        FROM turn_costs WHERE instance_id = ? AND session_id = ?
      `).get(ctx.instanceId, ctx.sessionId) as { cost: number; inp: number; out: number; cacheRead: number; turns: number })
    : undefined

  const toolSummary = summarizeToolUsage(ctx.instanceId)

  if ((!row || !row.turns) && !toolSummary) {
    return { ok: true, result: 'No usage recorded for this chat yet.' }
  }

  let result = ''
  if (row && row.turns) {
    const cacheRate = row.inp > 0 ? Math.round((row.cacheRead / row.inp) * 100) : 0
    result =
      `Session Cost Summary\n` +
      `  Input tokens:  ${row.inp.toLocaleString()}\n` +
      `  Output tokens: ${row.out.toLocaleString()}\n` +
      `  Cache read:    ${row.cacheRead.toLocaleString()} (${cacheRate}% of input)\n` +
      `  Estimated cost: $${row.cost.toFixed(4)}\n` +
      `  Turns: ${row.turns}`
  }
  if (toolSummary) result += (result ? `\n\n` : '') + toolSummary
  return { ok: true, result }
}

// Counts tool-call blocks across this instance's assistant messages, grouped by category.
// Categories are derived from the tool name: mcp__<server>__* → MCP (by server),
// Task/Agent → subagents, Skill → skills, everything else → built-in. (Plugin usage is
// not a distinct tool type - plugins surface as MCP servers or skills, counted there.)
function summarizeToolUsage(instanceId: string): string | null {
  const msgs = db.prepare(
    `SELECT content FROM messages WHERE instance_id = ? AND role = 'assistant'`
  ).all(instanceId) as Array<{ content: string }>
  if (!msgs.length) return null

  const builtin = new Map<string, number>()
  const subagents = new Map<string, number>()
  const skills = new Map<string, number>()
  const mcp = new Map<string, number>()
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1)
  let total = 0

  for (const row of msgs) {
    let blocks: Array<{ type?: string; toolName?: string }>
    try { blocks = JSON.parse(row.content) } catch { continue }
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b.type !== 'tool-call' || !b.toolName) continue
      total++
      const name = b.toolName
      if (name.startsWith('mcp__')) bump(mcp, name.split('__')[1] || 'unknown')
      else if (name === 'Task' || name === 'Agent') bump(subagents, name)
      else if (name === 'Skill') bump(skills, name)
      else bump(builtin, name)
    }
  }
  if (!total) return null

  const fmt = (label: string, m: Map<string, number>): string | null => {
    const sum = [...m.values()].reduce((a, c) => a + c, 0)
    if (!sum) return null
    const detail = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')
    return `  ${label.padEnd(11)}${String(sum).padStart(4)}  (${detail})`
  }
  const lines = [
    fmt('Built-in', builtin),
    fmt('Subagents', subagents),
    fmt('Skills', skills),
    fmt('MCP', mcp),
  ].filter(Boolean)
  return `Tool Usage (this chat, ${total} calls)\n${lines.join('\n')}`
}

function nativeUsage(): CommandResponse {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json')
  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'))
    const oauth = creds.claudeAiOauth || {}
    return {
      ok: true,
      result: `Account Info\n` +
        `  Subscription: ${oauth.subscriptionType || 'unknown'}\n` +
        `  Rate limit tier: ${oauth.rateLimitTier || 'unknown'}\n` +
        `  Token expires: ${oauth.expiresAt ? new Date(oauth.expiresAt).toLocaleString() : 'unknown'}`
    }
  } catch {
    return { ok: true, result: 'Could not read credentials. Run "claude login" to authenticate.' }
  }
}

function nativeStats(): CommandResponse {
  const rows = db.prepare(`
    SELECT date(created_at / 1000, 'unixepoch', 'localtime') as day,
           COUNT(*) as sessions,
           SUM(input_tokens) as inp,
           SUM(output_tokens) as out,
           SUM(cost_usd) as cost
    FROM token_usage
    WHERE created_at > ?
    GROUP BY day
    ORDER BY day DESC
    LIMIT 14
  `).all(Date.now() - 14 * 86400000) as Array<{ day: string; sessions: number; inp: number; out: number; cost: number }>

  if (!rows.length) return { ok: true, result: 'No usage data in the last 14 days.' }

  let table = 'Daily Usage (last 14 days)\n'
  table += '  Day          Sessions  Input       Output      Cost\n'
  for (const r of rows) {
    table += `  ${r.day}   ${String(r.sessions).padStart(5)}  ${String(r.inp || 0).padStart(10)}  ${String(r.out || 0).padStart(10)}  $${(r.cost || 0).toFixed(4)}\n`
  }
  return { ok: true, result: table }
}

async function nativeDiff(ctx: CommandContext): Promise<CommandResponse> {
  return new Promise((resolve) => {
    const child = spawn('git', ['--no-optional-locks', 'diff', '--stat'], {
      cwd: ctx.cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('close', () => {
      resolve({ ok: true, result: stdout.trim() || 'No uncommitted changes.' })
    })
    child.once('error', () => {
      resolve({ ok: false, result: 'Failed to run git diff.' })
    })
  })
}

function nativeMemory(ctx: CommandContext): CommandResponse {
  const files: string[] = []
  const globalMd = path.join(os.homedir(), '.claude', 'CLAUDE.md')
  const projectMd = path.join(ctx.cwd, 'CLAUDE.md')
  const localMd = path.join(ctx.cwd, '.claude', 'CLAUDE.md')

  let result = 'CLAUDE.md Memory Files\n'
  for (const f of [globalMd, projectMd, localMd]) {
    if (fs.existsSync(f)) {
      files.push(f)
      const content = fs.readFileSync(f, 'utf-8')
      const lines = content.split('\n').length
      result += `\n  ${f}\n    ${lines} lines, ${content.length} chars\n`
    }
  }
  if (!files.length) {
    result += '  No CLAUDE.md files found. Use /init to create one.'
  }
  return { ok: true, result }
}

function nativeHelp(): CommandResponse {
  const categories = new Map<string, CommandEntry[]>()
  for (const entry of REGISTRY) {
    const cat = entry.category
    if (!categories.has(cat)) categories.set(cat, [])
    categories.get(cat)!.push(entry)
  }

  let result = 'Available Commands\n'
  for (const [cat, entries] of categories) {
    result += `\n  ${cat}\n`
    for (const e of entries) {
      const aliases = e.aliases ? ` (${e.aliases.join(', ')})` : ''
      result += `    ${e.name.padEnd(22)} ${e.description}${aliases}\n`
    }
  }
  result += '\nTip: Type / in the message box or press Ctrl+K for the command palette.'
  return { ok: true, result }
}

function nativeCopy(ctx: CommandContext): CommandResponse {
  const msg = db.prepare(`
    SELECT content FROM messages
    WHERE instance_id = ? AND role = 'assistant'
    ORDER BY created_at DESC LIMIT 1
  `).get(ctx.instanceId) as { content: string } | undefined

  if (!msg) return { ok: false, result: 'No assistant messages found.' }
  try {
    const blocks = JSON.parse(msg.content)
    const text = blocks
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('\n')
    return { ok: true, result: text || 'Last reply had no text content.', action: 'copy-to-clipboard', value: text }
  } catch {
    return { ok: false, result: 'Failed to parse last message.' }
  }
}

function nativeExport(ctx: CommandContext): CommandResponse {
  if (!ctx.sessionId) return { ok: false, result: 'No active session.' }

  // Find the session JSONL file
  const claudeDir = claudeProjectsDir()
  if (!fs.existsSync(claudeDir)) {
    return { ok: false, result: 'No Claude projects directory found.' }
  }

  // Search for session file
  const projectDirs = fs.readdirSync(claudeDir)
  for (const dir of projectDirs) {
    const sessionFile = path.join(claudeDir, dir, `${ctx.sessionId}.jsonl`)
    if (fs.existsSync(sessionFile)) {
      const stat = fs.statSync(sessionFile)
      const sizeKb = (stat.size / 1024).toFixed(1)
      return { ok: true, result: `Session transcript: ${sessionFile}\nSize: ${sizeKb} KB\n\nTo export, copy this file or open it in a text editor.` }
    }
  }
  return { ok: false, result: `Session file not found for ${ctx.sessionId}.` }
}

function nativeReleaseNotes(): CommandResponse {
  const changelogPath = path.join(os.homedir(), '.claude', 'cache', 'changelog.md')
  if (!fs.existsSync(changelogPath)) {
    return { ok: true, result: 'No cached changelog found. Visit https://github.com/anthropics/claude-code/releases for release notes.' }
  }
  const content = fs.readFileSync(changelogPath, 'utf-8')
  // Extract first version section
  const match = content.match(/^(## \d+\.\d+\.\d+[\s\S]*?)(?=\n## \d+\.\d+\.\d+|\n*$)/m)
  const latest = match ? match[1] : content.slice(0, 2000)
  return { ok: true, result: `Latest Release Notes\n\n${latest.slice(0, 3000)}` }
}

/**
 * The same disk scan the Skills page runs, printed.
 *
 * It used to read the `skills` table plus `~/.claude/commands`, neither of which is where
 * skills live, so every skill in `~/.claude/skills` went unlisted. Both listings share one scanner now so they can never disagree.
 */
function nativeSkills(): CommandResponse {
  const projects = db.prepare(
    "SELECT path, COALESCE(NULLIF(display_name, ''), name) AS name FROM folders WHERE path IS NOT NULL"
  ).all() as ProjectRoot[]
  const { skills } = scanSkills(projects)

  if (!skills.length) return { ok: true, result: 'Available Skills\n\n  None found on disk.' }

  const groups: Array<[string, typeof skills]> = []
  for (const s of skills) {
    const label = s.source === 'personal' ? 'Personal (~/.claude/skills)'
      : s.source === 'plugin' ? `Plugin: ${s.scope}`
      : s.source === 'command' ? `Commands: ${s.scope}`
      : `Project: ${s.scope}`
    const found = groups.find(g => g[0] === label)
    if (found) found[1].push(s)
    else groups.push([label, [s]])
  }

  let result = `Available Skills (${skills.length})\n`
  for (const [label, items] of groups) {
    result += `\n  ${label}:\n`
    for (const s of items) {
      const desc = s.description ? ` ${s.description.slice(0, 100)}${s.description.length > 100 ? '…' : ''}` : ''
      result += `    ${s.invocation.padEnd(28)}${desc}\n`
    }
  }
  result += '\n  Built-in CLI skills (/code-review, /dataviz, …) are compiled into the claude\n'
  result += '  binary and cannot be listed from disk.\n'
  return { ok: true, result }
}

function nativeAddDir(ctx: CommandContext): CommandResponse {
  const dir = ctx.args.trim()
  if (!dir) return { ok: false, result: 'Usage: /add-dir <path>' }
  const resolved = path.resolve(ctx.cwd, dir)
  if (!fs.existsSync(resolved)) {
    return { ok: false, result: `Directory not found: ${resolved}` }
  }
  return { ok: true, result: `Directory noted: ${resolved}\nIt will be added via --add-dir on the next message.`, action: 'add-dir', value: resolved }
}

// /hooks, /config, /permissions and /allowed-tools. They used to read only
// ~/.claude/settings.json, so /permissions said "Allow: none" while the chat ran with
// OrcStrator's own rules, and hook commands with inline tokens were printed into the chat.
// Now each view shows both layers the CLI merges for THIS chat: the settings file OrcStrator
// passes with --settings, and the user's own file. Everything shown is redacted.

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown> } catch { return null }
}

/** The two settings layers for a chat: OrcStrator's managed file (written at every spawn) and the user's. */
function settingsLayers(ctx: CommandContext): { managed: Record<string, unknown> | null; user: Record<string, unknown> | null } {
  let managed: Record<string, unknown> | null = null
  try {
    // The same call the spawn makes, so this is what the next turn will run with.
    const args = cliSettingsArgs(ctx.instanceId)
    const file = args[0] === '--settings' ? args[1] : null
    if (file) managed = readJson(file)
  } catch { /* no managed layer */ }
  return { managed, user: readJson(path.join(os.homedir(), '.claude', 'settings.json')) }
}

/** Text safe to print into a chat: known key formats removed, then any long token-shaped run. */
export function redactForChat(text: string): string {
  return redactSecrets(text).redacted
    .replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{24,})(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}/g, '[hidden]')
}

function show(value: unknown): string {
  return redactForChat(JSON.stringify(value, null, 2))
}

function nativeHooks(ctx: CommandContext): CommandResponse {
  const { managed, user } = settingsLayers(ctx)
  const parts: string[] = []
  if (managed?.hooks && Object.keys(managed.hooks as object).length) parts.push('Set by OrcStrator for this chat\n' + show(managed.hooks))
  if (user?.hooks && Object.keys(user.hooks as object).length) parts.push('From ~/.claude/settings.json\n' + show(user.hooks))
  if (!parts.length) return { ok: true, result: 'No hooks configured for this chat.' }
  return { ok: true, result: 'Configured Hooks\n\n' + parts.join('\n\n') }
}

function nativeConfig(ctx: CommandContext): CommandResponse {
  const { managed, user } = settingsLayers(ctx)
  const strip = (o: Record<string, unknown> | null) => {
    if (!o) return null
    const safe = { ...o }
    delete safe.env
    return safe
  }
  const parts: string[] = []
  if (managed) parts.push('Set by OrcStrator for this chat\n' + show(strip(managed)))
  if (user) parts.push('From ~/.claude/settings.json (environment values not shown)\n' + show(strip(user)))
  if (!parts.length) return { ok: true, result: 'No settings found. Using defaults.' }
  return { ok: true, result: 'Claude Code Settings\n\n' + parts.join('\n\n') }
}

type Perms = { allow?: string[]; deny?: string[]; ask?: string[]; defaultMode?: string }

function mergedPermissions(ctx: CommandContext): Required<Omit<Perms, 'defaultMode'>> & { mode: string } {
  const { managed, user } = settingsLayers(ctx)
  const m = (managed?.permissions ?? {}) as Perms
  const u = (user?.permissions ?? {}) as Perms
  const uniq = (a?: string[], b?: string[]) => Array.from(new Set([...(a ?? []), ...(b ?? [])]))
  let mode = 'default'
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'globalFlags'").get() as { value: string } | undefined
    const flags = row ? (JSON.parse(row.value) as string[]) : []
    if (flags.includes('--dangerously-skip-permissions')) mode = 'bypassPermissions'
    const pm = flags.find(f => f.startsWith('--permission-mode='))
    if (pm) mode = pm.split('=')[1]
  } catch { /* default */ }
  return { allow: uniq(m.allow, u.allow), deny: uniq(m.deny, u.deny), ask: uniq(m.ask, u.ask), mode }
}

function nativePermissions(ctx: CommandContext): CommandResponse {
  const p = mergedPermissions(ctx)
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none')
  return {
    ok: true,
    result: redactForChat('Permission Rules (OrcStrator\'s rules for this chat plus ~/.claude/settings.json)\n\n' +
      `  App default mode: ${p.mode} (a chat or card can pick its own)\n` +
      `  Allow: ${list(p.allow)}\n` +
      `  Deny:  ${list(p.deny)}\n` +
      `  Ask:   ${list(p.ask)}`),
  }
}

function nativeAllowedTools(ctx: CommandContext): CommandResponse {
  const { allow } = mergedPermissions(ctx)
  return {
    ok: true,
    result: allow.length ? redactForChat(`Allowed Tools\n\n  ${allow.join('\n  ')}`) : 'No explicitly allowed tools configured.',
  }
}

function nativeTasks(ctx: CommandContext): CommandResponse {
  // Find folder for this instance
  const inst = db.prepare('SELECT folder_id FROM instances WHERE id = ?').get(ctx.instanceId) as { folder_id: string } | undefined
  if (!inst) return { ok: false, result: 'Instance not found.' }

  // assigned_agent was dropped by migration 029 (orchestrator removal); selecting it
  // threw "no such column" on every invocation, so /tasks could never return anything.
  const tasks = db.prepare(`
    SELECT title, column, priority, labels
    FROM pipeline_tasks WHERE project_id = ?
    ORDER BY column, priority
  `).all(inst.folder_id) as Array<{ title: string; column: string; priority: number; labels: string }>

  if (!tasks.length) return { ok: true, result: 'No pipeline tasks for this project.' }

  let result = `Pipeline Tasks (${tasks.length})\n`
  let lastCol = ''
  for (const t of tasks) {
    if (t.column !== lastCol) {
      result += `\n  [${t.column.toUpperCase()}]\n`
      lastCol = t.column
    }
    result += `    P${t.priority} ${t.title}\n`
  }
  return { ok: true, result }
}

function nativeBashes(): CommandResponse {
  const procs = processRegistry.getProcessInfo()
  if (!procs.length) return { ok: true, result: 'No running processes.' }

  let result = `Running Processes (${procs.length})\n`
  for (const p of procs) {
    result += `  ${p.instanceId.slice(0, 8)}... - PID: ${p.pid}, state: ${p.state}, running ${p.runningSec}s\n`
  }
  return { ok: true, result }
}

function nativePlugin(): CommandResponse {
  const pluginPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json')
  try {
    const data = JSON.parse(fs.readFileSync(pluginPath, 'utf-8'))
    const plugins = data.plugins || {}
    const names = Object.keys(plugins)
    if (!names.length) return { ok: true, result: 'No plugins installed.' }
    let result = `Installed Plugins (${names.length})\n`
    for (const name of names) {
      result += `  ${name}\n`
    }
    return { ok: true, result }
  } catch {
    return { ok: true, result: 'No plugins installed.' }
  }
}
