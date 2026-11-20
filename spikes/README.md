# M0 spikes

Throwaway scripts that prove the risky parts before building on them
(see `docs/PLAN.md`, M0). Not production code.

**Use a throwaway test folder** (e.g. `mkdir ../spike-test && echo "# test" > ../spike-test/README.md`).
Both spikes are read-only by design, but the agent can read everything in the folder.

| Script | Task | Command |
| --- | --- | --- |
| `acp-spike.ts` | T0.1 Claude over ACP | `pnpm spike:acp -- claude ../spike-test` |
| `acp-spike.ts` | T0.2 Antigravity over ACP | fill in `providers.json` → `pnpm spike:acp -- antigravity ../spike-test` |
| `pty-spike.ts` | T0.3 agy headless in a pty | `pnpm spike:pty -- ../spike-test` |

Logs land in `spikes/out/` (gitignored). For T0.4, search them for `usage_update`.

Requirements: Claude Code logged in (the ACP adapter uses its login), `agy` logged in
(run `agy` once interactively), Node 22+. `node-pty` needs a prebuilt binary or build
tools for your platform; on Windows install from a normal terminal, not WSL-mounted paths.
