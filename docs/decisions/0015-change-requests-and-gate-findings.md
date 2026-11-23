# 0015 — Frozen scope with change requests; every gate finding gets an outcome

- **Status:** accepted · 2026-11-23
- **Context:** Plans get approved and people still ask for changes. With one milestone = one
  release (ADR 0014) and UAT that covers only that milestone, scope that moves mid-build would
  make Verify test something nobody planned. The owner wants to be strict. The release gate
  (ADR 0012, 0013) also needs a defined outcome for every UAT and security finding.
- **Decision:**
  - **Frozen scope.** When a milestone starts Build, its spec sections, mock and tasks are tagged
    `baseline/<version>` and frozen. Agents can't edit SPEC.md during Build.
  - **Bug vs change.** Not matching the approved spec or mock = bug = fix task in the milestone.
    Different from what was approved = change request, however small.
  - **Change requests** (all profiles): captured as `docs/changes/CR-<n>.md`; Claude writes the
    impact; the owner decides next milestone (default), reject (with reason), or into the current
    milestone (override, refused once Verify started, restarts the affected work and Verify).
    Accepted CRs update SPEC.md through an approved diff, re-approve the mock if the UI changed,
    and add CR-tagged tasks. Client CRs record who approved and when. A release can't ship with
    an open CR aimed at it.
  - **Gate findings** each end as a fix task in the same milestone, a CR, or a decision recorded
    with a reason (SPEC#Gate findings). Secrets, failing saved scripts, high/critical dependency
    issues and confirmed high/critical security findings always block Ship. A confirmed security
    finding's proof is saved as a failing test before its fix, then runs on every release.
  - Fix tasks go through the normal Build and Review into the same release branch; Verify then
    re-runs the automatic checks, the failed UAT items and the saved proofs, with no model.
- **Consequences:** the current release is never changed by a late request unless the owner
  overrides on purpose; every change and every finding leaves a written trail (also a billing
  record for clients). Planning has to cut milestones small enough that "next milestone" is a
  short wait. The flows are drawn on the layout canvas (Flow: change requests, Flow: Verify findings).
