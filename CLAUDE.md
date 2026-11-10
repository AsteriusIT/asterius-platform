# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
npm install
npm run dev                      # server :8080 (SQLite in ./data, config from ./config) + web :5173
npm test                         # server (vitest, SQLite) + web (vitest, jsdom)
TEST_DATABASE_URL=postgres://… npm test -w apps/server   # same suite on Postgres
# Postgres for the suite (~80 files migrate their own schema in parallel):
# docker run -d --shm-size=1g -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55432:5432 postgres:16 -c max_locks_per_transaction=1024 -c max_connections=500
npm run e2e -w apps/web          # Playwright, functional (own stack on :18080/:15173, see apps/web/e2e/README.md)
npm run e2e:visual -w apps/web   # screenshots vs baselines (light/dark); e2e:update regenerates them
npm run lint && npm run typecheck
npm run build && docker build -t asterius-platform .
helm lint deploy/helm/asterius-platform --set database.url=postgres://x --set auth.providers=local
```

## Architecture Overview

Internal developer portal: catalog (blueprints/entities), self-service actions with approvals, invokers
(webhook, GitHub/ADO/GitLab pipelines, Kubernetes Job, catalog), ingestion (pull sources + inbound webhooks,
JSONata mappings), outbound webhooks. Fastify API + workers (`PLATFORM_ROLE=api|worker|all`) on Postgres;
React + Mantine UI. See README.md, docs/ARCHITECTURE.md, docs/EXTENDING.md.

## Conventions & Patterns

- Configurable resources are validated by the zod schemas in `apps/server/src/schemas.ts`, shared by the API and `CONFIG_DIR` files. Resources from config are `managed` (read-only via API).
- Cross-replica work is claimed with conditional UPDATEs / leases, never in-memory state.
- SQL is written once with `?` placeholders for both SQLite and Postgres; timestamps are ISO strings from `now()`.
- New invoker/source types: implement the interface in `actions/types.ts` / `integrations/types.ts` and register it in the `index.ts` registry; add `info.example` (shown as a template in the admin UI).
- UI pages compose the shared components in `apps/web/src/components` (DataTable, SchemaForm, ResourceEditor…); no page-specific CSS.
