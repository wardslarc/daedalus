# 0019 — Read-only cross-review

- **Status:** accepted · 2026-11-24
- **Context:** T6.2 has the provider that didn't write a task review it ([[SPEC#Review]]). The reviewer reads
  agent-written code, so its prompt can carry instructions planted by the writer, and the agents run their own
  tools: Daedalus only sees what they ask permission for (Daedalus offers no fs or terminal client capability, `packages/providers/src/session.ts`),
  and an agent's own mode may approve edits without asking. "Read-only" therefore can't rest on denying
  permission requests alone. PLAN.md says the review runs "on the task worktree"; a reviewer that can write
  there could change the code the owner is about to approve.
- **Decision:**
  - **Who reviews.** Writer = provider of the task's latest `implement` run. Reviewer = the other provider when
    the profile allows it (`assertProviderAllowed`), else a second Claude session. Work always reviews with
    Claude, whatever the run rows say. Triage is always a Claude session.
  - **Where.** Not the task worktree: a fresh detached worktree at the task branch head under
    `<dataDir>/worktrees/review-…`, removed afterwards (also on failure and on server shutdown).
  - **Permission policy.** `SessionManager.start` takes a per-session policy. `read-only` answers every request
    itself, never asking the owner: tool kinds `read` and `search` get an allow-once option only when every
    location they name resolves inside the review worktree; every other kind (including `think`, since the kind is
    a label the agent side chooses), and a missing kind, gets a reject option (or `cancelled` if the request offers none). Owner sessions
    keep today's "ask the owner" behaviour. Both answers are logged as events.
  - **Tamper check.** Before and after each session Daedalus records the task branch SHA and the review
    worktree's HEAD and `git status --porcelain --ignored --untracked-files=all`. Any difference marks the
    review `tampered`: findings are kept for reading, the cross-review gate is `blocked`, and the worktree is
    deleted.
  - **Output is data.** Findings come from the last ```json block of the final message, validated strictly
    (fields, enums, lengths, at most 50, relative paths inside the repo), redacted, and rendered as plain text.
    Invalid or missing output is a `failed` review, not an empty one.
  - **Gate.** A `cross-review` gate joins the T6.1 gates, computed from the latest review for the current task
    head SHA: none / failed / timed-out / untriaged → `needs-ack`; tampered → `blocked`; any `must-fix` →
    `needs-ack` (the owner may disagree with the triage, with a note); otherwise `pass`. A new commit makes
    earlier reviews stale.
  - **Started by the owner.** A "Run cross-review" button, one review per task at a time, using the normal
    session slots; it never starts by itself.
- **Amended 2026-11-24:** acknowledgements of every review gate are bound to the task head SHA *and* a hash of
    the gate's items at the time (for cross-review: the review id and its findings/triage), and are invalid when
    either is unknown or differs — a re-run review or new findings need a new acknowledgement.
- **Consequences:** A reviewer that ignores its sandbox can't change the approved code unnoticed, and the
  owner sees it was blocked. A prompt-injected reviewer can still under-report; the automatic gates (secrets,
  tests, dependencies, checks) don't depend on it, and T6.3's security checks add more. Reviews cost two
  sessions (review + triage) and use the slots, so they can't run while two other sessions are open.
