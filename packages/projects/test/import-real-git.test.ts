import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@daedalus/db";
import { KIT_FILES } from "@daedalus/kit";
import { describe, expect, it } from "vitest";
import { importProject, KIT_BRANCH, realGitOps } from "../src/index.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repo mid-work: on a feature branch, a staged change, an unstaged change, a failing pre-commit hook. */
function busyRepo(): { dir: string; mainSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "real-imp-"));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Owner");
  git(dir, "config", "user.email", "owner@example.com");
  writeFileSync(join(dir, "README.md"), "# app\n");
  writeFileSync(join(dir, "AGENTS.md"), "my own agent rules\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  const mainSha = git(dir, "rev-parse", "main");
  git(dir, "checkout", "-b", "feature");
  writeFileSync(join(dir, "staged.txt"), "staged\n");
  git(dir, "add", "staged.txt");
  writeFileSync(join(dir, "README.md"), "# app\nwork in progress\n");
  writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho hook ran >&2\nexit 1\n");
  chmodSync(join(dir, ".git", "hooks", "pre-commit"), 0o755);
  return { dir, mainSha };
}

describe("importProject with real git", () => {
  it("adds the kit on daedalus/kit and leaves the owner's checkout exactly as it was", async () => {
    const { dir, mainSha } = busyRepo();
    const statusBefore = git(dir, "status", "--porcelain");
    const db = openDb(":memory:");

    const res = await importProject(
      { source: dir, profile: "personal" },
      { db, git: realGitOps, home: mkdtempSync(join(tmpdir(), "home-")), forbiddenRoots: [], tmpRoot: tmpdir(), today: "2026-11-20" },
    );

    // Owner's world unchanged: branch, main, index, working tree, worktree list.
    expect(git(dir, "branch", "--show-current")).toBe("feature");
    expect(git(dir, "rev-parse", "main")).toBe(mainSha);
    expect(git(dir, "status", "--porcelain")).toBe(statusBefore);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("work in progress");
    expect(git(dir, "worktree", "list").split("\n")).toHaveLength(1);

    // The kit: one commit on daedalus/kit, parent = main, only the missing files.
    expect(res.kit.status).toBe("added");
    expect(git(dir, "rev-parse", `${KIT_BRANCH}^`)).toBe(mainSha);
    const files = git(dir, "show", "--name-only", "--format=", KIT_BRANCH).split("\n").sort();
    expect(files).toEqual(KIT_FILES.filter((f) => f !== "AGENTS.md").sort());
    expect(git(dir, "show", `${KIT_BRANCH}:AGENTS.md`)).toBe("my own agent rules");
    expect(git(dir, "show", `${KIT_BRANCH}:CLAUDE.md`)).toContain("@AGENTS.md");

    expect(res.project).toMatchObject({ localPath: dir, profile: "personal", defaultBranch: "main" });
  });

  it("a second import of the same folder is refused and doesn't touch the branch", async () => {
    const { dir } = busyRepo();
    const db = openDb(":memory:");
    const deps = { db, git: realGitOps, home: mkdtempSync(join(tmpdir(), "home-")), forbiddenRoots: [], tmpRoot: tmpdir(), today: "2026-11-20" };
    await importProject({ source: dir, profile: "personal" }, deps);
    const kitSha = git(dir, "rev-parse", KIT_BRANCH);
    await expect(importProject({ source: dir, profile: "personal" }, deps)).rejects.toMatchObject({ status: 409 });
    expect(git(dir, "rev-parse", KIT_BRANCH)).toBe(kitSha);
  });
});

describe("kit writes never follow symlinks from the imported repo", () => {
  it("skips kit paths that are, or pass through, a symlink — even a dangling one", async () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    const dir = mkdtempSync(join(tmpdir(), "sym-imp-"));
    git(dir, "init", "--initial-branch=main");
    git(dir, "config", "user.name", "Owner");
    git(dir, "config", "user.email", "owner@example.com");
    symlinkSync(outside, join(dir, "docs")); // docs/ -> a folder outside the repo
    symlinkSync(join(outside, "planted.md"), join(dir, "CLAUDE.md")); // dangling link
    writeFileSync(join(dir, "README.md"), "# app\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "init with symlinks");

    const res = await importProject(
      { source: dir, profile: "personal" },
      { db: openDb(":memory:"), git: realGitOps, home: mkdtempSync(join(tmpdir(), "home-")), forbiddenRoots: [], tmpRoot: tmpdir(), today: "2026-11-20" },
    );

    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(outside, "planted.md"))).toBe(false);
    expect(res.kit.status).toBe("added");
    const files = git(dir, "show", "--name-only", "--format=", KIT_BRANCH).split("\n");
    expect(files).not.toContain("CLAUDE.md");
    expect(files.some((f) => f.startsWith("docs/"))).toBe(false);
    expect(files).toContain("AGENTS.md");
    expect(res.warnings.join(" ")).toMatch(/symlink/i);
  });
});
