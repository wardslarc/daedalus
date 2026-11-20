# 0009 — Import adds the kit on a branch, through a temporary worktree

- **Status:** accepted · 2026-11-20
- **Context:** Importing a project (T2.4) adds the Daedalus kit (AGENTS.md, docs/ …). The
  spec says the main branch stays untouched until the owner merges. Projects being imported
  are often mid-work: another branch checked out, uncommitted changes, git hooks (husky,
  lint-staged). Import is also the first place the browser hands the server a path or URL
  that the server then runs git with.
- **Decision:**
  - Only files the project doesn't already have are added (whether committed or not), as one
    commit on `daedalus/kit`, created from `main` (or `master`, else the current branch).
  - The commit is made in a temporary `git worktree` under the system temp folder, outside
    the repo, and the worktree is always removed. The owner's checkout, working tree, index
    and branches are never touched. The commit skips hooks (`--no-verify`): they belong to
    the project, not to Daedalus's own scaffolding commit.
  - An existing `daedalus/kit` branch is left alone. If the commit fails, the half-made
    branch is deleted.
  - Order: profile rules first (a refused request touches nothing), then input validation
    (full paths or https/git@ URLs only; symlinks resolved; system, home and Daedalus folders
    refused; Work repos must not be under `/mnt`), then clone, kit, and the database row. A
    fresh clone is deleted if a later step fails; a folder the owner pointed at never is.
  - Git runs only through `@daedalus/git` (argument arrays, no shell, refs validated).
- **Merging (T2.9):** only on an explicit "Merge kit" click. If the default branch is
  checked out and has staged or modified tracked files, Daedalus refuses and asks the owner to
  commit or stash; it never stashes, resets or forces. If the branch isn't checked out, the
  merge happens in a temporary worktree. Always `--no-ff --no-verify`; a conflict is aborted
  and reported with its paths, leaving both branches as they were. On success
  `daedalus/kit` is deleted.
- **Consequences:** Import never surprises the owner's working copy, but the kit only takes
  effect once `daedalus/kit` is merged ("Merge kit", T2.9). Re-importing after deleting the
  project row works; re-adding the kit after a merge needs the branch deleted first.
