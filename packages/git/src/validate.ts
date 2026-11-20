import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { GitError, stripUserInfo } from "./error.js";
import { execGit } from "./exec.js";

export async function validateBranchName(name: string, dir?: string): Promise<void> {
  if (!name || typeof name !== "string") {
    throw new GitError("Invalid branch name: branch name cannot be empty");
  }
  const cwd = dir && existsSync(dir) ? dir : tmpdir();
  try {
    await execGit(["check-ref-format", "--branch", name], { cwd });
  } catch (err) {
    const rawStderr = err instanceof GitError ? err.stderr : "";
    throw new GitError(`Invalid branch name '${stripUserInfo(name)}'`, {
      exitCode: err instanceof GitError ? err.exitCode : 128,
      stderr: rawStderr,
    });
  }
}

function hasControlCharacters(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

export async function validateRef(ref: string, dir?: string): Promise<void> {
  if (!ref || typeof ref !== "string") {
    throw new GitError("Invalid ref: ref cannot be empty");
  }
  if (ref.startsWith("-")) {
    throw new GitError(`Invalid ref '${stripUserInfo(ref)}': cannot start with '-'`);
  }
  if (/\s/.test(ref)) {
    throw new GitError(`Invalid ref '${stripUserInfo(ref)}': cannot contain whitespace`);
  }
  if (hasControlCharacters(ref)) {
    throw new GitError(`Invalid ref '${stripUserInfo(ref)}': cannot contain control characters`);
  }
  if (ref.includes("..")) {
    throw new GitError(`Invalid ref '${stripUserInfo(ref)}': cannot contain '..'`);
  }
  const isShaOrHead = ref === "HEAD" || /^[0-9a-fA-F]{40}$/.test(ref) || /^[0-9a-fA-F]{64}$/.test(ref);
  if (!isShaOrHead) {
    const cwd = dir && existsSync(dir) ? dir : tmpdir();
    try {
      await execGit(["check-ref-format", "--allow-onelevel", ref], { cwd });
    } catch (err) {
      const rawStderr = err instanceof GitError ? err.stderr : "";
      throw new GitError(`Invalid ref '${stripUserInfo(ref)}'`, {
        exitCode: err instanceof GitError ? err.exitCode : 128,
        stderr: rawStderr,
      });
    }
  }
}

export function validateCloneUrl(url: string): void {
  if (typeof url !== "string" || !url) {
    throw new GitError("Invalid clone URL: URL cannot be empty");
  }
  if (url.startsWith("-")) {
    throw new GitError("Invalid clone URL: cannot start with '-'");
  }
  if (/\s/.test(url)) {
    throw new GitError("Invalid clone URL: cannot contain whitespace");
  }
  if (url.startsWith("file://") || url.startsWith("file:")) {
    throw new GitError("Invalid clone URL: file:// protocol is not allowed");
  }
  if (url.startsWith("ext::") || url.startsWith("ext:")) {
    throw new GitError("Invalid clone URL: ext:: protocol is not allowed");
  }
  const isHttps = url.startsWith("https://");
  const isGitSsh = /^git@[a-zA-Z0-9_.-]+:[^:\s]+$/.test(url);
  if (!isHttps && !isGitSsh) {
    throw new GitError("Invalid clone URL: must be https:// or git@host:path");
  }
}
