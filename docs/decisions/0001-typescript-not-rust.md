# 0001 — TypeScript, not Rust

- **Status:** accepted · 2026-11-20
- **Context:** Considered Rust for speed. Daedalus's slow part is waiting minutes on AI agents. The libraries it needs (ACP SDK, claude-agent-acp, node-pty, xterm.js, Next.js) are TypeScript-first. The owner's target stack is Next.js, Node and Docker, and he must be able to review every line.
- **Decision:** TypeScript end to end (Next.js UI, Node server, pnpm workspaces).
- **Consequences:** One language to debug. Rust stays an option for a Tauri wrapper or a profiled hot spot later.
