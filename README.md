# Daedalus 1.0

Local mission control for agentic development. Every project — work, client or
personal — runs through one workflow (intake → mock → spec → plan → build →
review → ship), with **Claude Code** and **Antigravity (Gemini)** as agents,
connected over the [Agent Client Protocol](https://agentclientprotocol.com).

> Status: **M0 — spikes.** Nothing to run as an app yet.

## Docs

- [Intake](docs/INTAKE.md) — what Daedalus is for
- [Spec](docs/SPEC.md) — features and rules
- [Plan](docs/PLAN.md) — milestones and current tasks
- [Decisions](docs/decisions/) — ADRs

## Requirements

- Node 22+, pnpm (via `corepack enable`)
- Claude Code and Antigravity CLI (`agy`) installed and logged in
- For work: WSL, with repos inside the WSL file system

## M0 spikes

```bash
corepack enable
pnpm install
pnpm spike:acp -- claude ../some-test-folder
pnpm spike:pty -- ../some-test-folder
```

See [spikes/README.md](spikes/README.md).
