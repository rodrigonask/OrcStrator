## OrcStrator — Multi-Instance Claude Orchestration Platform

Desktop app that manages multiple Claude Code CLI instances with an RPG-themed UI and autonomous pipeline orchestration.

### Stack
- **Server:** Node.js + Fastify + better-sqlite3 + WebSocket (port 3333)
- **Client:** React 19 + Vite + TailwindCSS + Zustand (port 5173)
- **Shared:** TypeScript types and constants (workspace package)
- **Runtime:** Spawns `claude` CLI processes via `child_process.spawn`

### Project Layout
```
server/           # Fastify API + WebSocket + orchestrator + claude-process spawner
  src/services/   # Core: orchestrator.ts, claude-process.ts, stream-parser.ts
  src/routes/     # REST API routes
  src/db.ts       # SQLite schema + migrations (better-sqlite3)
  agents/         # Master agent prompts + MCP configs (loaded by orchestrator)
client/           # React SPA (Vite)
  src/            # Components, hooks, stores, pages
shared/           # Types, constants shared between server + client
```

### Dev Commands
```bash
npm run dev       # Start server (3333) + client (5173) concurrently
npm run build     # Build shared → client → server
npm run kill      # Kill ports 3333 + 5173
```

### Key Architecture
- **The Orc** (`server/src/services/orchestrator.ts`): Event-driven task assignment. Finds idle managed agents, locks pipeline tasks, builds minimal prompts, spawns CLI processes.
- **Claude Process** (`server/src/services/claude-process.ts`): Spawns `claude -p` with stream-json I/O. Handles stdout parsing, token tracking, session management.
- **Pipeline**: Tasks flow through columns: `backlog → scheduled → spec → build → qa → ship → done`
- **Master Prompts** (`server/agents/`): Role-specific agent instructions (~30 lines each). Loaded by orchestrator, NOT by Claude Code's subagent system.
- **MCP Configs** (`server/agents/mcp-*.json`): Per-role MCP scoping. Pipeline agents use `--strict-mcp-config` to avoid loading global MCP servers.
- **Token Monitoring**: `token_usage` table tracks prompt_chars, input_tokens, output_tokens per task.

### Database
SQLite at `~/.orcstrator/orcstrator.db`. Migrations in `server/src/db.ts` (sequential, numbered).
Key tables: `folders`, `instances`, `messages`, `pipeline_tasks`, `task_comments`, `agents`, `skills`, `token_usage`.

### Rules
- **No mock data** — real SQLite queries only
- Server TypeScript check: `cd server && npx tsc --noEmit`
- Client build check: `cd client && npx vite build`
- Pipeline agents are short-lived (one task per CLI process). Prompts must be minimal.
