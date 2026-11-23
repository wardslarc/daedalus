# 0002 — WSL for work

- **Status:** accepted · 2026-11-20
- **Context:** The work PC runs Windows. node-pty, git worktrees and file watching behave best on Linux.
- **Decision:** For work, Daedalus runs inside WSL. Repos and worktrees live in the WSL file system (`~/work/...`), not `/mnt/c`. The UI is used from a Windows browser at `localhost` (WSL localhost forwarding). Node, pnpm, git, glab, Claude Code and agy are installed and logged in inside WSL; work git identity is set there.
- **Open:** personal projects — WSL as well, or Windows directly. Antigravity IDE support for WSL folders (check in T0.5).
- **Consequences:** One Linux environment for the runner.

## T0.5 notes · 2026-11-23

Environment: WSL2 (kernel 6.6.87.2-microsoft-standard-WSL2), Node 24.14.1, pnpm 12.21.0, agy 1.5.14.

| Check | Result |
| --- | --- |
| Clone a repo to `~/work` | ✓ `~/work/wsl-check` (clone of the Daedalus repo), ext4, not `/mnt/c` |
| `pnpm spike:acp -- claude ~/work/wsl-check` | ✓ reply, exit 0 (claude-agent-acp 0.109.0) |
| `pnpm spike:acp -- antigravity ~/work/wsl-check` | ✓ reply, exit 0 (Antigravity ACP server 1.5.14) |
| `pnpm spike:pty -- ~/work/wsl-check` | ✓ agy answered in 22.8 s, exit 0, no hang |
| Create and remove a git worktree | ✓ `git worktree add ../wsl-check-wt -b …`, a file written, `git worktree remove --force`, branch deleted, list clean |
| Open a WSL folder from the Antigravity IDE | **Not checked: a GUI step for the owner** (open `\\wsl$\<distro>\home\ctescalo\work\wsl-check` or use the IDE's WSL remote; note yes/no here) |

Also confirmed:
- Daedalus development already lives in the WSL file system (`/home/ctescalo/var/www/html/daedalus`,
  ext4), not in a Windows folder; the earlier note to move it is done.
- The whole Daedalus suite (typecheck, 268 unit tests, 28 e2e tests in Chromium, node-pty terminals,
  ACP agents) runs in this WSL setup.
- agy updates itself: 1.5.8 (pinned in providers.json) → 1.5.13 (2026-11-20) → 1.5.14 (2026-11-23).
  With the version pin from ADR 0003, Daedalus refuses agy sessions until the pin is updated on
  purpose. Decide: update the pin when agy updates, or turn agy's auto-update off.
