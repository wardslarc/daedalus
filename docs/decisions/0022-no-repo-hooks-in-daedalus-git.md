# 0022 — Daedalus's own git calls never run programs named in repo config

- **Status:** accepted · 2026-11-25
- **Context:** Every git call Daedalus makes (worktree add for tasks, reviews, gate runs and UAT; merges at
  Approve and Merge kit; kit and task commits; status) goes through `execGit` with the server's environment.
  `--no-verify` on commits and merges skips only pre-commit / commit-msg / pre-merge-commit hooks: git still
  runs `post-checkout` (worktree add), `post-merge`, `post-commit`, `reference-transaction`, and a
  `core.fsmonitor` program from repo config on `status`. Agents with write access work in worktrees that share
  the project's `.git` directory, so they can plant a hook or set `core.fsmonitor` in `.git/config`; the next
  Daedalus git call would run it outside the agent sandbox, with the server's environment (ADR 0010 only
  filters the agents' own environment). T6.2 already snapshots the shared git dir for the read-only reviewer
  (ADR 0019); this closes the same door for every other git call.
- **Decision:**
  - `execGit` (packages/git) always prefixes `-c core.hooksPath=/dev/null -c core.fsmonitor=false
    -c commit.gpgSign=false -c tag.gpgSign=false`. Command-line config overrides repo, worktree, global and system
    config, so no hook, fsmonitor program or signing program is ever used. There is no opt-out: Daedalus never
    needs them.
  - Filter drivers (`filter.<name>.clean/smudge/process`, chosen by `.gitattributes`, defined in repo config) run
    on checkout, add and commit. For git subcommands that can run them (`worktree`, `checkout`, `merge`, `commit`,
    `add`, `reset`, `stash`, `rebase`, `cherry-pick`, `restore`, `switch`), `execGit` first lists the configured
    filter names (`git config --get-regexp ^filter\.` with the settings above) and adds, for each name,
    `-c filter.<name>.process= -c filter.<name>.clean=cat -c filter.<name>.smudge=cat -c filter.<name>.required=false`.
    Files are then written as stored, which is what a review should see anyway. A name that can't be passed
    safely as `-c` (anything outside `[A-Za-z0-9._-]`) makes the call fail closed.
  - The same settings go into every other place that runs git outside `execGit`, if any exists (found by
    searching for `"git"` spawns); otherwise none.
  - Projects that depend on hooks for their own workflow (husky, lint-staged) keep them in the owner's own
    terminal; Daedalus-made commits were already `--no-verify`.
- **Consequences:** a planted hook or fsmonitor in a project's `.git` can no longer run through Daedalus. Same for
  signing and filter programs. One extra `git config` call runs before checkout-type commands. Review diffs
  already ignore textconv and external diff drivers (ADR 0019 amendment). Remote helpers and `core.sshCommand`
  only matter for clone/push, which use URLs the owner typed.
