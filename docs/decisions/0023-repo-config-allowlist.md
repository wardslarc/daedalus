# 0023 — Repo config allowlist for Daedalus's git calls

- **Status:** accepted · 2026-11-25 (owner asked for the stronger design after ADR 0022's fourth amendment)
- **Context:** ADR 0022 stops Daedalus's git calls from running programs named in repo config by overriding each
  dangerous setting on the command line. Four automated reviews in one day each found one more setting or source
  (signature programs, submodule work trees, `submodule.<name>.ignore`, `.gitmodules` from the index, abbreviated
  flags). A blocklist must know every way git can run a program, and git keeps adding them. The repo config that
  agents can reach (the shared `.git/config` and worktree configs) is small in practice: the owner's repos use
  only `core.*` basics, `branch.<n>.remote/merge/vscode-merge-base`, `remote.<n>.url/fetch` and `user.*`.
- **Decision:**
  - **Allowlist, fail closed.** Before every git call except `init`, `clone` and `ls-remote` (no repo yet, or
    remote only), `execGit` reads the key names of the repo's *local* and *worktree* config
    (`git config --local -z --name-only --list`, and `--worktree` when `extensions.worktreeConfig` is on), with
    ADR 0022's base settings. If any key is not on the list below, the call throws a GitError naming the key:
    "Repo config has '<key>', which Daedalus doesn't allow (ADR 0023). Remove it with
    `git config --unset <key>`, or ask for it to be added." Nothing runs.
  - **The list** (section and variable compared case-insensitively; `<n>` is any subsection):
    `core.repositoryformatversion, core.filemode, core.bare, core.logallrefupdates, core.ignorecase,
    core.precomposeunicode, core.symlinks, core.autocrlf, core.eol, core.safecrlf, core.quotepath, core.abbrev,
    core.longpaths, extensions.worktreeconfig, extensions.objectformat, user.name, user.email,
    branch.<n>.remote, branch.<n>.merge, branch.<n>.rebase, branch.<n>.pushremote, branch.<n>.description,
    branch.<n>.vscode-merge-base, remote.<n>.url, remote.<n>.pushurl, remote.<n>.fetch, remote.<n>.tagopt,
    remote.<n>.prune, submodule.<n>.url, submodule.<n>.active, submodule.<n>.branch, init.defaultbranch,
    pull.rebase, pull.ff, push.default, push.autosetupremote, fetch.prune, merge.ff, merge.conflictstyle,
    diff.renames, diff.algorithm, diff.noprefix, diff.mnemonicprefix, status.showuntrackedfiles, color.<any>`.
    Notably absent: `include.*`/`includeIf.*` (pull in other files), `core.worktree`, `core.hooksPath`,
    `core.fsmonitor`, `core.sshCommand`, `core.pager`, `core.editor`, any `*.program`, `filter.*`,
    `merge.<n>.driver`, `diff.<n>.*`, `submodule.<n>.update` (can be `!command`), `submodule.<n>.ignore`,
    `remote.<n>.uploadpack/receivepack/vcs`, `credential.*`, `alias.*`, `gc.*`, `maintenance.*`.
  - **Scope.** Only local and worktree config is checked: those are the files agents can reach. Global and
    system config are the owner's. Submodule repos (`.git/modules/*`) are not checked because ADR 0022 already
    keeps Daedalus out of submodule work trees.
  - **Cache.** The result is cached per config file path by (inode, size, mtime, sha256 of the content); any change
    re-reads. A changed file between check and use is the same risk as today's overrides, which stay.
  - **ADR 0022's overrides stay** as defence in depth (and they cover global/system config).
  - **Adding a key** to the list needs an ADR amendment saying why it can't run a program.
- **Consequences:** an unknown or dangerous setting in a project's repo config stops Daedalus with a message that
  names it, instead of Daedalus guessing whether it is safe. Repos with unusual but harmless settings need a
  one-time `git config --unset` or an amendment. One extra `git config --list` runs per call when the cache misses.
