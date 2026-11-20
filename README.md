# Daedalus 1.0

Local mission control for agentic development. Every project — work, client or
personal — runs through one workflow (intake → mock → spec → plan → build →
review → ship), with **Claude Code** and **Antigravity (Gemini)** as agents,
connected over the [Agent Client Protocol](https://agentclientprotocol.com).

> Status: **M1 — skeleton.** The server, login and workspace tooling run; the app shell is next.

## Docs

- [Intake](docs/INTAKE.md) — what Daedalus is for
- [Spec](docs/SPEC.md) — features and rules
- [Plan](docs/PLAN.md) — milestones and current tasks
- [Decisions](docs/decisions/) — ADRs

## Requirements

- Node 22+, pnpm (via `corepack enable`)
- Claude Code and Antigravity CLI (`agy`) installed and logged in
- For work: WSL, with repos inside the WSL file system

## Run it

```bash
corepack enable
pnpm install
pnpm dae set-password   # once: sets the one password (stored as an argon2id hash)
pnpm dae                # http://127.0.0.1:4317
```

Checks: `pnpm typecheck && pnpm test && pnpm lint` · end-to-end: `pnpm test:e2e`
(uses its own port and a throwaway data folder).

## M0 spikes

```bash
corepack enable
pnpm install
pnpm spike:acp -- claude ../some-test-folder
pnpm spike:pty -- ../some-test-folder
```

See [spikes/README.md](spikes/README.md).
