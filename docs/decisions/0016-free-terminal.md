# 0016 — The free terminal: the owner's shell, never logged, gone at logout, at most two

- **Status:** accepted · 2026-11-23
- **Context:** SPEC#Security allows exactly one free shell: "a Workshop terminal the user types
  into" (T3.7). Everything else the server runs is a task check or a provider launch command. A
  shell is the most powerful thing the server can expose, so who can reach it, what it can see and
  how long it lives must be explicit.
- **Decision:**
  - A real login shell (`$SHELL -l`, else `/bin/bash -l`) in a pseudo-terminal (node-pty), started
    in a project folder read from the database (never a path from the browser), realpath'd and
    checked to be a directory.
  - Reachable only through the authenticated channel: opened and closed over REST (session +
    CSRF), keystrokes and output over `/ws` (Host, Origin and session checked at the upgrade,
    ADR 0011). Input is capped at 64 KiB a message; sizes are 1–500 × 1–200.
  - **Owner's environment kept**, minus Daedalus's own `DAE_*` settings. Unlike agents (ADR 0010),
    secrets are not stripped: the owner is typing, as in any terminal they open themselves.
  - **Never logged.** Terminal output is not written to run logs (T3.6): it can show anything the
    owner looks at. A 256 KiB in-memory buffer lets a reconnecting tab catch up; it is gone when the
    terminal closes.
  - **Dies with the login.** Logout (or a new login) closes every terminal, as does shutdown. Close
    is SIGHUP to the shell's process group, then SIGKILL after 3 s, so nothing it started survives.
  - At most two terminals at once (409 for a third).
- **Consequences:** a stolen session cookie would give a shell, which is why the cookie is
  HttpOnly/SameSite=Strict, the server binds 127.0.0.1 only and the upgrade checks Origin and Host.
  Agents never get a terminal: they use their own tools under permission prompts. If the owner
  wants terminal history, that is a later, explicit feature, not a default.
