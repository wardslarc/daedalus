# Daedalus — agent guide

Local web app (Next.js + Node + TypeScript, SQLite) that runs development projects
through one workflow, with Claude Code and Antigravity as agents over ACP.
Runs only on 127.0.0.1. Work use runs inside WSL.

## Commands
- install: `pnpm install`
- typecheck all: `pnpm typecheck`
- e2e: `pnpm test:e2e` (builds the web app and tests the production server; `DAE_E2E_DEV=1`
  uses the dev server instead; `DAE_E2E_PORT=<port>` when another e2e run already uses 4318)
- M0 spikes: `pnpm spike:acp -- <provider> <folder>` · `pnpm spike:pty -- <folder>`

## Rules that differ from defaults
- TypeScript everywhere, ESM (`"type": "module"`), strict mode. No Rust, no Python.
- The repo's docs are the source of truth: work from @docs/PLAN.md, one task at a time.
- Spec sections are linked as `[[SPEC#Section]]`. Read only the sections your task links.
- Never store API keys or tokens. Providers use their own CLI logins.
- Never read, print or write `.env*` files.
- Bind servers to `127.0.0.1` only, never `0.0.0.0`.
- Learning mode: do NOT implement these yourself, the owner writes them —
  `packages/core` task state machine, `packages/docs` wikilink parser, the prompt builder.
  You may write tests and types for them when asked.

## Workflow
- Write a failing test before a fix; never edit a test only to make it pass.
- After each change set: `pnpm typecheck` (and tests once they exist). Show the output.
- Record real decisions as ADRs in `docs/decisions/` (context, decision, consequences).
- When compacting, keep: modified files, test commands, current task id.

## Gotchas
- `agy -p` can hang without a real terminal: run it inside node-pty.
- Repos for work live in the WSL file system (`~/work/...`), not `/mnt/c`.
