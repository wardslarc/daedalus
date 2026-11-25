# 0024 — Saved UAT scripts (Playwright codegen) and replay

- **Status:** accepted · 2026-11-25 (owner chose Playwright codegen in a separate recording step)
- **Context:** T6.5 ([[SPEC#Release gate]]): when the owner accepts a UAT item, its recording is saved as a
  script; every later release replays all saved scripts before the owner starts manual UAT, and a failing
  script blocks Ship and becomes a fix task. ADR 0021 (T6.4) gives a UAT session with the project's app running
  from the owner's start command and a recorded Chromium window (trace/video), but no script. Open points: how
  a script is recorded, where it is kept, how and when it runs, and what a failure becomes.
- **Decision:**
  - **Recording = Playwright codegen, owner-driven, per item.** While a UAT session is running, the owner
    clicks "Record script" on an item. The server starts Daedalus's own Playwright CLI:
    `codegen --target=playwright-test --output <file> <app URL>` (headed, WSLg; fresh profile), with the agent
    environment filter (ADR 0010), its own process group, `<file>` under
    `<dataDir>/uat/<project>/<session>/codegen/`. One codegen per session at a time (409 otherwise). When the owner
    closes the codegen window the process exits and the server reads the file (max 256 KiB, UTF-8, non-empty, must
    contain `@playwright/test` and at least one `test(`) and stores it as a **draft** script for that item and
    session. Codegen is killed on session Stop, server shutdown, and leftovers are cleaned at startup like T6.4.
    Recording again replaces the item's draft. No model is used (ADR 0012).
  - **Accepting saves it.** Marking an item **pass** turns that item's draft (if any) into an **active** script,
    in the same transaction as the mark. Pass without a draft is allowed (not every item can be scripted); the
    item then simply has no script. Drafts of a stopped session that were never accepted are deleted.
  - **Kept in Daedalus, not in the repo.** A script is Node code that Daedalus runs; the repo is agent-writable,
    so a script there could be rewritten to run anything or to always pass. Scripts live only in SQLite
    (`uat_scripts`: project, item text copy, release recorded in, recorded app origin, head SHA, script text,
    sha256, status draft/active/retired, retired reason, replaced-by), never read from repo files. There is no
    API or UI to edit script text: only record, accept, and replace. The Release page shows each script
    read-only (as text, never as HTML).
  - **Replay runs inside every UAT session, before manual UAT.** When a session's app answers, and before the
    headed browser opens, the server replays every **active** script recorded in an **earlier** release of the
    project (this release's items are tested by hand). Per run: a fresh folder
    `<dataDir>/uat/<project>/<session>/replay/`; each script written as `s<id>.spec.ts` after its sha256 is checked
    against the row (mismatch → run error); the recorded origin, where it appears right after a `'`, `"` or `` ` ``,
    replaced with the current app URL's origin; a Daedalus-written `playwright.config.mjs` (testDir `.`,
    workers 1, retries 0, 60 s per test, 10 min for the run, headless Chromium, trace retain-on-failure, JSON
    reporter to a file in that folder); `node_modules/@playwright/test` in the folder is a symlink to Daedalus's
    own installed package; run with Daedalus's `@playwright/test` CLI via `process.execPath`, env filtered
    (ADR 0010), own process group, killed on Stop/shutdown. Results (`uat_replay_runs`,
    `uat_replay_results`: pass/fail per script, redacted failure detail ≤2000 chars, trace path) are bound to the
    session and release head SHA. A run that can't produce a readable report is **error**, never pass.
  - **Manual marking waits for the replay.** In a session, marks are refused until that session's replay has
    finished (passed, failed or error; zero scripts = passed at once).
  - **A failing script blocks Ship and becomes a fix task or a recorded decision.** Each failed script (and a
    run error, as one finding) becomes a blocking gate finding (`check = "uat"`, title naming the script's item
    and release, the failure as detail). Blocking findings accept only `fix-task` (T6.3, owner enters the check
    command). If the app changed on purpose, the owner instead **replaces** the script: record it again for that
    script during a session; the new script must pass a replay of itself right away; the old one becomes
    `retired` with the owner's reason (1–500 chars), `replaced-by` pointing to the new one, and its finding is
    resolved with that reason. The owner may also **retire** a script with a reason and no replacement (same
    recorded decision). Nothing is dropped silently.
  - **Ship** additionally needs the latest replay on the current release head to have passed (or no active
    earlier-release scripts), with the gate rules of ADR 0020/0021.
- **Consequences:** releases build up a regression suite with no model and no hand testing of old items. Replay
  runs owner-recorded Node code on the owner's machine with a scrubbed env; the trust boundary is that only the
  owner's codegen session can create script text, checked by hash before each run. Scripts bind to the app URL's
  origin (rewritten if it changes) and to the page's roles/labels; a deliberate UI change means re-recording.
  Needs `@playwright/test` as a runtime dependency of `packages/projects`, and a display for recording (as T6.4).
