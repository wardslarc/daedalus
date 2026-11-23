# Spec — Daedalus 1.0

Sections are linkable as `[[SPEC#<Heading>]]`.

## Profiles
- Work: GitLab, work git identity, Gemini off by company policy, deploy = Kollab handoff checklist, no skip-permissions mode.
- Client: GitHub, Gemini allowed per client, change-request log.
- Personal: GitHub, all providers, learning mode on.
- Profile rules are enforced on the server, not only in the UI.

## Projects hub
- Cards show name, profile, stage, running agents, items waiting.
- New project copies `kit/` into a new repo.
- Import (folder or GitHub/GitLab URL) adds missing kit files automatically on branch `daedalus/kit`; main is untouched until merged.

## Project chat
- Intake form saves `docs/INTAKE.md`.
- Spec interview: Claude asks questions; `docs/SPEC.md` fills in live; ends with a Verify section.
- Mock: an agent builds a clickable HTML mock from the spec; the provider is picked within the profile rules (Work: Claude only). Revisions in the same chat are free until approval.
- Approval: user publishes the mock as a Claude artifact, stores the link, and records who approved it and when. Build is locked until then; after approval, mock changes go through a change request.
- Plan: Claude writes `docs/PLAN.md` grouped into milestones (one milestone = one release), each with "Done when" items that become its UAT checklist; tasks each have a check, a tag `[claude]` or `[gemini]`, and `[[SPEC#...]]` links. The owner can ask Claude to change the plan before approving it.
- Approving the plan only saves it. "Start milestone" creates the release branch and freezes that milestone's scope.
- Every AI step shows which provider it will use; finished steps can be reopened read-only.

## Pipeline
- Stages: Intake, Spec, Mock, Plan, Build, Review, Verify, Ship (the mock is built from the spec).
- Task cards come from PLAN.md. Statuses: queued, running, check-failed, in-review, done.
- Levels: a project has milestones; one milestone = one release (`v1.0`, `v1.1`…); a milestone's features are spec sections; its tasks are PLAN.md items, each with a check.
- Each release has a branch `daedalus/release-<version>`, made from `main` when the milestone starts. `main` only ever holds shipped releases.
- Build and Review run per task: each task is reviewed and merged into the release branch on its own while others build. The release moves to Verify once every task of its milestone is merged.
- Ship is locked until every gate in Verify passes ([[SPEC#Release gate]]). Ship merges the release branch into `main`, tags it, and pushes or hands off by profile (Personal/Client: push to GitHub; Work: GitLab merge request + Kollab handoff checklist). The next milestone's release branch starts from the new `main`.

## Task runner
- At most 2 tasks at once.
- One git worktree per task, outside the repo folder, branch `daedalus/<task>` made from the current release branch.
- Fresh agent session per task.
- The server runs the task's check itself. Pass → commit. Fail → one retry, then an inbox item.

## Workshop
- Live terminal per running task (xterm.js); the user can type into it.
- Free sessions on any project with Claude or Antigravity.

## Review
- Cross-review: the provider that did not write the change reviews it, read-only and sandboxed.
- Shows diff, check results, findings, and Claude's triage.
- Gates: checks pass, secret scan clean, dependency check, flag edited/deleted tests.
- Actions: approve and merge into the release branch, send back with notes, discard. Approving never touches `main`.

## Providers
- Each AI is an entry in `providers.json`: id, kind (`acp` | `cli`), command, args, roles (`lead` | `coder` | `reviewer` | `reader`), allowed profiles, pinned version.
- 1.0 providers: Claude (`claude-agent-acp`) and Antigravity (`agy`).
- CLI fallback runs the command inside node-pty.

## Usage and quota
- Show Claude usage against a user-set weekly limit, and Antigravity's weekly quota.
- When Antigravity is used up, `[gemini]` tasks move to Claude.
- At the weekly Claude limit, the queue pauses.

## Inbox
- Items: review ready, approval needed, check failed, quota warning.
- Browser notifications.

## Docs
- Wikilinks `[[Doc#Heading]]` and backlinks panel.
- Graph: whole project and per task; warnings for spec sections with no task, tasks with no spec link, and tasks older than the docs they link.
- Embeds: a task prompt contains AGENTS.md, the task, and only the spec sections the task links.
- Quick switcher `Ctrl+K`, command palette `Ctrl+P`.

## Release gate
- The Verify stage, once per release, on the release branch with every task of its milestone merged. Uses no AI model unless the owner starts the optional security test.
- UAT checklist: only this milestone's "Done when" items (and any spec `## Verify` items it covers). Earlier milestones are not re-tested by hand: their saved scripts replay instead. Daedalus opens the app in a recorded Chromium window (screenshots, video, Playwright trace); the owner marks each item pass or fail with a note. A fail adds a fix task to the same milestone; it goes through Build and Review into the same release branch, then Verify runs again.
- Recorded scripts: when the owner accepts an item, the recording (Playwright codegen, no model) is saved as a UAT script. Every later release replays all saved scripts before the owner starts, so only new or changed items are tested by hand.
- Visual diff: each screen is compared with the approved mock's screenshots; the owner accepts or rejects every difference.
- Security, always on, no model: secret scan of the release diff and the branch history, dependency audit, and the profile's ship checklist (Work: Kollab handoff).
- Optional security test by agents, started by the owner ([[SPEC#Security test]]). Its findings are advice; they never pass or fail the gate on their own.
- Saved security tests (fixed findings, see below) run on every release, with no model, and must pass.
- The owner accepts the release; nothing ships without that click.
- Findings never disappear: each becomes a fix task in the same milestone, a change request, or a recorded decision ([[SPEC#Gate findings]]).

## Gate findings
- UAT item fails: doesn't match the approved spec or mock → bug → fix task. Works as specced but the owner wants it different → change request.
- Visual difference: intended → accept, the reference screenshot is updated; not intended → fix task.
- Secret found or a saved script fails: always blocks Ship → fix task. A found secret is removed from the release branch history and the owner rotates the key.
- Dependency issue: high or critical → fix task, blocks Ship; moderate or low → fix, or accept / defer with a written reason.
- Security test finding: confirmed high or critical → `[claude]` fix task whose proof is saved first as a failing security test; confirmed medium or low → fix, or accept / defer with a reason, listed in the release notes; plausible → dismiss with a reason, retest, or treat as confirmed.
- Every fix task goes through Build and Review into the same release branch. Verify then re-runs all automatic checks, the failed UAT items, and each fixed finding's saved proof (no model).
- Ship unlocks when nothing blocking is open, every UAT item passed, and every accept / defer carries a written reason.

## Change requests
- Once a milestone starts Build, its spec sections, mock and tasks are frozen (git tag `baseline/<version>`). Agents can't edit SPEC.md during Build; only an accepted change request changes scope. All profiles (Client projects also record the client's approval).
- Bug or change: something that doesn't match the approved spec or mock is a bug (fix task, no CR); anything different from what was approved is a change, however small.
- A CR is captured from Project chat or the inbox as `docs/changes/CR-<n>.md` (who asked, what, why, date) and shown in the CR log.
- Impact: Claude lists the spec sections, tasks (done, running, not started), mock screens and shipped work it touches, and a rough number of new tasks.
- Owner decides: next milestone (default; the current release is untouched), reject (reason kept), or into the current milestone (explicit override, refused once Verify has started; affected tasks go back to Build, the mock is re-approved if the UI changed, Verify restarts).
- Applying a CR: the spec interview updates only the affected sections (owner approves the diff), the mock is re-approved if needed, Plan adds or changes tasks tagged with the CR id. Release notes list the CRs each version includes; the docs graph flags tasks whose spec section changed after them.
- A release can't ship with an open CR aimed at it.

## Security test
- Tests only the project's own app: a throwaway instance Daedalus starts on 127.0.0.1 (random port, copy of the data). A Daedalus proxy refuses every other host; agents have no other network access and no free shell.
- A planner agent (Claude) reads the spec, routes, WebSocket contract and release diff, and writes a shared checklist of what to probe.
- Worker agents each own one area: auth and sessions; CSRF, Origin and WebSocket; injection and path traversal; secrets and data exposure; dependencies; profile-rule bypass. They use only Daedalus's fixed, non-destructive tools (HTTP through the proxy, Playwright, static scanners). Profile rules decide the providers (Work: Claude only).
- A finding counts only with proof: the request and response, or a test, that reproduces it.
- The provider that didn't find it replays the proof; unconfirmed findings are shown as "plausible".
- Once fixed, a finding's proof is saved in the project as a security test, so the gate re-runs it on every release without a model.
- Time and request budgets per run; the owner starts every run and sees usage before it starts.

## Learning mode
- Personal profile: before merge, the user writes a short explanation of the change.

## Security
- Bind 127.0.0.1 only; one hashed password; session cookie; CSRF on posts; WebSocket checks session and Origin.
- No stored keys; `.env*` never read or sent to agents.
- Server runs only task check commands and provider launch commands; the only free shell is a Workshop terminal the user types into.
- Redact secret-like strings in run logs.

## Verify
- A sample project goes from intake to merged task with no manual git.
- A planted bug and a planted secret are both caught before merge.
