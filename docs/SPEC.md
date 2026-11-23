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
- Mock: an agent builds a clickable HTML mock; change requests in the same chat.
- Approval: user publishes the mock as a Claude artifact, stores the link, marks approved. Build is locked until then.
- Plan: Claude writes `docs/PLAN.md` tasks, each with a check, tag `[claude]` or `[gemini]`, and `[[SPEC#...]]` links.

## Pipeline
- Stages: Intake, Mock, Spec, Plan, Build, Review, Verify, Ship.
- Task cards come from PLAN.md. Statuses: queued, running, check-failed, in-review, done.
- Build and Review run per task: each task is reviewed and merged on its own while others build. The project moves to Verify once every PLAN.md task is done.
- Ship is locked until every gate in Verify passes ([[SPEC#Release gate]]).

## Task runner
- At most 2 tasks at once.
- One git worktree per task, outside the repo folder, branch `daedalus/<task>`.
- Fresh agent session per task.
- The server runs the task's check itself. Pass → commit. Fail → one retry, then an inbox item.

## Workshop
- Live terminal per running task (xterm.js); the user can type into it.
- Free sessions on any project with Claude or Antigravity.

## Review
- Cross-review: the provider that did not write the change reviews it, read-only and sandboxed.
- Shows diff, check results, findings, and Claude's triage.
- Gates: checks pass, secret scan clean, dependency check, flag edited/deleted tests.
- Actions: approve and merge, send back with notes, discard.

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
- The Verify stage, once per release. Uses no AI model unless the owner starts the optional security review.
- UAT checklist: the project spec's `## Verify` items. Daedalus opens the app in a recorded Chromium window (screenshots, video, Playwright trace); the owner marks each item pass or fail with a note. A fail adds a task to PLAN.md and the project goes back to Build.
- Recorded scripts: when the owner accepts an item, the recording (Playwright codegen, no model) is saved as a UAT script. Every later release replays all saved scripts before the owner starts, so only new or changed items are tested by hand.
- Visual diff: each screen is compared with the approved mock's screenshots; the owner accepts or rejects every difference.
- Security, always on, no model: secret scan of the release diff and the branch history, dependency audit, and the profile's ship checklist (Work: Kollab handoff).
- Optional security review by a model over the whole release diff, started by the owner. Its findings are advice; they never pass or fail the gate on their own.
- The owner accepts the release; nothing ships without that click.

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
