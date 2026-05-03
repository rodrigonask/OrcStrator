# OrcStrator Slash Command Baseline

> Tested on: 2026-04-16 | Claude Code v2.1.96+ | OrcStrator `feat/ui-polish-slash-cmds-askuser-fix`

## Summary

- **Total commands in allowlist:** 70
- **Working via OrcStrator:** 13 (skills processed by the agent)
- **Partially working:** 1
- **Broken ("Unknown skill: X"):** 56 (CLI-internal REPL commands)

## Root Cause

OrcStrator executes slash commands via:
```
claude --resume <sessionId> -p '/command'
```

The `-p` (print) flag sends text as a **prompt message** to the Claude agent. Slash commands fall into two categories:

1. **Skills** — Registered in Claude Code's skill system (e.g., `/simplify`, `/context`). The agent has a `Skill` tool and processes these from prompt text. **These work.**
2. **Built-in CLI commands** — Handled by the interactive REPL before reaching the agent (e.g., `/status`, `/model`, `/clear`). **These do NOT work via `-p` mode** and return "Unknown skill: X".

### Additional Bug: Direct Input Routing

Typing `/command` directly in the message textarea sends it via `sendMessage()` (the regular message API at `/instances/:id/send`) instead of `sendCommand()` (`/instances/:id/command`). This means even the skill-based commands don't work when typed directly — they get sent as regular prompts where Claude treats them as conversation text.

---

## Working Commands (13)

These are **skills** processed by the Claude agent's Skill tool. They work through the command API.

| Command | Result | Notes |
|---------|--------|-------|
| `/context` | **WORKS** | Full context window breakdown with token tables |
| `/compact` | **WORKS** | Compresses conversation context ("Done.") |
| `/simplify` | **WORKS** | Reviews changed code — needs git repo in cwd |
| `/security-review` | **WORKS** | Analyzes branch for vulnerabilities |
| `/review` | **WORKS** | Reviews PRs — needs git repo in cwd |
| `/batch` | **WORKS** | Shows usage prompt, accepts follow-up instruction |
| `/debug` | **WORKS** | Detailed debug log analysis |
| `/loop` | **WORKS** | Shows usage prompt for recurring tasks |
| `/claude-api` | **WORKS** | Skill loaded, prompts for API task |
| `/schedule` | **WORKS** | Schedules remote agents ("Done.") |
| `/init` | **WORKS** | Creates/updates CLAUDE.md in cwd |
| `/insights` | **WORKS** | Returns link to usage report HTML |
| `/extra-usage` | **WORKS** | Opens browser to usage management page |

## Partially Working (1)

| Command | Result | Notes |
|---------|--------|-------|
| `/cost` | **PARTIAL** | Returns generic "using subscription" text, not the detailed cost breakdown the CLI shows |

## Broken Commands (56) — "Unknown skill: X"

All of these are **built-in CLI REPL commands** that cannot be invoked via `claude -p`.

### Session Management (14)
| Command | CLI Purpose | Alternative for OrcStrator |
|---------|------------|---------------------------|
| `/clear` | Clear conversation | OrcStrator handles locally (ChatHeader already does this) |
| `/reset` | Reset conversation | Could implement as new session |
| `/new` | New conversation | Already handled by OrcStrator instance creation |
| `/branch` | Branch conversation | No alternative in `-p` mode |
| `/fork` | Fork conversation | No alternative in `-p` mode |
| `/resume` | Resume conversation | OrcStrator uses `--resume` flag already |
| `/continue` | Continue last session | OrcStrator uses `--resume` flag already |
| `/rewind` | Rewind to earlier state | No alternative in `-p` mode |
| `/checkpoint` | Save checkpoint | No alternative in `-p` mode |
| `/btw` | Side message (non-blocking) | No alternative in `-p` mode |
| `/rename` | Rename session | No alternative in `-p` mode |
| `/exit` | Exit CLI | OrcStrator handles via process kill |
| `/quit` | Alias for /exit | Same as above |
| `/compact` (when sent as msg) | N/A | Works via command API, not direct typing |

### Model & Effort (3)
| Command | CLI Purpose | Alternative for OrcStrator |
|---------|------------|---------------------------|
| `/model` | Change AI model | OrcStrator has model selector dropdown in MessageInput |
| `/fast` | Toggle fast mode | Could be added as UI toggle |
| `/effort` | Set effort level | OrcStrator has effort dropdown in MessageInput |

### Context & Cost (2)
| Command | CLI Purpose | Alternative for OrcStrator |
|---------|------------|---------------------------|
| `/usage` | Show plan usage & rate limits | Could query `claude --version` or API |
| `/stats` | Daily usage stats | No direct alternative |

### Diagnostics & Info (7)
| Command | CLI Purpose | Alternative for OrcStrator |
|---------|------------|---------------------------|
| `/status` | Show version, model, account | `claude --version` as subprocess |
| `/doctor` | Diagnose installation | `claude doctor` as subprocess |
| `/help` | Show available commands | Can be implemented as static content |
| `/feedback` | Send feedback | Open URL: github.com/anthropics/claude-code/issues |
| `/bug` | Report a bug | Open URL: github.com/anthropics/claude-code/issues |
| `/release-notes` | Show release notes | Could scrape/fetch from release page |
| `/stickers` | Fun sticker pack | Cosmetic — low priority |

### Project & Memory (3)
| Command | CLI Purpose | Alternative for OrcStrator |
|---------|------------|---------------------------|
| `/memory` | Edit CLAUDE.md files | Could open file in editor or use file API |
| `/diff` | Show uncommitted changes | Could run `git diff` as subprocess |
| `/add-dir` | Add directory to context | Use `--add-dir` flag on spawn |

### Planning & Tasks (4)
| Command | CLI Purpose | Alternative for OrcStrator |
|---------|------------|---------------------------|
| `/plan` | Enter plan mode | OrcStrator has plan mode checkbox |
| `/ultraplan` | Deep planning mode | Could prepend planning instructions to prompt |
| `/tasks` | Show task list | Could parse from session data |
| `/bashes` | Show running bash commands | Could track via process registry |

### Configuration & Setup (14)
| Command | CLI Purpose | Alternative for OrcStrator |
|---------|------------|---------------------------|
| `/config` | Edit configuration | `claude config` subprocess |
| `/settings` | Open settings | OrcStrator has Settings page |
| `/permissions` | Manage permissions | Use `--permission-mode` flag |
| `/allowed-tools` | Manage tool allowlist | Use `--allowedTools` flag |
| `/hooks` | Manage hooks | Could edit hooks config file |
| `/mcp` | Manage MCP servers | Could edit `.mcp.json` |
| `/skills` | List skills | Could parse from skill configs |
| `/plugin` | Manage plugins | Low priority |
| `/reload-plugins` | Reload plugins | Low priority |
| `/keybindings` | Custom keybindings | N/A for web UI |
| `/terminal-setup` | Terminal integration | N/A for web UI |
| `/theme` | Change theme | OrcStrator has own theming |
| `/color` | Change colors | OrcStrator has own theming |
| `/statusline` | Configure status line | N/A for web UI |

### Authentication & Account (6)
| Command | CLI Purpose | Alternative for OrcStrator |
|---------|------------|---------------------------|
| `/login` | Log in | `claude auth` subprocess |
| `/logout` | Log out | `claude auth` subprocess |
| `/upgrade` | Upgrade CLI | `claude update` subprocess |
| `/passes` | Manage passes | Open URL |
| `/setup-bedrock` | Configure AWS Bedrock | Config file edit |
| `/setup-vertex` | Configure Google Vertex | Config file edit |

### Integrations & Remote (14)
| Command | CLI Purpose | Alternative for OrcStrator |
|---------|------------|---------------------------|
| `/agents` | List agents | `claude agents` subprocess |
| `/ide` | IDE integration | N/A |
| `/chrome` | Chrome integration | N/A |
| `/desktop` | Desktop app | N/A |
| `/app` | App integration | N/A |
| `/install-github-app` | Install GitHub app | Open URL |
| `/install-slack-app` | Install Slack app | Open URL |
| `/autofix-pr` | Auto-fix PR | Could use `--from-pr` flag |
| `/remote-control` | Remote control mode | `--remote-control-session-name-prefix` flag |
| `/rc` | Alias for remote-control | Same |
| `/remote-env` | Remote environment | Config |
| `/web-setup` | Web setup | Open URL |
| `/teleport` / `/tp` | Teleport sessions | No alternative |
| `/voice` | Voice mode | N/A |
| `/mobile` / `/ios` / `/android` | Mobile apps | N/A |

### Other (3)
| Command | CLI Purpose | Alternative for OrcStrator |
|---------|------------|---------------------------|
| `/sandbox` | Sandbox mode | Use `--dangerously-skip-permissions` flag |
| `/privacy-settings` | Privacy settings | Open URL or config edit |
| `/copy` / `/export` | Copy/export conversation | Could read session JSONL |
| `/powerup` | Power-up features | Cosmetic |
| `/team-onboarding` | Team onboarding | Open URL or guide |
| `/proactive` | Proactive mode | No alternative |

---

## Recommendations

### Priority 1: Fix Direct Input Routing
Intercept slash commands typed directly in the message textarea and route them through `sendCommand()` instead of `sendMessage()`. This would make the 13 working skill-commands accessible from both the Command Menu AND direct typing.

### Priority 2: Implement High-Value Commands Natively
For the most-used broken commands, implement OrcStrator-native alternatives instead of trying to pass them through the CLI:

| Command | Implementation |
|---------|---------------|
| `/status` | Run `claude --version` + show instance metadata |
| `/doctor` | Run `claude doctor` as standalone subprocess |
| `/diff` | Run `git diff` in instance cwd |
| `/memory` | Read/edit CLAUDE.md files via file API |
| `/model` | Already have dropdown — just need `/model` as alias |
| `/fast` | Add toggle button in UI |
| `/effort` | Already have dropdown — just need `/effort` as alias |
| `/usage` | Track from token_usage table + cost estimates |
| `/stats` | Aggregate from token_usage table |
| `/help` | Show static command reference in OrcStrator |
| `/plan` | Already have plan mode checkbox |

### Priority 3: Expand Command Menu
Add all 13 working skill-commands to the Command Menu (currently only 14 are listed, some overlap). Missing from the menu:
- `/batch`, `/debug`, `/loop`, `/claude-api`, `/schedule`, `/init`, `/insights`, `/extra-usage`

### Priority 4: New Commands Not in Allowlist
Web research confirms these commands exist in Claude Code but are NOT in OrcStrator's allowlist:

**Verified new commands:**
- `/undo` — Revert most recent file change (REPL)
- `/vim` — Toggle Vim-style keybindings (REPL)
- `/advisor` — Configure secondary advisor model (REPL)
- `/from-pr [number/url]` — Resume session linked to a PR (REPL)
- `/name [name]` — Set session display name (REPL)
- `/auto` — Toggle auto-permission mode (REPL)
- `/worktree` — Start session in isolated git worktree (REPL)
- `/good-claude` — Easter egg / positive reinforcement (REPL)

**Note:** `/pr-comments` was **removed** in v2.1.91.

### Priority 5: Commands in Allowlist with No Public Documentation
These are in OrcStrator's allowlist but have no verifiable public documentation — may be plan-specific, internal, or deprecated:
- `/passes`, `/setup-bedrock`, `/setup-vertex`, `/team-onboarding`, `/powerup`, `/proactive`, `/tasks`, `/bashes`

---

## Command Discovery Method

Tested via: `curl -X POST localhost:3333/api/instances/<id>/command -d '{"command":"/X"}'`

This hits the OrcStrator server's command route which spawns:
```
claude --resume <sessionId> -p '/X'
```

"Unknown skill: X" = CLI REPL command, not a skill, cannot work in `-p` mode.
Any other response = Skill processed by agent, works through OrcStrator.
