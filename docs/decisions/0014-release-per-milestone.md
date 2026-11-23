# 0014 — One milestone = one release, on its own branch; main only at Ship

- **Status:** accepted · 2026-11-23
- **Context:** ADR 0012 added a Verify stage before Ship but left two things open: what a
  "release" is, and where reviewed tasks merge. Merging each task into `main` would put untested
  combinations on `main` before Verify, and a failed UAT would leave `main` broken. The owner
  also considered releases that bundle several milestones, and chose to ship and test one
  milestone at a time.
- **Decision:**
  - Levels: project → milestones → features (spec sections) → tasks (PLAN.md items with a check).
    **One milestone = one release** (`v1.0`, `v1.1`…).
  - When a milestone starts, Daedalus creates `daedalus/release-<version>` from `main`. Each task's
    worktree branch is made from it, and an approved task merges into it, never into `main`.
  - Verify runs on the release branch once every task of the milestone is merged. UAT covers only
    that milestone's "Done when" items; earlier milestones are covered by their saved UAT and
    security scripts, replayed with no model. A failure adds a fix task to the same milestone and
    the same branch; Verify runs again.
  - Ship, after the owner accepts: merge the release branch into `main`, tag it, then push or hand
    off by profile (Personal/Client: GitHub; Work: GitLab merge request + Kollab handoff). The next
    milestone branches from the new `main`.
- **Example (Bilyo):** M2 "Quotes" = release v1.1, tasks T5–T9 (quote tables, line-item editor,
  totals, PDF template, email). All five merge into `daedalus/release-1.1`; `main` still holds
  v1.0. UAT tests "a client receives a quote PDF with correct totals"; v1.0's saved login scripts
  replay. A failed discount case adds T10 to M2; after it merges, Verify passes, the owner
  accepts, and `release-1.1` merges into `main` as tag `v1.1`.
- **Consequences:** `main` only ever holds accepted releases; reviews stay per task and small;
  manual UAT stays short because it covers one milestone. A milestone must be worth shipping on
  its own, so plans should be cut into milestones that each deliver something usable. Only one
  release branch is open at a time in 1.0.
