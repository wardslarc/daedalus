# 0020 — Verify stage and automatic gate checks

- **Status:** accepted · 2026-11-24
- **Context:** T6.3 adds the Verify stage and the release gate's automatic security checks
  ([[SPEC#Release gate]], [[SPEC#Gate findings]], ADR 0012, 0015). Open points: when a release counts as in
  Verify, where the checks run, how a dependency audit can be trusted when agents can edit the repo, where
  saved security tests live before T6.9 creates any, and how a finding becomes a fix task when ADR 0018 says
  sync never adds tasks to a started milestone and the runner refuses a task without a frozen check.
- **Decision:**
  - **Verify is server state.** `shaping_state.active_milestone_verify_started_at` is set once, by the server,
    when the active milestone is frozen and every frozen task of it is `done` (checked after each Approve and
    on every release-gate read). It is never cleared while the milestone is active: fix tasks added during
    Verify go through Build and Review, and Verify stays on (T6.7 refuses "into current milestone" once it is
    set).
  - **Checks are owner-started runs.** A "Run checks" button starts one run per project at a time (409
    otherwise), returns 202 and runs in the background. A `gate_runs` row records the release branch head SHA,
    start/finish, and each check's result (`pass` / `fail` / `error` / `not-applicable`). The gate only counts
    the latest finished run for the current release head; a new commit on the release branch makes it stale.
    Running, server stop and startup recovery work like cross-reviews (ADR 0019): leftovers become `error`.
  - **Where they run.** Git reads (secret scan) run on the project repo with the hardened diff arguments of
    `buildReviewDiffArgs` and `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL=/dev/null`. Checks that need files run in
    a fresh detached worktree of the release head under `<dataDir>/worktrees/gate-…`, removed afterwards.
    Every external command is an argv array (no shell, except saved tests below), with the agent environment
    filter (ADR 0010), a timeout and its process group killed on timeout or shutdown; output is redacted.
  - **Secret scan:** added lines of `<default branch>...<release branch>` (release diff) and of every commit in
    `<default branch>..<release branch>` (history, so a secret added then removed is still found). One finding
    per (rule, file, sha256 of the matched value); the value itself is never stored or shown. Always blocking.
  - **Dependency audit:** chosen by lockfile at the repo root: `pnpm-lock.yaml` → `pnpm audit --json`,
    `package-lock.json` → `npm audit --json`; neither → `not-applicable`. Run with
    `--registry=https://registry.npmjs.org/` and `--ignore-scripts` where accepted, and `npm_config_*` /
    `COREPACK_*` variables removed, so a repo `.npmrc` can't point the audit at a server that reports nothing.
    A command that fails or prints unparseable output is `error`, which blocks like a failure (fails closed).
    high / critical → blocking; moderate / low → not blocking but needs an outcome.
  - **Saved security tests** are server state: a `security_tests` table (project, name, path, sha256, frozen
    command). T6.9 adds rows; T6.3 only runs them, in the gate worktree, with `/bin/sh -c` like frozen checks
    (ADR 0018). A missing file or a changed sha256 is a blocking finding (an agent can't delete or weaken a
    saved test). No rows → `not-applicable`.
  - **Ship checklist** items come from code, per profile (`packages/core`), not from the repo. Work gets the
    Kollab handoff list; the owner ticks each item; ticks are stored server-side and bound to the release
    version.
  - **Findings** live in `gate_findings` (project, release version, check, fingerprint, severity, title,
    redacted detail, location, blocking, state `open` / `resolved`, outcome, reason, fix task id, decided at).
    A rerun updates by fingerprint; a finding a rerun no longer reports becomes `resolved`. Outcomes:
    blocking findings → fix task only; others → fix task, or accept / defer with a written reason (trimmed,
    at least 10 characters). The change-request outcome is added by T6.7.
  - **Fix tasks** are created by the server in the active milestone, already frozen: code `FIX-<n>`
    (per project), tag `[claude]`, a description from the finding, and a check command the owner types in the
    fix dialog (required; the owner is trusted, agents never set it). A new nullable `tasks.description`
    column holds it; the task prompt uses it when PLAN.md has no such task. PLAN.md is not edited.
  - **Gate status** (automatic part): `not-ready` before Verify; `needs-run` with no finished run for the
    current head; `blocked` if any check errored or any blocking finding is open; `needs-decision` if a
    non-blocking finding has no outcome; `checklist` while ship-checklist items are unticked; else `pass`.
    UAT, visual diff and Accept (T6.4–T6.8) add their own parts later.
- **Consequences:** Agents can't skip, fake or weaken a check by editing the repo: commands, saved-test hashes,
  checklists, findings and outcomes are server state. Audits need network access to the public npm registry;
  offline, the check errors and the gate stays blocked until it can run. A secret in history keeps the gate
  blocked until the release branch history is rewritten (the owner's job, with key rotation).
