import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { GitError, stripUserInfo } from "./error.js";
import { execGit, execGitQuiet } from "./exec.js";
import { validateBranchName, validateRef } from "./validate.js";

export { GitError } from "./error.js";
export { clone } from "./clone.js";
export { validateBranchName, validateRef } from "./validate.js";

/** Checks if a directory is a git repository. */
export async function isRepo(dir: string): Promise<boolean> {
  try {
    if (!existsSync(dir)) return false;
    const gitDirExists = existsSync(join(dir, ".git"));
    if (gitDirExists) {
      const res = await execGitQuiet(["rev-parse", "--git-dir"], { cwd: dir });
      return res !== null;
    }
    const res = await execGitQuiet(["rev-parse", "--is-bare-repository"], { cwd: dir });
    return res !== null && res.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Initializes a new git repository in dir. */
export async function init(
  dir: string,
  options?: { initialBranch?: string },
): Promise<void> {
  const initialBranch = options?.initialBranch ?? "main";
  await validateBranchName(initialBranch, dir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  await execGit(["init", `--initial-branch=${initialBranch}`], { cwd: dir });
}

/** Returns the current branch name of the repository. */
export async function currentBranch(dir: string): Promise<string> {
  const { stdout } = await execGit(["branch", "--show-current"], { cwd: dir });
  return stdout.trim();
}

/** Checks whether a local branch exists in the repository. */
export async function branchExists(dir: string, name: string): Promise<boolean> {
  await validateBranchName(name, dir);
  try {
    await execGit(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd: dir });
    return true;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) {
      // In a freshly initialized repo with no commits yet, the unborn branch is currentBranch
      const current = await currentBranch(dir).catch(() => "");
      return current === name;
    }
    throw err;
  }
}

/** Creates a new branch without switching to it. */
export async function createBranch(
  dir: string,
  name: string,
  options?: { from?: string },
): Promise<void> {
  await validateBranchName(name, dir);
  const args = ["branch", "--end-of-options", name];
  if (options?.from) {
    await validateRef(options.from, dir);
    args.push(options.from);
  }
  await execGit(args, { cwd: dir });
}

/** Switches HEAD to the specified branch. */
export async function checkout(dir: string, name: string): Promise<void> {
  await validateBranchName(name, dir);
  await execGit(["checkout", name], { cwd: dir });
}

/** Stages all files except .env* files and commits them. Returns sha or null when nothing changed. */
export async function commitAll(
  dir: string,
  message: string,
  options?: { author?: string; noVerify?: boolean },
): Promise<string | null> {
  if (!message) {
    throw new GitError("Commit message cannot be empty");
  }

  // Stage all changes excluding any .env* files anywhere in the repo
  await execGit(["add", "-A", "--", ".", ":(exclude,glob)**/.env*"], { cwd: dir });

  // Check if anything was staged
  const diffRes = await execGitQuiet(["diff", "--cached", "--quiet"], { cwd: dir });
  // If exit code is 0 (diffRes is not null), there are no changes staged
  if (diffRes !== null) {
    return null;
  }

  const commitArgs = ["commit", "-m", message];
  if (options?.noVerify) {
    commitArgs.push("--no-verify");
  }
  if (options?.author) {
    commitArgs.push(`--author=${options.author}`);
  }
  await execGit(commitArgs, { cwd: dir });

  const { stdout } = await execGit(["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

/** Stages exactly the specified files and commits them. Returns the new commit sha. */
export async function commitFiles(
  dir: string,
  files: string[],
  message: string,
  options?: { author?: string; noVerify?: boolean },
): Promise<string> {
  if (!files || files.length === 0) {
    throw new GitError("No files specified to commit");
  }
  if (!message) {
    throw new GitError("Commit message cannot be empty");
  }

  // Stage only the listed files, passing '--' before paths
  await execGit(["add", "--", ...files], { cwd: dir });

  const commitArgs = ["commit", "-m", message];
  if (options?.noVerify) {
    commitArgs.push("--no-verify");
  }
  if (options?.author) {
    commitArgs.push(`--author=${options.author}`);
  }
  commitArgs.push("--", ...files);
  await execGit(commitArgs, { cwd: dir });

  const { stdout } = await execGit(["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

/** Returns the commit SHA of the specified ref (defaults to HEAD). */
export async function headSha(dir: string, ref = "HEAD"): Promise<string> {
  await validateRef(ref, dir);
  const { stdout } = await execGit(["rev-parse", "--verify", ref], { cwd: dir });
  return stdout.trim();
}

/** Adds a new worktree on a new branch from `from`. */
export async function addWorktree(
  repoDir: string,
  worktreeDir: string,
  options: { branch: string; from: string },
): Promise<void> {
  if (!worktreeDir || !isAbsolute(worktreeDir)) {
    throw new GitError(`Worktree directory '${stripUserInfo(worktreeDir ?? "")}' must be an absolute path`);
  }
  const resolvedWorktreeDir = resolve(worktreeDir);
  if (existsSync(resolvedWorktreeDir)) {
    throw new GitError(`Worktree directory '${stripUserInfo(resolvedWorktreeDir)}' already exists`);
  }
  await validateBranchName(options.branch, repoDir);
  await validateRef(options.from, repoDir);

  await execGit(
    ["worktree", "add", "-b", options.branch, "--", resolvedWorktreeDir, options.from],
    { cwd: repoDir },
  );
}

/** Removes a worktree and prunes worktree administrative files. */
export async function removeWorktree(repoDir: string, worktreeDir: string): Promise<void> {
  const resolved = resolve(worktreeDir);
  await execGit(["worktree", "remove", "--force", "--", resolved], { cwd: repoDir });
  await execGit(["worktree", "prune"], { cwd: repoDir });
}

/** Returns commit log entries (sha + subject). */
export async function log(
  dir: string,
  ref?: string,
  n?: number,
): Promise<Array<{ sha: string; subject: string }>> {
  const args = ["log", "--format=%H%x1f%s"];
  if (n !== undefined) {
    args.push("-n", String(n));
  }
  args.push("--end-of-options");
  if (ref) {
    await validateRef(ref, dir);
    args.push(ref);
  }
  try {
    const { stdout } = await execGit(args, { cwd: dir });
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    return trimmed
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const sep = line.indexOf("\x1f");
        if (sep === -1) {
          return { sha: line.trim(), subject: "" };
        }
        return {
          sha: line.slice(0, sep).trim(),
          subject: line.slice(sep + 1).trim(),
        };
      });
  } catch (err) {
    if (
      err instanceof GitError &&
      (err.stderr.includes("does not have any commits yet") ||
        err.stderr.includes("unknown revision") ||
        err.stderr.includes("fatal: your current branch"))
    ) {
      return [];
    }
    throw err;
  }
}

/** Returns the URL of the remote (default origin), with credentials stripped, or null when none. */
export async function remoteUrl(dir: string, name = "origin"): Promise<string | null> {
  try {
    const { stdout } = await execGit(["remote", "get-url", name], { cwd: dir });
    const trimmed = stdout.trim();
    return trimmed ? stripUserInfo(trimmed) : null;
  } catch (err) {
    if (err instanceof GitError) {
      return null;
    }
    throw err;
  }
}

/** Detects host provider from remote URL: "github" | "gitlab" | "other". */
export function detectHost(url: string): "github" | "gitlab" | "other" {
  if (!url || typeof url !== "string") return "other";

  let host = "";
  try {
    if (url.includes("://")) {
      const parsed = new URL(url);
      host = parsed.hostname.toLowerCase();
    } else {
      const match = /^(?:[^@]+@)?([^:/]+):/.exec(url);
      if (match?.[1]) {
        host = match[1].toLowerCase();
      }
    }
  } catch {
    return "other";
  }

  if (host === "github.com" || host.endsWith(".github.com")) {
    return "github";
  }

  const firstLabel = host.split(".")[0];
  if (host === "gitlab.com" || host.endsWith(".gitlab.com") || firstLabel === "gitlab") {
    return "gitlab";
  }

  return "other";
}

/** Deletes a local branch (even if unmerged). git refuses the checked-out branch. */
export async function deleteBranch(dir: string, name: string): Promise<void> {
  await validateBranchName(name, dir);
  await execGit(["branch", "-D", "--end-of-options", name], { cwd: dir });
}

export { addWorktreeForBranch, mergeNoFf, statusPorcelain, worktreeForBranch, type MergeResult } from "./merge.js";
