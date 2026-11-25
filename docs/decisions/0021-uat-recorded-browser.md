# 0021 — UAT checklist with a recorded browser

- **Status:** accepted · 2026-11-25
- **Context:** T6.4 adds manual UAT to the Verify stage ([[SPEC#Release gate]], [[SPEC#Gate findings]],
  ADR 0012, 0014, 0015, 0020). Open points: where the UAT items come from when `docs/PLAN.md` is
  agent-writable, how the project's app gets started for testing, where the recorded browser runs, what a
  mark is bound to, and what a "change" outcome becomes before T6.7 (change requests) exists.
- **Decision:**
  - **Items are frozen with the tasks.** Start milestone already checks `docs/PLAN.md` against
    `shaping_state.plan_approved_sha256` and freezes the tasks (ADR 0018); from now on it also copies the
    milestone's "Done when" items into `uat_items` (project, release, position, text, `source = "plan"`) in the
    same transaction. They are never re-read; later PLAN.md edits change nothing. A milestone started before
    this change has no rows: the server then reads the owner's checkout `docs/PLAN.md` once, only if its sha256
    still equals the approved hash, and otherwise UAT is blocked ("PLAN.md changed since you approved it").
    Spec `## Verify` items are listed beside the checklist; the owner may add any of them as an extra item
    (`source = "spec"`, text copied, 1–500 chars).
  - **The owner types how to start the app (owner's choice, 2026-11-25).** Per project: a start command
    (1–500 chars) and the app URL (`http://127.0.0.1:<port>` or `http://localhost:<port>`, never Daedalus's own
    port). Stored in SQLite, shown before every start, never read from repo files. The command runs with
    `/bin/sh -c` (like frozen checks, ADR 0018) in a fresh detached worktree of the release head under
    `<dataDir>/worktrees/uat-<project>-<session>`, with the agent environment filter (ADR 0010), its own process
    group, and a 2-minute wait for the URL to answer; it is killed on Stop, on server shutdown, and leftovers are
    cleaned at startup. The worktree has no `node_modules`: the command must install what it needs
    (e.g. `pnpm install --frozen-lockfile && pnpm dev --port 5173`).
  - **Recorded browser.** One UAT session per project at a time (409 otherwise). The server launches Playwright
    Chromium headed (WSLg in WSL), with a fresh profile (no owner cookies), video on, tracing with screenshots
    and snapshots, opened at the app URL. The owner drives it by hand; a "Screenshot" button saves the current
    page. On Stop, the trace, video and screenshots are saved under `<dataDir>/uat/<project>/<session>/` and
    listed on the Release gate; they are served only through an authenticated route that checks the path
    stays inside that folder. No model is used (ADR 0012). Playwright codegen and saved scripts are T6.5.
  - **Marks are owner decisions bound to a head.** Each item gets pass or fail with a note (fail: 1–2000
    chars, required), stored with the release head SHA and session id. A pass stays valid on later heads; a
    fail must be re-tested after its fix lands (Verify re-runs only failed items, [[SPEC#Gate findings]]).
  - **A fail is a bug or a change, chosen by the owner.** Bug → a frozen fix task in the milestone, created the
    same way as T6.3's `fix-task` outcome (the owner enters its check command; ADR 0018/0020). Change → a
    gate finding (`check = "uat"`, outcome `change-request`, the note as its detail) that blocks Ship until
    T6.7 turns it into a real change request (owner's choice, 2026-11-25). Nothing is dropped.
  - **Ship needs every UAT item passed** on the current release (with the other gate rules of ADR 0020).
- **Consequences:** UAT runs project code chosen by the owner, on the owner's machine, with a scrubbed env and
  no secrets; that command is the trust boundary, so it is shown before every run. The plan-hash check means an
  agent editing PLAN.md after approval can't change what gets tested. Recordings can be large; they stay in the
  data folder until the release ships (T6.8 decides retention). Headed Chromium needs a display (WSLg on
  Windows 11); without one, starting UAT fails with a clear message instead of falling back to headless.
