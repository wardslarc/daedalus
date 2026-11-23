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

## M2 — Projects and profiles

Done when: Bilyo imports, the kit lands on `daedalus/kit`, profile rules are saved.
Imports from a URL clone to `~/work/<name>` for Work projects (WSL file system) and
`~/projects/<name>` for Client and Personal.

- [x] **T2.1 Kit template** `[claude]` — [[SPEC#Projects hub]]
  `kit/`: AGENTS.md, CLAUDE.md, docs/INTAKE.md, docs/SPEC.md, docs/PLAN.md, docs/decisions/,
  .editorconfig, .claudeignore — generic versions of this repo's own scaffold, with placeholders.
  check: `pnpm --filter @daedalus/kit test` (manifest lists every file; no file names a real project)
- [x] **T2.2 Profile rules** `[claude]` — [[SPEC#Profiles]]
  `packages/core/profiles.ts`: Work / Client / Personal rules (git host, Gemini allowed,
  skip-permissions forbidden on Work, learning mode on Personal) and server-side guards such as
  `assertProviderAllowed(project, provider)`. Not the task state machine (M5, owner).
  check: unit tests, including "a Work project can't be given to Gemini through the API"
- [x] **T2.3 Git basics** `[gemini]` — [[SPEC#Projects hub]]
  `packages/git`: init, current branch, create branch, commit given files, detect GitHub/GitLab
  from the remote, clone. Plain `git` via child_process with argument arrays, never a shell.
  check: `pnpm --filter @daedalus/git test` against temp repos
- [x] **T2.4 Import project** `[claude]` — [[SPEC#Projects hub]] [[SPEC#Profiles]]
  `POST /api/projects/import` (local folder or GitHub/GitLab URL): validate the path or URL,
  clone to the profile's folder if needed, add missing kit files on branch `daedalus/kit`
  (main untouched), save the project row with its profile. Wires `@daedalus/db` into the server.
  check: e2e imports a fixture repo; `git log main` unchanged; kit commit exists on `daedalus/kit`
- [x] **T2.5 New project from kit** `[gemini]` — [[SPEC#Projects hub]]
  `POST /api/projects/new`: new folder in the profile's folder, `git init`, copy kit, first
  commit, project row.
  check: e2e creates a project; the folder has the kit and one commit
- [x] **T2.6 Projects hub screen** `[gemini]` — [[SPEC#Projects hub]]
  Cards from the DB (name, profile, stage, running agents, items waiting), profile filter,
  search, Import and New dialogs, "Merge kit" button. Matches `docs/design/layout.md`.
  check: screenshot vs design with three fixture projects
- [x] **T2.7 Profile settings** `[gemini]` — [[SPEC#Profiles]]
  Per-project profile and overrides (e.g. Gemini allowed for one client) saved through the API,
  always validated by T2.2's rules on the server.
  check: e2e — a Work project's "Gemini allowed" can't be turned on, even by a direct POST
- [x] **T2.9 Merge kit** `[claude]` — [[SPEC#Projects hub]]
  `POST /api/projects/:id/merge-kit` and a "Merge kit" button on the card: merge `daedalus/kit`
  into the default branch only when asked. Refuses a checkout with uncommitted changes, merges
  through a temporary worktree when the branch isn't checked out, aborts on conflicts.
  check: e2e merges once then answers 409; real-git tests for clean, dirty, other-branch, conflict
- [ ] **T2.8 Bilyo import** `[you]`
  Import Bilyo for real and review its `daedalus/kit` branch.
  check: the M2 done-when above

## M3 — Workshop

Done when: you can chat with Claude and agy side by side on one project.

- [x] **T3.1 Provider registry** `[claude]` — [[SPEC#Providers]]
  `packages/providers`: `providers.json` schema (id, kind acp|cli, command, args, roles,
  allowed profiles, pinned version), load + validate at startup, seed the `providers` table.
  Unknown fields and unpinned versions are errors.
  check: `pnpm --filter @daedalus/providers test`
- [x] **T3.2 ACP session manager** `[claude]` — [[SPEC#Providers]] [[SPEC#Profiles]]
  Start an ACP agent in a project folder (profile guard first), stream session updates, send
  prompts, cancel, stop; one process per session, all killed on server exit. Permission
  requests are passed to the owner, never auto-approved. Grows out of the M0 ACP spike.
  check: integration tests against a fake ACP agent script; a Work project can't start agy
- [ ] **T3.3 WebSocket channel** `[claude]` — [[SPEC#Security]]
  `upgrade` handler on the custom server: Host allowlist, session cookie and Origin checked
  before any socket opens; one channel per session; typed messages.
  check: tests — no session, foreign Origin or foreign Host are all refused
- [ ] **T3.4 Workshop screen** `[gemini]` — [[SPEC#Workshop]]
  Start a session (project + provider), one console per session in xterm.js, an input to
  type into it, stop button, sessions side by side. Matches the Workshop board, exported to
  `docs/design/workshop.md`.
  check: e2e with the fake agent; screenshot vs design
- [ ] **T3.5 Permission prompts** `[gemini]` — [[SPEC#Workshop]]
  Show the agent's permission requests inline in its console with Allow once / Deny.
  check: e2e — a denied request reaches the agent as denied; nothing runs without a click
- [ ] **T3.6 Run logs with redaction** `[claude]` — [[SPEC#Security]]
  Every session's updates saved as JSONL in the data folder, with secret-like strings
  (tokens, keys, passwords in URLs) redacted before writing.
  check: unit tests with planted secrets; nothing secret-like on disk
- [ ] **T3.7 Free terminal** `[claude]` — [[SPEC#Security]] [[SPEC#Workshop]]
  The one free shell the spec allows: a node-pty shell in the project folder, typed into by
  the owner only, over the T3.3 channel.
  check: e2e types `pwd` and sees the project folder; the terminal is unreachable without a session
- [ ] **T3.8 Side by side** `[you]`
  Open one project, chat with Claude and agy at the same time, note what feels wrong.
  check: the M3 done-when above

## M4–M9 (outline)

- M4 Project chat — [[SPEC#Project chat]]
- M5 Pipeline and runner — task state machine `[you]` — [[SPEC#Pipeline]] [[SPEC#Task runner]]
- M6 Review center — [[SPEC#Review]]
- M7 Docs — wikilink parser `[you]`, prompt builder `[you]` — [[SPEC#Docs]]
- M8 Usage, inbox, providers screen — [[SPEC#Usage and quota]] [[SPEC#Inbox]]
- M9 Dogfood — [[SPEC#Verify]]
