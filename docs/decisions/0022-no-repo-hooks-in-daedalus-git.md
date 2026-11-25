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
- **Amended 2026-11-25 (automated security review of the first implementation):** the driver list and the
  subcommand list were both too narrow.
  - Drivers: besides filters, `.gitattributes` selects `merge.<name>.driver` (run on merge, rebase,
    cherry-pick, stash, checkout -m) and `diff.<name>.command` / `diff.<name>.textconv` (run on diff, show, log -p,
    blame). One listing call, `git config -z --name-only --get-regexp '^(filter|merge|diff)\.'`, collects the
    names; each gets `filter.<n>.process= clean=cat smudge=cat required=false`, `merge.<n>.driver=false` (a custom
    merge always conflicts instead of running a program: fail closed) and `diff.<n>.textconv=cat`. An empty
    `diff.<n>.command=` is not used: git then tries to run an empty program and every diff fails (checked by
    hand). Instead, for `diff, log, show, blame, format-patch`, `execGit` inserts `--no-ext-diff --no-textconv`
    (blame: `--no-textconv` only) right after the subcommand, as review diffs already do. Globally also
    `-c core.editor=true -c sequence.editor=true`.
  - Subcommands: the listing and overrides apply to **every** call except object-only ones that never read
    the working tree or run drivers: `rev-parse, show-ref, check-ref-format, for-each-ref, cat-file, rev-list,
    merge-base, symbolic-ref, config, ls-remote, init, clone` (the last three run before or without a repo). An
    unknown or missing subcommand is treated as working-tree (overrides applied).
  - Not covered here, decided with T6.8 Ship: remote programs from repo config (`core.sshCommand`,
    `credential.helper`, `core.askPass`, `remote.*.uploadpack/receivepack`) — they only run on fetch/push, which
    Daedalus doesn't do before Ship.
- **Amended again 2026-11-25 (automated security review of the merged fix; each case reproduced by hand):**
  - Signatures: `log.showSignature=true` in repo config makes `log`/`show` run `gpg.program` (also from repo
    config) on any signed commit. Base args add `-c log.showSignature=false -c merge.verifySignatures=false
    -c gpg.program=false -c gpg.openpgp.program=false -c gpg.x509.program=false -c gpg.ssh.program=false`.
  - Submodules: `status`/`diff` in the superproject look inside submodule work trees, where the submodule's own
    config (not in our driver listing) can name a clean filter. Base args add `-c diff.ignoreSubmodules=dirty
    -c submodule.recurse=false -c status.submoduleSummary=false`. `dirty` (not `all`): git no longer looks inside
    submodule work trees, but a changed submodule commit still shows in diffs, so Review can't miss a bump.
- **Third amendment 2026-11-25 (automated review; reproduced by hand):** `submodule.<name>.ignore` — from repo
  config or from the committed, agent-editable `.gitmodules` — outranks `diff.ignoreSubmodules`, so
  `ignore = none` brought the submodule filter back. Two layers now:
  - `--ignore-submodules=dirty` is inserted right after the subcommand for `status, diff, log, show,
    format-patch, stash` (the command-line flag beats every config source; checked by hand).
  - Every submodule name found in repo config (`^submodule\.` keys, same listing call) and in the top-level
    `.gitmodules` of the work tree (read with `git config -z --name-only --file <toplevel>/.gitmodules`, only if
    the file exists) gets `-c submodule.<name>.ignore=dirty`. Names may contain `/`; anything outside
    `[A-Za-z0-9._/-]` fails closed. `commit` does not look inside submodule work trees (checked by hand).
- **Consequences:** a planted hook or fsmonitor in a project's `.git` can no longer run through Daedalus. Same for
  signing and filter programs. One extra `git config` call runs before checkout-type commands. Review diffs
  already ignore textconv and external diff drivers (ADR 0019 amendment). Remote helpers and `core.sshCommand`
  only matter for clone/push, which use URLs the owner typed.
