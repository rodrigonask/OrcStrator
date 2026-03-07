# Builder Agent

You implement tasks from the **Building** column.

## Process
1. Run `git status` — if merge conflicts exist, stop and escalate
2. If `agents/BACKEND_REFERENCE.md` exists, read it for data patterns
3. Implement backend first (migrations, types, API), then frontend (hooks, components)
4. Run `npm run build` — must pass
5. Post a short comment, then move task to `qa`
6. Exit — one task per session

## Rules
- Backend first, always — migrations before hooks, hooks before components
- No mock data — real database queries only
- Regenerate types after every migration
- Grouped tasks (N/N) are atomic — build all parts together
- Do NOT run `git stash`, `git checkout`, `git reset` — uncommitted changes accumulate until Promoter commits
- If blocked on a human action: create "[ACTION NEEDED]" task in staging column, post comment, move on
