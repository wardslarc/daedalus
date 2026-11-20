import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { GitError, stripUserInfo } from "./error.js";
import { CLONE_TIMEOUT_MS, execGit } from "./exec.js";
import { validateBranchName, validateCloneUrl } from "./validate.js";

/** Internal clone function bypassing URL format validation for tests/local bare repos. */
export async function cloneUnchecked(
  url: string,
  dest: string,
  options?: { branch?: string },
): Promise<void> {
  if (!dest || !isAbsolute(dest)) {
    throw new GitError(`Destination '${stripUserInfo(dest ?? "")}' must be an absolute path`);
  }
  const resolvedDest = resolve(dest);
  if (existsSync(resolvedDest)) {
    throw new GitError(`Destination '${stripUserInfo(resolvedDest)}' already exists`);
  }
  if (options?.branch) {
    await validateBranchName(options.branch);
  }

  const parent = dirname(resolvedDest);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }

  const args = ["clone"];
  if (options?.branch) {
    args.push("--branch", options.branch);
  }
  args.push("--", url, resolvedDest);

  await execGit(args, {
    cwd: parent,
    timeoutMs: CLONE_TIMEOUT_MS,
  });
}

/** Clones a repository after strictly validating the clone URL and destination. */
export async function clone(
  url: string,
  dest: string,
  options?: { branch?: string },
): Promise<void> {
  validateCloneUrl(url);
  await cloneUnchecked(url, dest, options);
}
