import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addWorktreeForBranch, GitError, mergeCommitNoFf, mergeNoFf, statusPorcelain, worktreeForBranch } from "../src/index.js";

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-merge-"));
  g(dir, "init", "--initial-branch=main");
  g(dir, "config", "user.name", "T");
  g(dir, "config", "user.email", "t@example.com");
  writeFileSync(join(dir, "a.txt"), "a\n");
  g(dir, "add", ".");
  g(dir, "commit", "-m", "init");
  return dir;
}

function kitBranch(dir: string, file = "KIT.md", content = "kit\n"): void {
  g(dir, "checkout", "-q", "-b", "kit");
  writeFileSync(join(dir, file), content);
  g(dir, "add", file);
  g(dir, "commit", "-q", "-m", "kit");
  g(dir, "checkout", "-q", "main");
}

describe("statusPorcelain", () => {
  it("lists tracked changes and untracked files", async () => {
    const dir = repo();
    expect(await statusPorcelain(dir)).toEqual([]);
    writeFileSync(join(dir, "a.txt"), "changed\n");
    writeFileSync(join(dir, "new.txt"), "n\n");
    expect((await statusPorcelain(dir)).sort()).toEqual([" M a.txt", "?? new.txt"]);
  });
});

describe("worktreeForBranch", () => {
  it("finds where a branch is checked out, or null", async () => {
    const dir = repo();
    kitBranch(dir);
    expect(await worktreeForBranch(dir, "main")).toBe(g(dir, "rev-parse", "--show-toplevel"));
    expect(await worktreeForBranch(dir, "kit")).toBeNull();
  });
});

describe("addWorktreeForBranch", () => {
  it("checks out an existing branch in a new worktree", async () => {
    const dir = repo();
    kitBranch(dir);
    const wt = join(mkdtempSync(join(tmpdir(), "wt-")), "wt");
    await addWorktreeForBranch(dir, wt, "kit");
    expect(g(wt, "branch", "--show-current")).toBe("kit");
    await expect(addWorktreeForBranch(dir, "relative/path", "kit")).rejects.toThrow(GitError);
    await expect(addWorktreeForBranch(dir, join(tmpdir(), "x-" + Date.now()), "--force")).rejects.toThrow(GitError);
  });
});

describe("mergeNoFf", () => {
  it("makes a merge commit (never fast-forward), skipping hooks", async () => {
    const dir = repo();
    kitBranch(dir);
    writeFileSync(join(dir, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const res = await mergeNoFf(dir, "kit", "Merge kit");
    expect(res.ok).toBe(true);
    expect(g(dir, "log", "-1", "--format=%s %p")).toMatch(/^Merge kit \w+ \w+$/);
    expect(g(dir, "show", "HEAD:KIT.md")).toBe("kit");
  });

  it("aborts on conflict, reports the paths and leaves the repo as it was", async () => {
    const dir = repo();
    kitBranch(dir, "a.txt", "from kit\n");
    writeFileSync(join(dir, "a.txt"), "from main\n");
    g(dir, "commit", "-qam", "main edit");
    const head = g(dir, "rev-parse", "HEAD");
    const res = await mergeNoFf(dir, "kit", "Merge kit");
    expect(res).toEqual({ ok: false, conflicts: ["a.txt"] });
    expect(g(dir, "rev-parse", "HEAD")).toBe(head);
    expect(g(dir, "status", "--porcelain")).toBe("");
  });

  it("rejects option-like branch names", async () => {
    await expect(mergeNoFf(repo(), "--strategy=ours", "m")).rejects.toThrow(GitError);
  });
});

describe("mergeCommitNoFf", () => {
  it("accepts a commit sha as merge target", async () => {
    const dir = repo();
    kitBranch(dir);
    const kitSha = g(dir, "rev-parse", "kit");
    const res = await mergeCommitNoFf(dir, kitSha, "Merge kit commit");
    expect(res.ok).toBe(true);
    expect(g(dir, "log", "-1", "--format=%s %p")).toContain("Merge kit commit");
    expect(g(dir, "show", "HEAD:KIT.md")).toBe("kit");
  });

  it("rejects a branch name", async () => {
    const dir = repo();
    kitBranch(dir);
    await expect(mergeCommitNoFf(dir, "kit", "m")).rejects.toThrow(GitError);
  });

  it("rejects HEAD", async () => {
    const dir = repo();
    await expect(mergeCommitNoFf(dir, "HEAD", "m")).rejects.toThrow(GitError);
  });

  it("rejects a short sha", async () => {
    const dir = repo();
    kitBranch(dir);
    const shortSha = g(dir, "rev-parse", "--short", "kit");
    await expect(mergeCommitNoFf(dir, shortSha, "m")).rejects.toThrow(GitError);
  });

  it("rejects a 40-hex that isn't a commit", async () => {
    const dir = repo();
    const fakeSha = "0".repeat(40);
    await expect(mergeCommitNoFf(dir, fakeSha, "m")).rejects.toThrow(GitError);
  });
});
