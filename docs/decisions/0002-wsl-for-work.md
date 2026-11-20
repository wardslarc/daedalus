# 0002 — WSL for work

- **Status:** accepted · 2026-11-20
- **Context:** The work PC runs Windows. node-pty, git worktrees and file watching behave best on Linux.
- **Decision:** For work, Daedalus runs inside WSL. Repos and worktrees live in the WSL file system (`~/work/...`), not `/mnt/c`. The UI is used from a Windows browser at `localhost` (WSL localhost forwarding). Node, pnpm, git, glab, Claude Code and agy are installed and logged in inside WSL; work git identity is set there.
- **Open:** personal projects — WSL as well, or Windows directly. Antigravity IDE support for WSL folders (check in T0.5).
- **Consequences:** One Linux environment for the runner. Daedalus development itself currently lives in a Windows folder; move it into WSL once T0.5 passes.
