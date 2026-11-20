import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branchExists, commitFiles, createBranch, currentBranch, deleteBranch, GitError, init } from "../src/index.js";

async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "git-del-"));
  await init(dir);
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a");
  await commitFiles(dir, ["a.txt"], "first");
  return dir;
}

describe("deleteBranch", () => {
  it("deletes a branch that isn't checked out", async () => {
    const dir = await repo();
    await createBranch(dir, "daedalus/kit");
    await deleteBranch(dir, "daedalus/kit");
    expect(await branchExists(dir, "daedalus/kit")).toBe(false);
    expect(await currentBranch(dir)).toBe("main");
  });

  it("refuses the checked-out branch and invalid names", async () => {
    const dir = await repo();
    await expect(deleteBranch(dir, "main")).rejects.toThrow(GitError);
    await expect(deleteBranch(dir, "--force")).rejects.toThrow(GitError);
    expect(await branchExists(dir, "main")).toBe(true);
  });
});
