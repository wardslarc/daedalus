# 0012 — Review per task, then a release gate (Verify) before Ship

- **Status:** accepted · 2026-11-23
- **Context:** The pipeline went Build → Review → Ship with review per task, but nothing checked
  a release as a whole: no user acceptance testing and no security pass over the combined
  changes. The owner wants UAT and security checks before ship, without spending Claude or
  Gemini usage on them. A local model was considered for UAT; on this machine (CPU only in
  WSL, 15 GB RAM) only small models fit, and they are unreliable at driving a browser and at
  judging screens.
- **Decision:**
  - Keep review per task (small diffs suit cross-review). Add a **Verify** stage between
    Review and Ship, entered once every PLAN.md task is done; Ship stays locked until it passes.
  - UAT uses no model: the owner works through the spec's `## Verify` items in a recorded
    Chromium window and marks each pass or fail. Accepted items are saved as Playwright codegen
    scripts and replayed on every later release. Screens are diffed against the approved
    mock's screenshots.
  - Security in the gate uses no model by default: secret scan (release diff and branch
    history), dependency audit, the profile's ship checklist. A model security review of the
    whole release diff is optional, owner-started, and advisory only.
  - The owner's acceptance click is the only way through the gate.
- **Consequences:** a release costs no usage unless the owner asks for the optional review. UAT
  takes the owner's time, shrinking as recorded scripts accumulate. Visual diffs need the
  approved mock's screenshots kept with the project. How the optional review is structured
  (which agents, how findings are triaged) is still open.
