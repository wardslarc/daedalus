# Plan — Daedalus 1.0

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done.
Each task has a tag (`[claude]` / `[gemini]` / `[you]`), the spec sections it
implements, and a check. `[you]` = learning mode: the owner writes it.

## M0 — Spikes

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
- [x] **T0.4 Usage readings** `[you]` — [[SPEC#Usage and quota]]
  Run both spikes and note whether `usage_update` events arrive and what they contain
  (saved to `spikes/out/*.jsonl`). Decide: read usage from ACP, estimate, or manual entry.
  Record the decision as ADR 0005.
  check: ADR 0005 exists
- [x] **T0.5 WSL check** `[you]` — [[SPEC#Task runner]]
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
- [x] **T2.8 Bilyo import** `[you]`
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
- [x] **T3.3 WebSocket channel** `[claude]` — [[SPEC#Security]]
  `upgrade` handler on the custom server: Host allowlist, session cookie and Origin checked
  before any socket opens; one channel per session; typed messages.
  check: tests — no session, foreign Origin or foreign Host are all refused
  Contract: `apps/web/src/ws/protocol.ts` (REST to start/list/stop sessions, `/ws` for live
  events, prompts and permission answers).
- [x] **T3.9 App re-theme (Direction C)** `[gemini]` — runs before T3.4
  Apply `docs/design/layout.md` to the running app: new token values in `globals.css`, Plus Jakarta
  Sans instead of Inter, the 96px rail with three items (Projects, Workshop, Usage) and no profile
  switch, project tabs, project screens moved under `/projects/[id]/…` (chat, pipeline, review,
  release, changes) with their empty states, the hub's phase board and 8-step stage bars.
  check: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e`; shell e2e updated to the new
  navigation (the spec changed, so the old six-route test changes with it); screenshot vs the boards
- [x] **T3.4 Workshop screen** `[gemini]` — [[SPEC#Workshop]]
  Start a session (project + provider), one console per session in xterm.js, an input to
  type into it, stop button, sessions side by side. Matches the Workshop board, exported to
  `docs/design/workshop.md`.
  Build against `apps/web/src/ws/protocol.ts` only; never import server code into the page.
  check: e2e with the fake agent; screenshot vs design
- [x] **T3.5 Permission prompts** `[gemini]` — [[SPEC#Workshop]]
  Show the agent's permission requests inline in its console with Allow once / Deny.
  check: e2e — a denied request reaches the agent as denied; nothing runs without a click
- [x] **T3.6 Run logs with redaction** `[claude]` — [[SPEC#Security]]
  Every session's updates saved as JSONL in the data folder, with secret-like strings
  (tokens, keys, passwords in URLs) redacted before writing.
  check: unit tests with planted secrets; nothing secret-like on disk
  Open question: how long run logs are kept (no rotation yet; `<data>/runs/<day>/`).
- [x] **T3.7 Free terminal** `[claude]` — [[SPEC#Security]] [[SPEC#Workshop]]
  The one free shell the spec allows: a node-pty shell in the project folder, typed into by
  the owner only, over the T3.3 channel.
  check: e2e types `pwd` and sees the project folder; the terminal is unreachable without a session
- [x] **T3.8 Side by side** `[you]`
  Open one project, chat with Claude and agy at the same time, note what feels wrong.
  check: the M3 done-when above

## M4 — Project chat

Done when: a project can go from Intake → Spec → Mock (with recorded approval) → Plan → Start milestone on `/projects/[id]/chat`.

- [x] **T4.1 Shaping state and Intake form** `[gemini]` — [[SPEC#Project chat]]
  Read and write `docs/INTAKE.md` in the project folder safely (no symlinks). Replace the empty state on
  `/projects/[id]/chat` with the 4-step shaping stepper (**Intake**, **Spec**, **Mock**, **Plan**),
  showing which provider each AI step will use and allowing finished steps to be reopened read-only.
  Saving the Intake form writes `docs/INTAKE.md` and unlocks **Spec**.
  check: unit tests for safe doc read/write; e2e fills the Intake form, saves `docs/INTAKE.md` in the repo, and reopens it read-only
- [x] **T4.2 Spec interview** `[claude]` — [[SPEC#Project chat]]
  Guided Claude session on `/projects/[id]/chat` that interviews the owner from `docs/INTAKE.md`,
  updates `docs/SPEC.md` live in the project folder, and requires a `## Verify` section before the
  owner can click **Approve spec** to advance to **Mock**.
  check: unit + e2e tests with the fake agent writing `docs/SPEC.md` (with `## Verify`) and approving it
- [x] **T4.3 Clickable HTML mock and approval gate** `[gemini]` — [[SPEC#Project chat]] [[SPEC#Profiles]]
  Agent builds a clickable HTML mock (`docs/mock.html`) from `docs/SPEC.md`; provider choice respects
  profile rules (Work: Claude only; Client/Personal: Claude or Antigravity when allowed). Revisions in
  the same chat are free until approval. Approval form records the published Claude artifact link,
  who approved it, and when. Build stays locked until mock approval is recorded.
  check: unit + e2e tests — Work project only offers Claude; mock approval saves link, approver, and timestamp
- [x] **T4.4 Plan generation and Start milestone** `[claude]` — [[SPEC#Project chat]] [[SPEC#Pipeline]]
  Claude writes `docs/PLAN.md` grouped into milestones (one milestone = one release), each with
  "Done when" UAT items and tasks (`[claude]`, `[gemini]`, or `[you]`, `check:`, `[[SPEC#...]]`).
  Owner can ask for changes in chat before clicking **Approve plan** (saves `docs/PLAN.md`).
  **Start milestone** creates the release branch `daedalus/release-<version>` from the default branch
  and freezes that milestone's scope.
  check: unit + e2e tests — Approve plan saves `docs/PLAN.md`; Start milestone creates `daedalus/release-v1.0` in git

## M5 — Pipeline and runner

Done when: `docs/PLAN.md` tasks appear on `/projects/[id]/pipeline`, the task state machine drives status transitions, and the runner executes tasks in isolated git worktrees (`daedalus/<task>`) from the active release branch with server-run checks, one auto-retry, and inbox notification on failure.

- [x] **T5.1 PLAN.md parser, task sync, and Pipeline board** `[gemini]` — [[SPEC#Pipeline]]
  Parse `docs/PLAN.md` milestones ("Done when" items and tasks: code, title, tag `[claude]`/`[gemini]`/`[you]`,
  description, `check:`, and `[[SPEC#...]]` links) and sync them into the `tasks` table in SQLite.
  Replace the empty state on `/projects/[id]/pipeline` with the 5-column Pipeline board
  (**Queued**, **Running**, **Check failed**, **In review**, **Done**), milestone header, and task cards.
  check: unit tests for PLAN.md parsing and DB sync; e2e loads `/projects/[id]/pipeline` and renders synced task cards by status
- [ ] **T5.2 Task state machine** `[you]` — [[SPEC#Pipeline]] [[SPEC#Task runner]]
  Pure task state machine in `packages/core` (`queued`, `running`, `check-failed`, `in-review`, `done`,
  retry count, and inbox trigger on second check failure). Owner implements the state machine (learning mode);
  types and unit test suite may be scaffolded when requested.
  check: `pnpm --filter @daedalus/core test`
- [x] **T5.3 Worktree task runner and check executor** `[claude]` — [[SPEC#Task runner]] [[SPEC#Profiles]]
  Run at most 2 tasks at once, each in its own git worktree outside the repo folder on branch
  `daedalus/<task>` made from the current release branch `daedalus/release-<version>`, with a fresh
  agent session per task. Server runs the task's `check:` command itself: pass → commit and move to
  `in-review`; fail → one retry, then move to `check-failed` and create a `failed_check` inbox item.
  check: unit + e2e tests — passing task commits in worktree and moves to `in-review`; failing task retries once then lands in `check-failed` with an inbox item
  Decided in ADR 0018: the runner runs only checks frozen at Start milestone; `[x]` in PLAN.md never
  changes a task's status.

## M6 — Review, release gate and change requests

Done when: an in-review task can be cross-reviewed and approved into its release branch; a release with every
task merged goes through Verify (automatic security checks, UAT with recorded scripts, visual diff) with every
finding resolved; the owner's accept click ships it by profile; and change requests are captured and decided.
Status changes go through the T5.2 state machine; review and gate records are server state (ADR 0017, 0018).

- [x] **T6.1 Review center: diff, gates and decisions** `[gemini]` — [[SPEC#Review]]
  Replace the empty state on `/projects/[id]/review` with the queue of `in-review` tasks. Per task: diff of
  `daedalus/<task>` against its release branch, the frozen check's last result, and automatic gates with no
  model — secret scan of the diff (reuse the redaction patterns), dependency change flag (package/lock files
  touched), and edited or deleted test files flagged. Actions: **Approve** merges `--no-ff` into the release
  branch (never `main`) and removes the worktree; **Send back** with notes requeues the task and keeps the notes
  for its next run; **Discard** deletes the branch and worktree and requeues. Approve stays locked while a
  must-fix finding is open or a test edit isn't acknowledged.
  check: unit + e2e tests — approve merges into `daedalus/release-v1.0` and `main` is unchanged; a planted secret and a deleted test block Approve until handled; send back requeues with notes
- [x] **T6.2 Cross-review by the other provider** `[claude]` — [[SPEC#Review]] [[SPEC#Profiles]]
  The provider that didn't write the change reviews it in a fresh session on the task worktree, read-only:
  every write or exec permission request is denied by the server. Findings come back as a JSON block in the
  final message (severity, file, line, claim, proof), are stored in `reviews`, and Claude triages each into
  must-fix / should-fix / nit. Work projects review with a second Claude session. Findings show in the
  Review center.
  check: unit + e2e tests with the fake agent — reviewer provider is the opposite of the writer; a write request is denied; findings and triage are stored and shown; Work never starts Antigravity
- [ ] **T6.3 Verify stage and automatic security checks** `[gemini]` — [[SPEC#Release gate]] [[SPEC#Gate findings]]
  When every task of the active milestone is merged, the release moves to Verify. Replace the empty state on
  `/projects/[id]/release` with the gate checklist. Automatic checks, no model: secret scan of the release diff
  and branch history, dependency audit, saved security tests, the profile's ship checklist (Work: Kollab
  handoff). Every finding is stored in a `gate_findings` table and must end as a fix task (added to the same
  milestone, frozen), a change request, or an accept / defer with a written reason.
  check: unit + e2e tests — a planted secret in branch history blocks the gate and becomes a fix task; a moderate dependency finding can be deferred only with a reason
- [ ] **T6.4 UAT checklist with a recorded browser** `[gemini]` — [[SPEC#Release gate]] [[SPEC#Gate findings]]
  UAT lists only this milestone's "Done when" items (and spec `## Verify` items they cover). Daedalus opens the
  project's app in a recorded Chromium window (screenshots, video, Playwright trace) and the owner marks each item
  pass or fail with a note. Fail → bug (fix task) or change (change request), chosen by the owner.
  check: unit + e2e tests — a failed item adds a frozen fix task to the milestone; the trace and screenshots are saved under the data folder
- [ ] **T6.5 Saved UAT scripts and replay** `[gemini]` — [[SPEC#Release gate]]
  Accepting a UAT item saves its recording as a Playwright codegen script in the project. Every later release
  replays all saved scripts before manual UAT; a failing script blocks Ship and becomes a fix task.
  check: e2e — an accepted item's script is saved and replayed on the next release; a broken script blocks the gate
- [ ] **T6.6 Visual diff against the approved mock** `[gemini]` — [[SPEC#Release gate]]
  Each screen is compared with the approved mock's screenshots; the owner accepts (reference updated) or
  rejects (fix task) every difference.
  check: unit + e2e tests — a changed screen shows a difference; accept updates the reference; reject adds a fix task
- [ ] **T6.7 Change requests** `[gemini]` — [[SPEC#Change requests]]
  Capture a CR from Project chat or the inbox as `docs/changes/CR-<n>.md`; decisions and approvals are server
  state. Replace the empty state on `/projects/[id]/changes` with the CR log. Claude writes the impact (spec
  sections, tasks, mock screens, rough task count); the owner decides next milestone (default), reject with a
  reason, or into the current milestone (refused once Verify started). Client CRs record who approved and when.
  A release can't ship with an open CR aimed at it.
  check: unit + e2e tests — CR saved and listed; into-current refused during Verify; an open CR blocks Ship
- [ ] **T6.8 Accept and Ship** `[claude]` — [[SPEC#Pipeline]] [[SPEC#Release gate]] [[SPEC#Profiles]]
  Ship unlocks only when nothing blocking is open, every UAT item passed, and every accept / defer has a reason;
  the owner's **Accept release** click is required. Ship merges the release branch into `main`, tags it, and
  pushes or hands off by profile (Personal/Client: push to GitHub; Work: GitLab merge request + Kollab handoff
  checklist). Never force-pushes.
  check: unit + e2e tests with a local bare remote — Ship is refused with an open finding; after Accept, `main` has the merge and tag `v1.0` and the bare remote received them
- [ ] **T6.9 Security test by agents** `[claude]` — [[SPEC#Security test]]
  Owner-started, advisory only. Throwaway instance on 127.0.0.1 (random port, copied data) behind a Daedalus
  proxy that refuses every other host; planner + one worker per area with fixed non-destructive tools; proof
  required; the other provider replays; fixed findings saved as security tests. Budgets shown before start.
  Likely large: split into sub-tasks when it starts.
  check: unit + e2e tests — the proxy refuses a foreign host; a finding without proof is not stored; a fixed finding's proof runs in the gate with no model
- [ ] **T6.10 One release through the gate** `[you]`
  Take a small project from Start milestone through Review, Verify and Ship; note what feels wrong.
  check: the M6 done-when above

## M7–M9 (outline)

- M7 Docs — wikilink parser `[you]`, prompt builder `[you]` — [[SPEC#Docs]]
- M8 Usage, inbox, providers screen — [[SPEC#Usage and quota]] [[SPEC#Inbox]]
- M9 Dogfood, including one release through the gate — [[SPEC#Verify]] [[SPEC#Release gate]]
