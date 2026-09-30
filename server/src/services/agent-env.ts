// ─────────────────────────────────────────────────────────────────────────────
// The environment every claude process starts from.
//
// It used to be `{ ...process.env }` minus CLAUDECODE, so whatever the terminal that started
// the server held went to every agent: a Claude Code session's own identity variables
// (entrypoint, SSE port, session ids), npm's per-script variables, and the server's own
// settings. Those are stripped here. What a user deliberately configures for the CLI
// (provider switches, the git-bash path, output caps, a client certificate) is kept.
//
// ANTHROPIC_API_KEY is NOT stripped: a user without a Claude plan runs the CLI on a key, and
// removing it would break every chat for them. It is announced once at boot instead, so a
// key left over in a terminal cannot quietly bill every chat (warnIfApiKeyInherited).
// ─────────────────────────────────────────────────────────────────────────────

const KEEP_CLAUDE_CODE = [
  /^CLAUDE_CODE_USE_/,          // provider switches (Bedrock, Vertex, Foundry)
  /^CLAUDE_CODE_SKIP_/,         // their auth skips
  /^CLAUDE_CODE_DISABLE_/,      // telemetry / traffic / feature opt-outs
  /^CLAUDE_CODE_GIT_BASH_PATH$/,
  /^CLAUDE_CODE_MAX_OUTPUT_TOKENS$/,
  /^CLAUDE_CODE_CLIENT_/,       // mTLS client cert and key
  /^CLAUDE_CODE_API_KEY_HELPER_TTL_MS$/,
]

/** True for a variable an agent must not inherit from the server's own environment. */
export function isStrippedVar(name: string): boolean {
  const upper = name.toUpperCase()
  if (upper === 'CLAUDECODE' || upper === 'CLAUDE_PID') return true
  if (upper.startsWith('CLAUDE_CODE_')) return !KEEP_CLAUDE_CODE.some(re => re.test(upper))
  if (upper.startsWith('NPM_')) return true
  // The server's own settings. The ones an agent needs are re-added by agentEnvFor.
  if (upper.startsWith('ORCSTRATOR_')) return true
  return false
}

/** A copy of the server's environment with the leaking variables removed. */
export function agentBaseEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || isStrippedVar(k)) continue
    env[k] = v
  }
  return env
}

let warned = false
/** Say it once, loudly, when every chat is about to bill an inherited API key. */
export function warnIfApiKeyInherited(source: NodeJS.ProcessEnv = process.env): boolean {
  if (!source.ANTHROPIC_API_KEY) return false
  if (!warned) {
    warned = true
    console.warn('[agent-env] ANTHROPIC_API_KEY is set in the environment that started this server. Every chat will be billed to that key instead of your Claude plan. Start the server from a terminal without it to use the plan.')
  }
  return true
}
