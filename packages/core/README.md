# @daedalus/core

Rules the server enforces. Today: profile rules (`src/profiles.ts`, ADR 0008).

The task state machine (M5) also lives here, and the owner writes it (learning mode,
see AGENTS.md). Agents may add tests and types for it, not the implementation.
