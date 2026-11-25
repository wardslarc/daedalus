/** Status, worktree lookup and merging — used by "Merge kit" (T2.9). */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { GitError } from "./error.js";
import { execGit } from "./exec.js";
import { validateBranchName } from "./validate.js";

/** `git status --porcelain` lines (tracked changes and untracked files). */
export async function statusPorcelain(dir: string): Promise<string[]> {
  const { stdout } = await execGit(["status", "--porcelain"], { cwd: dir });
  return stdout.split("\n").filter((l) => l.trim() !== "");
}

/** Absolute path of the worktree that has `branch` checked out, or null. */
export async function worktreeForBranch(repoDir: string, branch: string): Promise<string | null> {
  await validateBranchName(branch, repoDir);
  const { stdout } = await execGit(["worktree", "list", "--porcelain"], { cwd: repoDir });
  let path: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

/** Check out an existing branch in a new worktree (no new branch). */
export async function addWorktreeForBranch(repoDir: string, worktreeDir: string, branch: string): Promise<void> {
  if (!worktreeDir || !isAbsolute(worktreeDir)) throw new GitError("Worktree directory must be an absolute path");
  const dir = resolve(worktreeDir);
  if (existsSync(dir)) throw new GitError("Worktree directory already exists");
  await validateBranchName(branch, repoDir);
  await execGit(["worktree", "add", "--", dir, branch], { cwd: repoDir });
}

export type MergeResult = { ok: true; sha: string } | { ok: false; conflicts: string[] };

async function runMerge(dir: string, target: string, message: string): Promise<MergeResult> {
  if (!message) throw new GitError("Merge message cannot be empty");
  try {
    await execGit(["merge", "--no-ff", "--no-verify", "--no-edit", "-m", message, "--end-of-options", target], { cwd: dir });
  } catch (err) {
    const { stdout } = await execGit(["diff", "--name-only", "--diff-filter=U"], { cwd: dir }).catch(() => ({ stdout: "" }));
    const conflicts = stdout.split("\n").filter(Boolean);
    if (conflicts.length > 0) {
      await execGit(["merge", "--abort"], { cwd: dir });
      return { ok: false, conflicts };
    }
    throw err;
  }
  const { stdout } = await execGit(["rev-parse", "HEAD"], { cwd: dir });
  return { ok: true, sha: stdout.trim() };
}

/**
 * Merge `branch` into the current branch of `dir` with a merge commit, skipping hooks.
 * Accepts branch names only.
 * On a conflict the merge is aborted, so the checkout is exactly as before.
 */
export async function mergeNoFf(dir: string, branch: string, message: string): Promise<MergeResult> {
  await validateBranchName(branch, dir);
  return runMerge(dir, branch, message);
}

/**
 * Merge `sha` into the current branch of `dir` with a merge commit, skipping hooks.
 * Accepts lowercase 40-character commit SHAs only.
 * On a conflict the merge is aborted, so the checkout is exactly as before.
 */
export async function mergeCommitNoFf(dir: string, sha: string, message: string): Promise<MergeResult> {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new GitError(`Invalid commit SHA '${sha}'`);
  }
  try {
    await execGit(["rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`], { cwd: dir });
  } catch {
    throw new GitError(`'${sha}' does not name a commit`);
  }
  return runMerge(dir, sha, message);
}
