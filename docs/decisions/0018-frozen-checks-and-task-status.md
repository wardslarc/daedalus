# 0018 — Frozen checks and server-owned task status

- **Status:** accepted · 2026-11-24
- **Context:** T5.1 syncs `docs/PLAN.md` into the `tasks` table on every Pipeline load, copying each
  task's `check:` command, tag and `[x]` mark. Agents can write PLAN.md. Once the T5.3 runner executes
  `check:` commands, an agent could rewrite a check into any shell command and the server would run it
  ([[SPEC#Security]]: the server runs only task check commands), switch a `[claude]` task to `[gemini]`,
  or mark its own task done by ticking `[x]`. This is the same problem ADR 0017 fixed for gate records.
- **Decision:**
  - Start milestone freezes the milestone's tasks: their code, title, tag and `check:` command are copied
    into `tasks` once, with `frozen_at` set. After that, sync never changes `check_command` or `tag` of a
    frozen task, and never adds or removes tasks of a started milestone (new work goes through a change
    request, ADR 0015). Sync may still refresh titles and descriptions for display.
  - The runner reads the check command only from the frozen `tasks` row, never from PLAN.md.
  - Task status is server state. `[x]` / `[~]` marks in PLAN.md are ignored for status; only the runner,
    the task state machine (T5.2) and review actions change it.
  - The runner runs a check with `/bin/sh -c` in the task's worktree, with the agent environment filter
    (ADR 0010), a timeout, and its process group killed on timeout or shutdown; output is redacted before
    it is logged or shown.
- **Consequences:** Agents can't widen what the server executes or approve their own tasks by editing the
  repo. Fixing a wrong check after Start milestone needs a change request. Projects started before this
  ADR have no frozen tasks; they get frozen the next time a milestone starts.
