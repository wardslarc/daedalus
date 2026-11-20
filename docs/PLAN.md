# Plan — Daedalus 1.0

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done.
Each task has a tag (`[claude]` / `[gemini]` / `[you]`), the spec sections it
implements, and a check. `[you]` = learning mode: the owner writes it.

## M0 — Spikes (current)

- [x] **T0.1 ACP client spike** `[claude]` — [[SPEC#Providers]]
  Start an agent over ACP in a folder, stream its updates, auto-answer
  permission requests, stop cleanly. Works with any ACP command.
  check: `pnpm spike:acp -- claude <test-folder>` prints the agent's reply and exits 0
- [x] **T0.2 Antigravity over ACP** `[you]` — [[SPEC#Providers]]
  Find the launch command for Antigravity's ACP agent on this PC (registry
  entry `antigravity-acp`, or an `agy` flag) and add it to `spikes/providers.json`.
  check: `pnpm spike:acp -- antigravity <test-folder>` prints a reply and exits 0
- [x] **T0.3 agy headless in node-pty** `[claude]` — [[SPEC#Providers]]
  check: `pnpm spike:pty -- <test-folder>` prints agy's answer and exits without hanging
- [ ] **T0.4 Usage readings** `[you]` — [[SPEC#Usage and quota]]
  Run both spikes and note whether `usage_update` events arrive and what they contain
  (saved to `spikes/out/*.jsonl`). Decide: read usage from ACP, estimate, or manual entry.
  Record the decision as ADR 0005.
  check: ADR 0005 exists
- [ ] **T0.5 WSL check** `[you]` — [[SPEC#Task runner]]
  In WSL: clone a repo to `~/work`, run both spikes there, create and remove a
  git worktree, open a WSL folder from the Antigravity IDE (note yes/no).
  check: notes added to ADR 0002

## M1 — Skeleton

- [x] **T1.1 Next.js app + custom server** `[claude]` — [[SPEC#Security]]
  `apps/web`: Next.js App Router, custom Node server bound to 127.0.0.1, `dae` bin.
  check: `pnpm dae` serves on http://127.0.0.1:4317; `curl` from another device fails
- [x] **T1.2 SQLite + migrations** `[gemini]` — [[SPEC#Projects hub]]
  `packages/db`: better-sqlite3 + Drizzle, tables from the build plan, first migration.
  check: `pnpm --filter @daedalus/db test`
- [x] **T1.3 Login** `[claude]` — [[SPEC#Security]]
  One password (argon2 hash), session cookie, CSRF on posts.
  check: e2e test: wrong password rejected, right password lands on Projects
- [x] **T1.4 App shell** `[gemini]` — [[SPEC#Projects hub]]
  Sidebar and empty screens matching the "Daedalus 1.0 Layout" design.
  check: screenshot vs design
- [x] **T1.5 Workspace tooling** `[gemini]`
  Vitest, Playwright, lint, root `pnpm typecheck` / `pnpm test`.
  check: `pnpm typecheck && pnpm test` green

## M2–M9 (outline)

- M2 Projects and profiles — import with auto-kit, profile rules — [[SPEC#Projects hub]] [[SPEC#Profiles]]
- M3 Workshop — ACP sessions in xterm.js — [[SPEC#Workshop]]
- M4 Project chat — [[SPEC#Project chat]]
- M5 Pipeline and runner — task state machine `[you]` — [[SPEC#Pipeline]] [[SPEC#Task runner]]
- M6 Review center — [[SPEC#Review]]
- M7 Docs — wikilink parser `[you]`, prompt builder `[you]` — [[SPEC#Docs]]
- M8 Usage, inbox, providers screen — [[SPEC#Usage and quota]] [[SPEC#Inbox]]
- M9 Dogfood — [[SPEC#Verify]]
